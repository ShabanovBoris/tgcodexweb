import { ConversationError, type ConversationService } from "../../application/ConversationService";
import type { RequestResult, RequestService } from "../../application/RequestService";
import type { Conversation } from "../../domain/Conversation";
import type { Request } from "../../domain/Request";
import type { createLogger } from "../../logging/logger";
import { ProviderOperationError } from "../../ports/ChatProvider";
import type { ConversationRepository } from "../../ports/ConversationRepository";
import type { RequestQueueRepository } from "../../ports/RequestQueueRepository";
import type { RequestRepository } from "../../ports/RequestRepository";
import type { UpdateDedupRepository } from "../../ports/UpdateDedupRepository";
import { type TelegramApi, TelegramError, type TelegramUpdate } from "./TelegramApi";
import { parseTelegramCommand, telegramHelp } from "./TelegramCommands";
import { renderTelegram } from "./TelegramRenderer";

type Message = NonNullable<TelegramUpdate["message"]>;
type Destination = Readonly<{ chatId: string; replyTo?: string }>;
type Dependencies = Readonly<{
  api: TelegramApi;
  username: string;
  allowedUserIds: readonly string[];
  acceptsMessage: (message: Message) => boolean;
  destination: (request: Request) => Destination | null;
  conversations: ConversationService;
  mappings: ConversationRepository;
  requests: RequestService;
  requestRepository: RequestRepository;
  queueRepository: RequestQueueRepository;
  updates: UpdateDedupRepository;
  transportReady: () => boolean;
  providerLabel: string;
  now: () => string;
  newRequestId: () => string;
  log: ReturnType<typeof createLogger>;
}>;

