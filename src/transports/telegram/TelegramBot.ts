import { ConversationError, type ConversationService } from "../../application/ConversationService";
import type { RequestResult, RequestService } from "../../application/RequestService";
import type { Conversation } from "../../domain/Conversation";
import type { Request } from "../../domain/Request";
import type { RequestInput } from "../../domain/RequestInput";
import type { createLogger } from "../../logging/logger";
import { AttachmentError } from "../../ports/AttachmentStore";
import { ProviderOperationError } from "../../ports/ChatProvider";
import type { ConversationRepository } from "../../ports/ConversationRepository";
import type { RequestQueueRepository } from "../../ports/RequestQueueRepository";
import type { RequestRepository } from "../../ports/RequestRepository";
import type { ResultDeliveryRepository } from "../../ports/ResultDeliveryRepository";
import type { UpdateDedupRepository } from "../../ports/UpdateDedupRepository";
import { type TelegramApi, TelegramError, type TelegramUpdate } from "./TelegramApi";
import { parseTelegramCommand, telegramHelp, unknownRecoveryNotice } from "./TelegramCommands";
import type { TelegramFileCollector } from "./TelegramFileCollector";
import { renderTelegram } from "./TelegramRenderer";
import {
  TelegramResultDelivery,
  requestResultPlan,
  sendResultPart,
} from "./TelegramResultDelivery";

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
  results?: ResultDeliveryRepository;
  queueRepository: RequestQueueRepository;
  updates: UpdateDedupRepository;
  transportReady: () => boolean;
  providerLabel: string;
  now: () => string;
  newRequestId: () => string;
  log: ReturnType<typeof createLogger>;
  signal?: AbortSignal;
  files?: TelegramFileCollector;
}>;

export class TelegramBot {
  private readonly allowed: Set<string>;
  private ingress: Promise<void> = Promise.resolve();
  private readonly progressGates = new Map<string, Promise<void>>();
  private readonly progressDeliveries = new Map<string, Promise<void>>();
  private readonly resultTasks = new Map<string, Promise<void>>();
  private readonly resultDelivery?: TelegramResultDelivery;

