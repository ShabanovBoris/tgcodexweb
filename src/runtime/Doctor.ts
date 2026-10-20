import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  ConfigError,
  type Config,
  type ConfigIssue,
  type Environment,
  loadConfig,
} from "../config/Config";
import { DatabaseError } from "../persistence/sqlite/Database";
import {
  inspectDatabase,
  type DatabaseDiagnostic,
} from "../persistence/sqlite/DatabaseDiagnostics";
import { acquireGatewayLease } from "../persistence/sqlite/GatewayLease";
import { type ChatProvider, providerHealthSchema } from "../ports/ChatProvider";
import { ChatGptWebProvider } from "../providers/chatgpt-web/ChatGptWebProvider";
import {
  HttpTelegramApi,
  type TelegramApi,
  TelegramError,
} from "../transports/telegram/TelegramApi";

type Check = Readonly<{
  state: "ready" | "unavailable" | "auth_required" | "not_checked";
  errorCode?:
    | "CONFIG_ERROR"
    | "PROVIDER_UNAVAILABLE"
    | "TELEGRAM_TOKEN_INVALID"
    | "TELEGRAM_UNAVAILABLE";
  reason?: "profile_not_initialized" | "provider_close_failed";
  issues?: readonly ConfigIssue[];
}>;
export type DoctorReport = Readonly<{
  observedAt: string;
  readyToStart: boolean;
  checks: {
    config: Check;
    database: DatabaseDiagnostic | Readonly<{ state: "not_checked" }>;
    telegram: Check;
    runtime: Readonly<{ state: "not_checked" | "stopped" | "busy" | "unavailable" }>;
    provider: Check;
  };
}>;
type HealthProbe = Pick<ChatProvider, "health" | "close">;

// Preflight owns only health probes. It never starts admission, reconciles work or applies migrations.
export async function doctor(
  env: Environment,
  cwd = process.cwd(),
  dependencies: Readonly<{
    api?: Pick<TelegramApi, "getMe">;
    provider?: (browser: Config["browser"]) => HealthProbe;
  }> = {},
): Promise<DoctorReport> {
  const report: DoctorReport = {
    observedAt: new Date().toISOString(),
    readyToStart: false,
    checks: {
      config: { state: "not_checked" },
      database: { state: "not_checked" },
      telegram: { state: "not_checked" },
      runtime: { state: "not_checked" },
      provider: { state: "not_checked" },
    },
  };
  const checks = report.checks;
  let config: Config;
  try {
    config = loadConfig(env, cwd);
    checks.config = { state: "ready" };
  } catch (error) {
    checks.config = {
      state: "unavailable",
      errorCode: "CONFIG_ERROR",
      ...(error instanceof ConfigError ? { issues: error.issues } : {}),
    };
    return report;
  }
  try {
    await (dependencies.api ?? new HttpTelegramApi(config.telegram.botToken)).getMe();
    checks.telegram = { state: "ready" };
  } catch (error) {
    checks.telegram = {
      state: "unavailable",
      errorCode:
        error instanceof TelegramError && error.code === "TELEGRAM_TOKEN_INVALID"
          ? "TELEGRAM_TOKEN_INVALID"
          : "TELEGRAM_UNAVAILABLE",
    };
  }
  checks.database = inspectDatabase(config.database.path);
  if (checks.database.state !== "ready") return report;
  let release: (() => void) | undefined;
  let provider: HealthProbe | undefined;
  try {
    try {
      release = acquireGatewayLease(config.database.path);
      checks.runtime = { state: "stopped" };
    } catch (error) {
      checks.runtime = {
        state:
          error instanceof DatabaseError && error.reason === "gateway_busy"
            ? "busy"
            : "unavailable",
      };
      return report;
    }
    try {
      if (
        !lstatSync(config.browser.profileDir).isDirectory() ||
        !lstatSync(join(config.browser.profileDir, "gateway-profile.json")).isFile()
      )
        throw new Error();
    } catch (error) {
      checks.provider =
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? { state: "not_checked", reason: "profile_not_initialized" }
          : { state: "unavailable", errorCode: "PROVIDER_UNAVAILABLE" };
      return report;
    }
    provider = dependencies.provider
      ? dependencies.provider(config.browser)
      : new ChatGptWebProvider(config.browser);
    const health = providerHealthSchema.parse(await provider.health());
    checks.provider = {
      state: health.state,
      ...(health.state === "unavailable" ? { errorCode: "PROVIDER_UNAVAILABLE" as const } : {}),
    };
  } catch {
    checks.provider = { state: "unavailable", errorCode: "PROVIDER_UNAVAILABLE" };
  } finally {
    try {
      try {
        await provider?.close?.();
      } catch {
        checks.provider = {
          state: "unavailable",
          errorCode: "PROVIDER_UNAVAILABLE",
          reason: "provider_close_failed",
        };
      }
    } finally {
      release?.();
    }
  }
  return {
    ...report,
    readyToStart:
      checks.telegram.state === "ready" &&
      checks.provider.state === "ready" &&
      checks.database.blockedRequests === 0,
  };
}