export class TelegramBot {
  private readonly allowed: Set<string>;
  private ingress: Promise<void> = Promise.resolve();
  private readonly progressGates = new Map<string, Promise<void>>();
  private readonly progressDeliveries = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: Dependencies) {
    this.allowed = new Set(dependencies.allowedUserIds);
  }

  // Serial ingress preserves command/selection and accepted update order, without waiting for generation.
  handle(update: TelegramUpdate): Promise<void> {
    const operation = this.ingress.then(() => this.consume(update));
    this.ingress = operation.catch(() => {});
    return operation;
  }

  private async consume(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (
      !message?.from ||
      message.from.is_bot ||
      message.sender_chat !== undefined ||
      !this.allowed.has(String(message.from.id)) ||
      !this.dependencies.acceptsMessage(message) ||
      !message.message_id
    )
      return;
    const userId = String(message.from.id);
    const updateId = String(update.update_id);
    if (this.dependencies.updates.get(updateId)) return;
    const destination = { chatId: String(message.chat.id), replyTo: String(message.message_id) };
    const media = [
      message.document,
      message.photo,
      message.audio,
      message.video,
      message.voice,
      message.animation,
      message.sticker,
      message.video_note,
    ].some((value) => value !== undefined);
    const command = parseTelegramCommand(message.text ?? "", this.dependencies.username);
    if (command.kind === "ignored") return;
    if (media || !message.text || command.kind === "invalid") {
      this.markCommand(updateId);
      await this.notice(
        destination,
        media ? "ATTACHMENT_REJECTED: файлы появятся в R5." : "INVALID_COMMAND: /help",
      );
      return;
    }
    if (command.kind === "command") {
      // Mark before effects, including remote creation. Interrupted commands are never silently replayed.
      this.markCommand(updateId);
      this.dependencies.conversations.authorizeUser(userId);
      try {
        await this.command(userId, destination, command.name, command.args);
      } catch (error) {
        if (!(error instanceof ConversationError || error instanceof ProviderOperationError))
          throw error;
        await this.notice(destination, error.code);
      }
      return;
    }
    let selected: Conversation;
    try {
      selected = this.dependencies.conversations.current(userId);
    } catch (error) {
      if (!(error instanceof ConversationError)) throw error;
      this.markCommand(updateId);
      await this.notice(destination, "NO_ACTIVE_CHAT: /new [alias] или /use <alias>");
      return;
    }
    if (selected.status !== "ready") {
      this.markCommand(updateId);
      await this.notice(destination, "CHAT_NOT_READY");
      return;
    }
    const request: Request = {
      id: this.dependencies.newRequestId(),
      conversationId: selected.id,
      telegramUpdateId: updateId,
      telegramMessageId: String(message.message_id),
      state: "created",
      createdAt: this.dependencies.now(),
    };
    const gate = Promise.withResolvers<void>();
    this.progressGates.set(request.id, gate.promise);
    try {
      const result = this.dependencies.requests.accept(request, {
        text: message.text,
        attachments: [],
      });
      if (result.kind !== "accepted") {
        this.progressGates.delete(request.id);
        if (result.kind === "rejected") await this.notice(destination, result.code);
        return;
      }
      this.dependencies.log("info", {
        operation: "telegram.accepted",
        telegramUpdateId: updateId,
        telegramUserId: userId,
        conversationId: selected.id,
        requestId: request.id,
        requestState: "queued",
      });
      await this.notice(destination, `В очереди [${request.id}] · ${selected.alias}`);
    } catch (error) {
      this.progressGates.delete(request.id);
      throw error;
    } finally {
      gate.resolve();
    }
  }

  progress(request: Request): Promise<void> {
    const delivery = (async () => {
      await this.progressGates.get(request.id);
      const destination = this.resultDestination(request);
      if (destination) await this.notice(destination, `Генерация… [${request.id}]`);
    })();
    this.progressDeliveries.set(request.id, delivery);
    return delivery;
  }

  async result(result: RequestResult): Promise<void> {
    const request = result.request;
    try {
      await this.progressGates.get(request.id);
      try {
        await this.progressDeliveries.get(request.id);
      } catch {
        /* Final delivery remains independent of progress failure. */
      }
      const destination = this.resultDestination(request);
      if (!destination) throw new TelegramError("TELEGRAM_DELIVERY_FAILED");
      const text =
        result.message?.text ||
        (request.state === "completed"
          ? `Завершено: пустой ответ [${request.id}]`
          : `Запрос [${request.id}]: ${request.state}${result.errorCode ? ` · ${result.errorCode}` : ""}${request.state === "unknown" ? "\nИсход не подтверждён; автоматической повторной отправки нет." : ""}`);
      await this.send(destination, text, true);
      this.dependencies.log("info", {
        operation: "telegram.delivered",
        telegramUpdateId: request.telegramUpdateId,
        requestId: request.id,
        conversationId: request.conversationId,
        requestState: request.state,
      });
    } catch {
      this.dependencies.log("error", {
        operation: "telegram.delivery_failed",
        telegramUpdateId: request.telegramUpdateId,
        requestId: request.id,
        conversationId: request.conversationId,
        requestState: request.state,
        errorCode: "TELEGRAM_DELIVERY_FAILED",
      });
      throw new TelegramError("TELEGRAM_DELIVERY_FAILED");
    } finally {
      this.progressGates.delete(request.id);
      this.progressDeliveries.delete(request.id);
    }
  }

  private resultDestination(request: Request): Destination | null {
    const mapping = this.dependencies.mappings.get(request.conversationId);
    if (!mapping || !this.allowed.has(mapping.telegramUserId)) return null;
    return this.dependencies.destination(request);
  }

  private markCommand(telegramUpdateId: string): void {
    this.dependencies.updates.record({ telegramUpdateId, processedAt: this.dependencies.now() });
  }

  private async command(
    userId: string,
    destination: Destination,
    name: string,
    args: string[],
  ): Promise<void> {
    const service = this.dependencies.conversations;
    let response: string;
    switch (name) {
      case "start":
        response = `${await this.status(userId)}\n\n${telegramHelp}`;
        break;
      case "help":
        response = telegramHelp;
        break;
      case "new":
        response = `Выбран чат: ${(await service.create(userId, args[0])).alias}`;
        break;
      case "add":
        response = `Выбран чат: ${(await service.add(userId, args[0], args[1])).alias}`;
        break;
      case "chats": {
        const active = this.dependencies.mappings.getActive(userId);
        response =
          service
            .list(userId)
            .map((chat) => `${chat.id === active?.id ? "→ " : ""}${chat.alias} · ${chat.status}`)
            .join("\n") || "Нет чатов. /new [alias]";
        break;
      }
      case "use":
        response = `Выбран чат: ${service.use(userId, args[0]).alias}`;
        break;
      case "current": {
        const chat = service.current(userId);
        response = `${chat.alias} · ${chat.status}`;
        break;
      }
      case "rename":
        service.rename(userId, args[0], args[1]);
        response = `Переименован: ${args[1]}`;
        break;
      case "remove":
        service.remove(userId, args[0]);
        response = `Привязка удалена: ${args[0]}`;
        break;
      case "status":
        response = await this.status(userId);
        break;
      case "stop": {
        const result = this.dependencies.requests.stop(
          service.current(userId).providerConversationId,
        );
        response = {
          nothing_running: "Нет активной генерации.",
          unsupported: "Остановка не поддерживается провайдером.",
          requested: "Остановка запрошена.",
          already_requested: "Остановка уже запрошена.",
        }[result.kind];
        break;
      }
      default:
        response = "INVALID_COMMAND: /help";
    }
    await this.notice(destination, response);
  }

  private async status(userId: string): Promise<string> {
    const health = await this.dependencies.requests.health();
    const queue = this.dependencies.requests.status();
    const state =
      !this.dependencies.transportReady() || queue.phase !== "running"
        ? "DEGRADED"
        : health.state === "auth_required"
          ? "AUTH_REQUIRED"
          : health.state === "ready"
            ? "READY"
            : "PROVIDER_UNAVAILABLE";
    const snapshot = this.dependencies.queueRepository.snapshot();
    const ids = new Set([
      ...snapshot.queued.map((work) => work.request.id),
      ...snapshot.blocked.map((block) => block.requestId),
    ]);
    const unfinished = [...ids]
      .map((id) => this.dependencies.requestRepository.get(id))
      .filter(
        (request): request is Request =>
          !!request &&
          this.dependencies.mappings.get(request.conversationId)?.telegramUserId === userId,
      );
    const failures = queue.deliveryFailures.filter((id) => {
      const request = this.dependencies.requestRepository.get(id);
      return (
        request && this.dependencies.mappings.get(request.conversationId)?.telegramUserId === userId
      );
    });
    const degraded =
      state === "READY" &&
      (queue.executionFailures.length > 0 ||
        snapshot.blocked.some((block) => !queue.activeRequestIds.includes(block.requestId)));
    return `${this.dependencies.providerLabel} · ${degraded ? "DEGRADED" : state}\n${unfinished.map((request) => `[${request.id}] ${request.state}`).join("\n")}${failures.length ? `\nTELEGRAM_DELIVERY_FAILED: ${failures.join(", ")}` : ""}`;
  }

  private async notice(destination: Destination, text: string): Promise<void> {
    try {
      await this.send(destination, text, false);
    } catch {
      this.dependencies.log("warn", {
        operation: "telegram.notice_failed",
        errorCode: "TELEGRAM_DELIVERY_FAILED",
      });
    }
  }

  private async send(destination: Destination, text: string, rich: boolean): Promise<void> {
    for (const chunk of renderTelegram(text)) {
      try {
        await this.dependencies.api.sendMessage({
          ...destination,
          text: rich ? chunk.html : chunk.plain,
          parseMode: rich ? "HTML" : undefined,
        });
      } catch (error) {
        if (!rich || !(error instanceof TelegramError) || error.code !== "TELEGRAM_PARSE_ERROR")
          throw error;
        await this.dependencies.api.sendMessage({ ...destination, text: chunk.plain });
      }
    }
  }
}
