import { ConversationService } from "../application/ConversationService";
import { RequestService } from "../application/RequestService";
import type { Config } from "../config/Config";
import type { Request } from "../domain/Request";
import { createLogger } from "../logging/logger";
import { openDatabase } from "../persistence/sqlite/Database";
import { migrateDatabase } from "../persistence/sqlite/migrations";
import { SqliteConversationRepository } from "../persistence/sqlite/SqliteConversationRepository";
import { SqliteRequestQueueRepository } from "../persistence/sqlite/SqliteRequestQueueRepository";
import { SqliteRequestRepository } from "../persistence/sqlite/SqliteRequestRepository";
import { SqliteUpdateDedupRepository } from "../persistence/sqlite/SqliteUpdateDedupRepository";
import type { ChatProvider } from "../ports/ChatProvider";
import type { ConversationRepository } from "../ports/ConversationRepository";
import type { TelegramApi, TelegramUpdate } from "../transports/telegram/TelegramApi";
import { TelegramBot } from "../transports/telegram/TelegramBot";
import { TelegramPolling } from "../transports/telegram/TelegramPolling";

export type TelegramChatPolicy = Readonly<{
  acceptsMessage: (message: NonNullable<TelegramUpdate["message"]>) => boolean;
  destination: (
    request: Request,
    mappings: ConversationRepository,
  ) => Readonly<{ chatId: string; replyTo?: string }> | null;
}>;

export async function runGateway(
  input: Readonly<{
    config: Config;
    api: TelegramApi;
    provider: ChatProvider | ((mappings: ConversationRepository) => ChatProvider);
    providerLabel: string;
    chatPolicy: TelegramChatPolicy;
    signal: AbortSignal;
    log?: ReturnType<typeof createLogger>;
  }>,
): Promise<void> {
  const log =
    input.log ??
    createLogger({
      level: input.config.logging.level,
      knownSecrets: [input.config.telegram.botToken],
    });
  let database: ReturnType<typeof openDatabase> | undefined;
  let service: RequestService | undefined;
  let bot: TelegramBot | undefined;
  const allowed = new Set(input.config.telegram.allowedUserIds);
  const now = () => new Date().toISOString();
  const runner = new TelegramPolling({
    api: input.api,
    initialize: async (identity) => {
      database = openDatabase(input.config.database.path);
      migrateDatabase(database);
      const mappings = new SqliteConversationRepository(database);
      const requests = new SqliteRequestRepository(database);
      const queue = new SqliteRequestQueueRepository(database);
      const updates = new SqliteUpdateDedupRepository(database);
      const provider =
        typeof input.provider === "function" ? input.provider(mappings) : input.provider;
      const conversations = new ConversationService(mappings, provider, now, () =>
        crypto.randomUUID(),
      );
      service = new RequestService({
        queueRepository: queue,
        requests,
        provider,
        options: {
          maxPendingPerConversation: input.config.queue.maxPendingPerConversation,
          generationTimeoutMs: input.config.requests.generationTimeoutMs,
        },
        now,
        onResult: (result) => (bot as TelegramBot).result(result),
        onProgress: (request) => (bot as TelegramBot).progress(request),
        requestAllowed: (request) => {
          const mapping = mappings.get(request.conversationId);
          return !!mapping && allowed.has(mapping.telegramUserId);
        },
      });
      bot = new TelegramBot({
        api: input.api,
        username: identity.username,
        allowedUserIds: input.config.telegram.allowedUserIds,
        acceptsMessage: input.chatPolicy.acceptsMessage,
        destination: (request) => input.chatPolicy.destination(request, mappings),
        conversations,
        mappings,
        requests: service,
        requestRepository: requests,
        queueRepository: queue,
        updates,
        transportReady: () => runner.ready(),
        providerLabel: input.providerLabel,
        now,
        newRequestId: () => crypto.randomUUID(),
        log,
      });
      await service.start();
      log("info", { operation: "gateway.started" });
    },
    handle: (update) => (bot as TelegramBot).handle(update),
    shutdown: async () => {
      await service?.shutdown();
    },
  });
  try {
    await runner.run(input.signal);
  } finally {
    database?.close(true);
  }
}
