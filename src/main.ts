import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { type Environment, loadConfig, loadDatabaseConfig } from "./config/Config";
import { createLogger } from "./logging/logger";
import { DatabaseError, openDatabase } from "./persistence/sqlite/Database";
import { acquireGatewayLease } from "./persistence/sqlite/GatewayLease";
import { migrateDatabase } from "./persistence/sqlite/migrations";
import { SqliteUnknownRecoveryRepository } from "./persistence/sqlite/SqliteUnknownRecoveryRepository";
import { FakeChatProvider } from "./providers/fake/FakeChatProvider";
import { ChatGptWebProvider } from "./providers/chatgpt-web/ChatGptWebProvider";
import { runGateway, type TelegramChatPolicy } from "./runtime/GatewayRuntime";
import { HttpTelegramApi, type TelegramApi } from "./transports/telegram/TelegramApi";

// One-shot local maintenance is separate from the long-running Telegram runtime.
// Config validation предшествует filesystem side effects; bootstrap.complete не означает READY.
export function bootstrap(env: Environment, cwd = process.cwd()): void {
  const config = loadConfig(env, cwd);
  const log = createLogger({
    level: config.logging.level,
    knownSecrets: [config.telegram.botToken],
  });
  const database = openDatabase(config.database.path);
  try {
    migrateDatabase(database);
    log("info", { operation: "bootstrap.complete" });
  } finally {
    database.close(true);
  }
}

export function recoverUnknown(env: Environment, requestId: string, cwd = process.cwd()) {
  const config = loadDatabaseConfig(env, cwd);
  if (!existsSync(config.path)) throw new DatabaseError("entity_not_found");
  const release = acquireGatewayLease(config.path);
  let database: ReturnType<typeof openDatabase> | undefined;
  try {
    database = openDatabase(config.path);
    migrateDatabase(database);
    return new SqliteUnknownRecoveryRepository(database).confirmCompleted(
      requestId,
      new Date().toISOString(),
    );
  } finally {
    try {
      database?.close(true);
    } finally {
      release();
    }
  }
}

export const privateChatPolicy: TelegramChatPolicy = {
  acceptsMessage: (message) =>
    message.chat.type === "private" && message.chat.id === message.from?.id,
  destination: (request, mappings) => {
    const mapping = mappings.get(request.conversationId);
    return mapping ? { chatId: mapping.telegramUserId, replyTo: request.telegramMessageId } : null;
  },
};

export async function startFakeGateway(
  env: Environment,
  signal: AbortSignal,
  cwd = process.cwd(),
  api?: TelegramApi,
): Promise<void> {
  const config = loadConfig(env, cwd);
  // Explicit development mode uses separate metadata; it cannot reconcile real-provider requests with fake evidence.
  const fakeConfig = {
    ...config,
    attachments: { ...config.attachments, tempDir: join(config.attachments.tempDir, "fake") },
    database: {
      path: join(dirname(config.database.path), `fake-${basename(config.database.path)}`),
    },
  };
  await runGateway({
    config: fakeConfig,
    api: api ?? new HttpTelegramApi(config.telegram.botToken),
    provider: (mappings, attachmentStore) =>
      new FakeChatProvider({
        attachmentStore,
        capabilities: { maxConcurrentConversations: 2, cancellation: true, fileUpload: true },
        conversations: [
          "remote",
          "Remote",
          ...config.telegram.allowedUserIds.flatMap((user) =>
            mappings
              .list(user, { includeArchived: true })
              .map((mapping) => mapping.providerConversationId),
          ),
        ],
        conversationIdPrefix: `fake-${crypto.randomUUID()}`,
      }),
    providerLabel: "FAKE (development)",
    chatPolicy: privateChatPolicy,
    signal,
  });
}

export async function startGateway(
  env: Environment,
  signal: AbortSignal,
  cwd = process.cwd(),
  api?: TelegramApi,
): Promise<void> {
  const config = loadConfig(env, cwd);
  const log = createLogger({
    level: config.logging.level,
    knownSecrets: [config.telegram.botToken],
  });
  await runGateway({
    config,
    api: api ?? new HttpTelegramApi(config.telegram.botToken),
    provider: (_mappings, attachmentStore) =>
      new ChatGptWebProvider({ ...config.browser, attachmentStore, log }),
    providerLabel: "ChatGPT Web (local upstream fork)",
    chatPolicy: privateChatPolicy,
    signal,
    log,
  });
}
