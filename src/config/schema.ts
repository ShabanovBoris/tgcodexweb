import { z } from "zod";

export const logLevels = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof logLevels)[number];

// Пустые optional-поля из .env.example должны выбирать default, а не менять его смысл.
function blankAsMissing(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

// Все лимиты проверяются одинаково: округление или отрицательный предел изменили бы поведение.
function positiveInteger(fallback: number) {
  return z.preprocess(
    blankAsMissing,
    z
      .string({ error: "invalid_positive_integer" })
      .trim()
      .regex(/^[0-9]+$/, { error: "invalid_positive_integer" })
      .refine((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0, {
        error: "invalid_positive_integer",
      })
      .default(String(fallback))
      .transform(Number),
  );
}

const requiredText = z.string({ error: "required" }).trim().min(1, { error: "required" });
const databasePath = z.preprocess(
  blankAsMissing,
  z
    .string({ error: "invalid_path" })
    .trim()
    .min(1, { error: "invalid_path" })
    .default("./data/gateway.sqlite"),
);

// Schema владеет валидацией внешних строк; дальнейшие слои получают уже проверенные значения.
export const configSchema = z.object({
  TELEGRAM_BOT_TOKEN: requiredText,
  TELEGRAM_ALLOWED_USER_IDS: requiredText
    .refine((value) => value.split(",").every((id) => /^[1-9][0-9]*$/.test(id.trim())), {
      error: "invalid_user_id",
    })
    .transform((value) => [...new Set(value.split(",").map((id) => id.trim()))]),
  PROVIDER_TYPE: z.preprocess(
    blankAsMissing,
    z.literal("chatgpt-web", { error: "unsupported_provider" }).default("chatgpt-web"),
  ),
  DATABASE_PATH: databasePath,
  BROWSER_PROFILE_DIR: z.preprocess(
    blankAsMissing,
    z
      .string({ error: "invalid_path" })
      .trim()
      .min(1, { error: "invalid_path" })
      .default("./data/browser-profile"),
  ),
  GENERATION_TIMEOUT_MS: positiveInteger(600000),
  MAX_PENDING_PER_CONVERSATION: positiveInteger(20),
  ATTACHMENT_TEMP_DIR: z.preprocess(
    blankAsMissing,
    z
      .string({ error: "invalid_path" })
      .trim()
      .min(1, { error: "invalid_path" })
      .default("./data/tmp"),
  ),
  ATTACHMENT_MAX_FILES_PER_REQUEST: positiveInteger(10),
  ATTACHMENT_MAX_FILE_SIZE_BYTES: positiveInteger(52428800),
  LOG_LEVEL: z.preprocess(
    blankAsMissing,
    z.enum(logLevels, { error: "invalid_log_level" }).default("info"),
  ),
  LOG_CONTENT: z.preprocess(
    blankAsMissing,
    z
      .enum(["true", "false"], { error: "invalid_boolean" })
      .default("false")
      .transform((value) => value === "true"),
  ),
});

export const databaseSchema = configSchema.pick({ DATABASE_PATH: true });
