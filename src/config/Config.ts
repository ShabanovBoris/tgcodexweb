import { resolve } from "node:path";
import { configSchema, databaseSchema } from "./schema";

export type Environment = Readonly<Record<string, string | undefined>>;
export type ConfigIssue = Readonly<{ field: string; reason: string }>;

// Ошибка отделяет безопасную диагностику от Zod input: исходные значения не выходят в CLI/logging.
export class ConfigError extends Error {
  readonly code = "CONFIG_ERROR";
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly { path: readonly PropertyKey[]; message: string }[]) {
    super("CONFIG_ERROR");
    this.name = "ConfigError";
    this.issues = issues.map((issue) => ({ field: String(issue.path[0]), reason: issue.message }));
  }
}

// Environment читается только на границе запуска; injected env делает проверку независимой от машины.
export function loadConfig(env: Environment, cwd = process.cwd()) {
  const result = configSchema.safeParse(env);
  if (!result.success) throw new ConfigError(result.error.issues);
  const values = result.data;
  return {
    telegram: {
      botToken: values.TELEGRAM_BOT_TOKEN,
      allowedUserIds: values.TELEGRAM_ALLOWED_USER_IDS as readonly string[],
    },
    provider: { type: values.PROVIDER_TYPE },
    database: { path: resolve(cwd, values.DATABASE_PATH) },
    browser: { profileDir: resolve(cwd, values.BROWSER_PROFILE_DIR) },
    requests: { generationTimeoutMs: values.GENERATION_TIMEOUT_MS },
    queue: { maxPendingPerConversation: values.MAX_PENDING_PER_CONVERSATION },
    attachments: {
      tempDir: resolve(cwd, values.ATTACHMENT_TEMP_DIR),
      maxFilesPerRequest: values.ATTACHMENT_MAX_FILES_PER_REQUEST,
      maxFileSizeBytes: values.ATTACHMENT_MAX_FILE_SIZE_BYTES,
    },
    logging: { level: values.LOG_LEVEL, content: values.LOG_CONTENT },
  } as const;
}

export type Config = ReturnType<typeof loadConfig>;

// Обслуживание локальной БД не зависит от готовности будущего Telegram transport.
export function loadDatabaseConfig(env: Environment, cwd = process.cwd()) {
  const result = databaseSchema.safeParse(env);
  if (!result.success) throw new ConfigError(result.error.issues);
  return { path: resolve(cwd, result.data.DATABASE_PATH) } as const;
}