  constructor(private readonly dependencies: Dependencies) {
    this.allowed = new Set(dependencies.allowedUserIds);
    if (dependencies.results)
      this.resultDelivery = new TelegramResultDelivery({
        repository: dependencies.results,
        api: dependencies.api,
        destination: (request) => this.resultDestination(request),
        now: dependencies.now,
        signal: dependencies.signal,
      });
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
    if (media) {
      if (!this.dependencies.files) {
        this.markCommand(updateId);
        await this.notice(destination, "ATTACHMENT_REJECTED");
        return;
      }
      let collected: Awaited<ReturnType<TelegramFileCollector["collect"]>> | undefined;
      let accepted = false;
      try {
        collected = await this.dependencies.files.collect(userId, message, updateId, () =>
          this.dependencies.conversations.current(userId),
        );
        if (collected.kind === "staged")
          await this.notice(
            destination,
            `Файлов в черновике: ${collected.count} · ${collected.mapping.alias}. /send или /discard`,
          );
        else
          accepted = await this.accept(
            userId,
            updateId,
            String(message.message_id),
            destination,
            collected.mapping,
            collected.input,
            collected.id,
          );
      } catch (error) {
        if (!(error instanceof AttachmentError || error instanceof ConversationError)) throw error;
        if (!this.dependencies.updates.get(updateId)) this.markCommand(updateId);
        this.dependencies.log("warn", {
          operation: "telegram.attachment_failed",
          telegramUpdateId: updateId,
          telegramUserId: userId,
          errorCode: error.code,
          reason: error instanceof AttachmentError ? error.reason : undefined,
        });
        await this.notice(destination, error.code);
      } finally {
        if (collected?.kind === "single")
          await this.dependencies.files.releaseSingle(collected.prepared, accepted);
      }
      return;
    }
    const command = parseTelegramCommand(message.text ?? "", this.dependencies.username);
    if (command.kind === "ignored") return;
    if (!message.text || command.kind === "invalid") {
      this.markCommand(updateId);
      await this.notice(destination, "INVALID_COMMAND: /help");
      return;
    }
    if (command.kind === "command") {
      if (command.name === "send") {
        try {
          const pending = this.dependencies.files?.pending(userId);
          if (pending)
            await this.accept(
              userId,
              updateId,
              String(message.message_id),
              destination,
              pending.mapping,
              pending.input,
              pending.id,
            );
          else {
            this.markCommand(updateId);
            await this.notice(destination, "Нет черновика альбома.");
          }
        } catch (error) {
          if (!(error instanceof AttachmentError)) throw error;
          this.markCommand(updateId);
          await this.notice(destination, error.code);
        }
        return;
      }
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
    await this.accept(userId, updateId, String(message.message_id), destination, selected, {
      text: message.text,
      attachments: [],
    });
  }

  private async accept(
    userId: string,
    updateId: string,
    messageId: string,
    destination: Destination,
    selected: Conversation,
    input: RequestInput,
    id = this.dependencies.newRequestId(),
  ): Promise<boolean> {
    const request: Request = {
      id,
      conversationId: selected.id,
      telegramUpdateId: updateId,
      telegramMessageId: messageId,
      state: "created",
      createdAt: this.dependencies.now(),
    };
    const gate = Promise.withResolvers<void>();
    this.progressGates.set(request.id, gate.promise);
    try {
      const result = this.dependencies.requests.accept(request, input);
      if (result.kind !== "accepted") {
        this.progressGates.delete(request.id);
        if (result.kind === "rejected") await this.notice(destination, result.code);
        return false;
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
      return true;
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

  result(result: RequestResult): Promise<void> {
    const existing = this.resultTasks.get(result.request.id);
    if (existing) return existing;
    const delivery = this.deliverResult(result).finally(() => {
      this.resultTasks.delete(result.request.id);
    });
    this.resultTasks.set(result.request.id, delivery);
    return delivery;
  }

  async retryResults(signal?: AbortSignal): Promise<void> {
    const results = this.dependencies.results;
    if (!results) return;
    results.expire(this.dependencies.now());
    for (const id of results.due(this.dependencies.now())) {
      if (signal?.aborted) break;
      const request = this.dependencies.requestRepository.get(id);
      if (request) {
        try {
          await this.result({ request });
        } catch {
          if (signal?.aborted) break;
        }
      }
    }
  }

  private async deliverResult(result: RequestResult): Promise<void> {
    const request = result.request;
    try {
      await this.progressGates.get(request.id);
      try {
        await this.progressDeliveries.get(request.id);
      } catch {
        /* Final delivery remains independent of progress failure. */
      }
      if (this.resultDelivery) {
        if (!(await this.resultDelivery.deliver(request.id))) return;
      } else {
        for (const chunk of requestResultPlan(result))
          await sendResultPart(
            this.dependencies.api,
            chunk,
            result,
            () => {
              const destination = this.resultDestination(request);
              if (!destination) throw new TelegramError("TELEGRAM_DELIVERY_FAILED");
              return destination;
            },
            this.dependencies.signal,
          );
      }
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
      this.dependencies.signal?.throwIfAborted();
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
      case "doctor":
        response = await this.status(userId, true);
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
      case "queue":
        response =
          this.dependencies.requests
            .pending(userId)
            .map(
              (request) =>
                `[${request.id}] ${this.dependencies.mappings.get(request.conversationId)?.alias ?? "чат"} · ${request.state}`,
            )
            .join("\n") || "Нет ожидающих запросов.";
        break;
      case "clearqueue": {
        const conversationId = args[0] === "all" ? undefined : service.current(userId).id;
        const count = await this.dependencies.requests.clearPending(userId, conversationId);
        response = `Убрано ожидающих запросов: ${count}. Активная генерация и UNKNOWN сохранены.`;
        break;
      }
      case "discard":
        await this.dependencies.files?.discard(userId);
        response = "Черновик альбома удалён.";
        break;
      default:
        response = "INVALID_COMMAND: /help";
    }
    await this.notice(destination, response);
  }

  private async status(userId: string, detailed = false): Promise<string> {
    const health = await this.dependencies.requests.health();
    const queue = this.dependencies.requests.status();
    const transport = this.dependencies.transportReady() ? "ready" : "unavailable";
    const state =
      queue.phase === "error"
        ? "ERROR"
        : health.state === "auth_required"
          ? "AUTH_REQUIRED"
          : health.state === "unavailable"
            ? "PROVIDER_UNAVAILABLE"
            : transport !== "ready" || queue.phase !== "running"
              ? "DEGRADED"
              : "READY";
    try {
      const snapshot = this.dependencies.queueRepository.snapshot();
      const active = new Set(queue.activeRequestIds);
      const blocks = snapshot.blocked.filter((block) => !active.has(block.requestId));
      const ids = new Set([
        ...snapshot.queued.map((work) => work.request.id),
        ...snapshot.blocked.map((block) => block.requestId),
        ...active,
      ]);
      const owned = (id: string): Request | null => {
        const request = this.dependencies.requestRepository.get(id);
        return request &&
          this.dependencies.mappings.get(request.conversationId)?.telegramUserId === userId
          ? request
          : null;
      };
      const unfinished = [...ids].map(owned).filter((request): request is Request => !!request);
      const ownIds = new Set(unfinished.map((request) => request.id));
      const deliveries = this.dependencies.results?.diagnostics();
      const deliveryFailures = deliveries
        ? deliveries.filter((entry) => entry.failureCode).map((entry) => entry.requestId)
        : queue.deliveryFailures;
      const failures = deliveryFailures.filter((id) => owned(id));
      const degraded =
        state === "READY" &&
        (blocks.length > 0 ||
          queue.executionFailures.length > 0 ||
          deliveryFailures.length > 0 ||
          queue.cleanupFailures.length > 0);
      const lines = [
        `${this.dependencies.providerLabel} · ${degraded ? "DEGRADED" : state}`,
        `Провайдер: ${health.state} · Telegram: ${transport} · БД: ready`,
        `Очередь: ${queue.phase} · активных: ${queue.activeRequestIds.filter((id) => ownIds.has(id)).length} · ожидают: ${snapshot.queued.filter((work) => ownIds.has(work.request.id)).length} · блокировок: ${blocks.filter((block) => ownIds.has(block.requestId)).length}`,
        ...unfinished.map((request) => {
          const block = blocks.find((entry) => entry.requestId === request.id);
          return `[${request.id}] ${request.state}${block ? ` · ${block.reason}` : ""}`;
        }),
      ];
      if (blocks.length) lines.push("Есть блокировка очереди или общей ёмкости провайдера.");
      if (failures.length) lines.push(`TELEGRAM_DELIVERY_FAILED: ${failures.join(", ")}`);
      for (const entry of deliveries ?? []) {
        if (owned(entry.requestId))
          lines.push(
            `[${entry.requestId}] delivery:${entry.state} · попыток: ${entry.attempts}${entry.nextAttemptAt ? ` · повтор: ${entry.nextAttemptAt}` : ""}${entry.failureCode ? ` · ${entry.failureCode}` : ""}`,
          );
      }
      if (queue.errorCode) lines.push(queue.errorCode);
      if (unfinished.some((request) => request.state === "unknown"))
        lines.push(unknownRecoveryNotice);
      if (detailed) {
        lines.push(`Проверено: ${health.observedAt}`);
        lines.push(
          `Параллельных чатов: ${queue.capabilities.maxConcurrentConversations} · остановка: ${queue.capabilities.cancellation ? "поддерживается" : "не поддерживается"} · файлы: ${queue.capabilities.fileUpload ? "поддерживаются" : "не поддерживаются"}`,
        );
        for (const [label, entries] of [
          ["EXECUTION_FAILED", queue.executionFailures],
          ["ATTACHMENT_CLEANUP_FAILED", queue.cleanupFailures],
        ] as const) {
          const visible = entries.filter((id) => owned(id));
          if (visible.length) lines.push(`${label}: ${visible.join(", ")}`);
        }
      }
      return lines.join("\n");
    } catch {
      return `${this.dependencies.providerLabel} · ERROR\nПровайдер: ${health.state} · Telegram: ${transport} · БД: unavailable\nDATABASE_ERROR: состояние очереди недоступно.`;
    }
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
