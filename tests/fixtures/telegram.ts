import type { AttachmentService } from "../../src/application/AttachmentService";
import { ConversationService } from "../../src/application/ConversationService";
import { RequestService } from "../../src/application/RequestService";
import { createLogger } from "../../src/logging/logger";
import { SqliteAttachmentBatchRepository } from "../../src/persistence/sqlite/SqliteAttachmentBatchRepository";
import { FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
import type { RequestResultRepository } from "../../src/ports/RequestResultRepository";
import type { ResultDeliveryRepository } from "../../src/ports/ResultDeliveryRepository";
import type {
  TelegramApi,
  TelegramSend,
  TelegramUpdate,
} from "../../src/transports/telegram/TelegramApi";
import { TelegramBot } from "../../src/transports/telegram/TelegramBot";
import { TelegramFileCollector } from "../../src/transports/telegram/TelegramFileCollector";
import { later, type QueueFixture } from "./queue";

export class FakeTelegramApi implements TelegramApi {
  readonly sent: TelegramSend[] = [];
  sendFailure: ((message: TelegramSend) => unknown) | undefined;
  async getMe() {
    return { id: 777, username: "r4_bot" };
  }
  async getUpdates(_offset: number | undefined, _signal: AbortSignal): Promise<TelegramUpdate[]> {
    return [];
  }
  async sendMessage(input: TelegramSend): Promise<void> {
    this.sent.push(input);
    const error = this.sendFailure?.(input);
    if (error) throw error;
  }
  async *downloadFile(_fileId: string, _maxBytes: number): AsyncIterable<Uint8Array> {
    yield await Promise.reject(new Error("FAKE_FILE_NOT_CONFIGURED"));
  }
}

export function update(id: number, text: string, userId = 123): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id + 100,
      from: { id: userId, is_bot: false },
      chat: { id: userId, type: "private" },
      text,
    },
  };
}

export function setupTelegram(
  f: QueueFixture,
  provider = new FakeChatProvider(),
  allowedUserIds = ["123", "456"],
  attachments?: AttachmentService,
  delivery?: Readonly<{
    results: RequestResultRepository & ResultDeliveryRepository;
    now?: () => string;
    signal?: AbortSignal;
  }>,
) {
  const api = new FakeTelegramApi();
  const logs: string[] = [];
  let id = 0,
    conversationId = 0;
  let ready = true;
  let bot: TelegramBot;
  const now = delivery?.now ?? (() => later);
  const requests = new RequestService({
    queueRepository: f.store,
    requests: f.requests,
    results: delivery?.results,
    provider,
    attachments,
    options: { maxPendingPerConversation: 3, generationTimeoutMs: 600000 },
    now,
    onResult: (result) => bot.result(result),
    onProgress: (request) => bot.progress(request),
  });
  const conversations = new ConversationService(
    f.conversations,
    provider,
    now,
    () => `new-${++conversationId}`,
  );
  bot = new TelegramBot({
    api,
    username: "r4_bot",
    allowedUserIds,
    acceptsMessage: (message) =>
      message.chat.type === "private" && message.chat.id === message.from?.id,
    destination: (request) => {
      const chat = f.conversations.get(request.conversationId);
      return chat ? { chatId: chat.telegramUserId, replyTo: request.telegramMessageId } : null;
    },
    conversations,
    mappings: f.conversations,
    requests,
    requestRepository: f.requests,
    results: delivery?.results,
    queueRepository: f.store,
    updates: f.updates,
    transportReady: () => ready,
    providerLabel: "Fake",
    now,
    signal: delivery?.signal,
    newRequestId: () => `r${++id}`,
    log: createLogger({ sink: (line) => logs.push(line) }),
    files: attachments
      ? new TelegramFileCollector({
          service: attachments,
          batches: new SqliteAttachmentBatchRepository(f.database),
          mappings: f.conversations,
          api,
          fileUpload: provider.capabilities.fileUpload,
          ttlMs: 86400000,
          now: () => later,
          newId: () => `r${++id}`,
        })
      : undefined,
  });
  return {
    bot,
    requests,
    conversations,
    provider,
    api,
    logs,
    setReady(value: boolean) {
      ready = value;
    },
  };
}
