import { basename, dirname, join } from "node:path";
import { type Environment, loadConfig } from "./config/Config";
import { createLogger } from "./logging/logger";
import { openDatabase } from "./persistence/sqlite/Database";
import { migrateDatabase } from "./persistence/sqlite/migrations";
import { FakeChatProvider } from "./providers/fake/FakeChatProvider";
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
    database: {
      path: join(dirname(config.database.path), `fake-${basename(config.database.path)}`),
    },
  };
  await runGateway({
    config: fakeConfig,
    api: api ?? new HttpTelegramApi(config.telegram.botToken),
    provider: (mappings) =>
      new FakeChatProvider({
        capabilities: { maxConcurrentConversations: 2, cancellation: true, fileUpload: false },
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
