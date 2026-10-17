import { resolve, sep } from "node:path";
import { browserSchema, configSchema, databaseSchema } from "./schema";

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
  const profileDir = resolve(cwd, values.BROWSER_PROFILE_DIR);
  const tempDir = resolve(cwd, values.ATTACHMENT_TEMP_DIR);
  const databasePath = resolve(cwd, values.DATABASE_PATH);
  const contains = (parent: string, child: string) =>
    child === parent || child.startsWith(parent + sep);
  if (
    contains(profileDir, tempDir) ||
    contains(tempDir, profileDir) ||
    contains(profileDir, databasePath)
  )
    throw new ConfigError([
      { path: ["BROWSER_PROFILE_DIR"], message: "browser_profile_must_be_isolated" },
    ]);
  return {
    telegram: {
      botToken: values.TELEGRAM_BOT_TOKEN,
      allowedUserIds: values.TELEGRAM_ALLOWED_USER_IDS as readonly string[],
    },
    provider: { type: values.PROVIDER_TYPE },
    database: { path: databasePath },
    browser: {
      profileDir,
      executablePath: values.BROWSER_EXECUTABLE_PATH
        ? resolve(cwd, values.BROWSER_EXECUTABLE_PATH)
        : undefined,
      headless: values.BROWSER_HEADLESS,
    },
    requests: { generationTimeoutMs: values.GENERATION_TIMEOUT_MS },
    queue: { maxPendingPerConversation: values.MAX_PENDING_PER_CONVERSATION },
    attachments: {
      tempDir,
      maxFilesPerRequest: values.ATTACHMENT_MAX_FILES_PER_REQUEST,
      maxFileSizeBytes: values.ATTACHMENT_MAX_FILE_SIZE_BYTES,
      tempTtlMs: values.ATTACHMENT_TEMP_TTL_MS,
      allowedExtensions: values.ATTACHMENT_ALLOWED_EXTENSIONS,
      allowedMimeTypes: values.ATTACHMENT_ALLOWED_MIME_TYPES,
    },
    logging: { level: values.LOG_LEVEL, content: values.LOG_CONTENT },
  } as const;
}

export type Config = ReturnType<typeof loadConfig>;

export function loadBrowserConfig(env: Environment, cwd = process.cwd()) {
  const result = browserSchema.safeParse(env);
  if (!result.success) throw new ConfigError(result.error.issues);
  return {
    profileDir: resolve(cwd, result.data.BROWSER_PROFILE_DIR),
    executablePath: result.data.BROWSER_EXECUTABLE_PATH
      ? resolve(cwd, result.data.BROWSER_EXECUTABLE_PATH)
      : undefined,
    headless: result.data.BROWSER_HEADLESS,
  };
}

// Обслуживание локальной БД не зависит от готовности будущего Telegram transport.
export function loadDatabaseConfig(env: Environment, cwd = process.cwd()) {
  const result = databaseSchema.safeParse(env);
  if (!result.success) throw new ConfigError(result.error.issues);
  return { path: resolve(cwd, result.data.DATABASE_PATH) } as const;
}
