import type { LogLevel } from "../config/schema";
import { redact } from "./redaction";

export type LogFields = Readonly<{
  operation: string;
  requestId?: string;
  telegramUpdateId?: string;
  telegramUserId?: string;
  conversationId?: string;
  conversationAlias?: string;
  requestState?: string;
  providerState?: string;
  durationMs?: number;
  errorCode?: string;
  reason?: string;
  issues?: readonly Readonly<{ field: string; reason: string }>[];
}>;

const fields = [
  "operation",
  "requestId",
  "telegramUpdateId",
  "telegramUserId",
  "conversationId",
  "conversationAlias",
  "requestState",
  "providerState",
  "durationMs",
  "errorCode",
  "reason",
  "issues",
] as const;
const weights: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// Единственная log boundary сначала выбирает metadata, затем редактирует и пишет одну JSON-строку.
// Allowlist исключает prompt/response, config и exceptions даже при лишних runtime-полях у caller.
export function createLogger(
  options: {
    level?: LogLevel;
    knownSecrets?: readonly string[];
    sink?: (line: string) => void;
  } = {},
) {
  const threshold = weights[options.level ?? "info"];
  const sink =
    options.sink ??
    ((line: string) => {
      process.stderr.write(line);
    });
  return (level: LogLevel, input: LogFields): void => {
    if (weights[level] < threshold) return;
    const metadata: Record<string, unknown> = {};
    for (const field of fields) {
      if (input[field] !== undefined) metadata[field] = input[field];
    }
    const record = { timestamp: new Date().toISOString(), level, ...metadata };
    sink(`${JSON.stringify(redact(record, options.knownSecrets))}\n`);
  };
}
