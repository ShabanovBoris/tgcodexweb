import { ConversationService } from "../../src/application/ConversationService";
import { RequestService } from "../../src/application/RequestService";
import { createLogger } from "../../src/logging/logger";
import { FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
import type {
  TelegramApi,
  TelegramSend,
  TelegramUpdate,
} from "../../src/transports/telegram/TelegramApi";
import { TelegramBot } from "../../src/transports/telegram/TelegramBot";
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
) {
  const api = new FakeTelegramApi();
  const logs: string[] = [];
  let id = 0,
    conversationId = 0;
  let ready = true;
  let bot: TelegramBot;
  const requests = new RequestService({
    queueRepository: f.store,
    requests: f.requests,
    provider,
    options: { maxPendingPerConversation: 3, generationTimeoutMs: 600000 },
    now: () => later,
    onResult: (result) => bot.result(result),
    onProgress: (request) => bot.progress(request),
  });
  const conversations = new ConversationService(
    f.conversations,
    provider,
    () => later,
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
    queueRepository: f.store,
    updates: f.updates,
    transportReady: () => ready,
    providerLabel: "Fake",
    now: () => later,
    newRequestId: () => `r${++id}`,
    log: createLogger({ sink: (line) => logs.push(line) }),
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
