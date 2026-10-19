import { AttachmentService } from "../application/AttachmentService";
import { ConversationService } from "../application/ConversationService";
import { RequestService } from "../application/RequestService";
import type { Config } from "../config/Config";
import type { Request } from "../domain/Request";
import { createLogger } from "../logging/logger";
import { openDatabase } from "../persistence/sqlite/Database";
import { migrateDatabase } from "../persistence/sqlite/migrations";
import { SqliteAttachmentBatchRepository } from "../persistence/sqlite/SqliteAttachmentBatchRepository";
import { SqliteConversationRepository } from "../persistence/sqlite/SqliteConversationRepository";
import { SqliteRequestQueueRepository } from "../persistence/sqlite/SqliteRequestQueueRepository";
import { SqliteRequestRepository } from "../persistence/sqlite/SqliteRequestRepository";
import { SqliteUpdateDedupRepository } from "../persistence/sqlite/SqliteUpdateDedupRepository";
import type { AttachmentStore } from "../ports/AttachmentStore";
import type { ChatProvider } from "../ports/ChatProvider";
import type { ConversationRepository } from "../ports/ConversationRepository";
import { LocalAttachmentStore } from "../storage/LocalAttachmentStore";
import type { TelegramApi, TelegramUpdate } from "../transports/telegram/TelegramApi";
import { TelegramBot } from "../transports/telegram/TelegramBot";
import { TelegramFileCollector } from "../transports/telegram/TelegramFileCollector";
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
    provider:
      | ChatProvider
      | ((mappings: ConversationRepository, attachments: AttachmentStore) => ChatProvider);
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
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let cleanupTask: Promise<void> | undefined;
  const allowed = new Set(input.config.telegram.allowedUserIds);
  const now = () => new Date().toISOString();
  const runner = new TelegramPolling({
    api: input.api,
    log,
    initialize: async (identity) => {
      database = openDatabase(input.config.database.path);
      migrateDatabase(database);
      const mappings = new SqliteConversationRepository(database);
      const requests = new SqliteRequestRepository(database);
      const queue = new SqliteRequestQueueRepository(database);
      const updates = new SqliteUpdateDedupRepository(database);
      const batches = new SqliteAttachmentBatchRepository(database);
      const store = new LocalAttachmentStore(input.config.attachments.tempDir);
      await store.initialize();
      const attachments = new AttachmentService(store, input.config.attachments, () =>
        batches.retainedStorageKeys(),
      );
      const sweep = () => {
        if (cleanupTask) return cleanupTask;
        cleanupTask = (async () => {
          try {
            batches.expire(now());
            await store.sweep(
              () => batches.retainedStorageKeys(),
              Date.now() - input.config.attachments.tempTtlMs,
            );
          } catch {
            log("warn", {
              operation: "attachments.cleanup_failed",
              errorCode: "ATTACHMENT_STORAGE_FAILED",
            });
          }
        })().finally(() => {
          cleanupTask = undefined;
        });
        return cleanupTask;
      };
      await sweep();
      cleanupTimer = setInterval(
        () => {
          void sweep();
        },
        Math.min(input.config.attachments.tempTtlMs, 60000),
      );
      const provider =
        typeof input.provider === "function" ? input.provider(mappings, store) : input.provider;
      const conversations = new ConversationService(mappings, provider, now, () =>
        crypto.randomUUID(),
      );
      service = new RequestService({
        queueRepository: queue,
        requests,
        provider,
        attachments,
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
        files: new TelegramFileCollector({
          service: attachments,
          batches,
          mappings,
          api: input.api,
          fileUpload: provider.capabilities.fileUpload,
          ttlMs: input.config.attachments.tempTtlMs,
          now,
          newId: () => crypto.randomUUID(),
        }),
      });
      await service.start();
      log("info", { operation: "gateway.started" });
    },
    handle: (update) => (bot as TelegramBot).handle(update),
    shutdown: async () => {
      clearInterval(cleanupTimer);
      await service?.shutdown();
      await cleanupTask;
    },
  });
  try {
    await runner.run(input.signal);
  } finally {
    clearInterval(cleanupTimer);
    await cleanupTask;
    database?.close(true);
  }
}
