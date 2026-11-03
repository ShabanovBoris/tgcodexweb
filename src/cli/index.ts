import { checkToolchain, ToolchainError } from "../../scripts/check-toolchain";
import {
  ConfigError,
  type Environment,
  loadConfig,
  loadDatabaseConfig,
  loadBrowserConfig,
} from "../config/Config";
import { createLogger } from "../logging/logger";
import { bootstrap, recoverUnknown, startFakeGateway, startGateway } from "../main";
import { ChatGptWebProvider } from "../providers/chatgpt-web/ChatGptWebProvider";
import { ProviderOperationError } from "../ports/ChatProvider";
import { DatabaseError, openDatabase } from "../persistence/sqlite/Database";
import { migrateDatabase } from "../persistence/sqlite/migrations";
import { TelegramError } from "../transports/telegram/TelegramApi";
import { doctor } from "../runtime/Doctor";

// Restart only classified reads with no server wait. Exhausted flood minima stay stopped, since a new process must not truncate them.
export function canRestartService(error: unknown): boolean {
  if (
    !(error instanceof TelegramError) ||
    error.code !== "TELEGRAM_UNAVAILABLE" ||
    error.deliveryRetryAfterMs !== undefined
  )
    return false;
  const hints = [error.pollingRetryAfterMs, error.identityRetryAfterMs].filter(
    (value) => value !== undefined,
  );
  return hints.length === 1 && hints[0] === 0;
}

// CLI владеет exit code и safe receipt; raw exceptions не пересекают пользовательскую границу.
export async function runCli(
  args: readonly string[],
  env: Environment,
  cwd = process.cwd(),
  onFailure?: (restartable: boolean) => void,
): Promise<number> {
  const log = createLogger({ knownSecrets: [env.TELEGRAM_BOT_TOKEN?.trim() ?? ""] });
  try {
    checkToolchain();
    const recoveryCommand =
      args[0] === "recover:unknown" &&
      args.length === 3 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(args[1]) &&
      args[2] === "--confirm-completed";
    if (
      (args[0] === "recover:unknown" && !recoveryCommand) ||
      (args.length !== 1 &&
        !recoveryCommand &&
        !(
          args.length === 2 &&
          (args[0] === "start:fake" || args[0] === "start") &&
          args[1] === "--private"
        ))
    ) {
      log("error", {
        operation: "cli.failed",
        errorCode: "CLI_ERROR",
        reason: "unsupported_command",
      });
      return 1;
    }
    switch (args[0]) {
      case "doctor": {
        const report = await doctor(env, cwd);
        process.stdout.write(`${JSON.stringify(report)}\n`);
        return report.readyToStart ? 0 : 1;
      }
      case "recover:unknown": {
        const resolution = recoverUnknown(env, args[1], cwd);
        log("info", {
          operation: "request.unknown_resolved",
          requestId: resolution.requestId,
          requestState: "unknown",
          reason: resolution.resolution,
        });
        return 0;
      }
      case "bootstrap":
        bootstrap(env, cwd);
        return 0;
      case "start":
      case "start:fake": {
        loadConfig(env, cwd);
        if (args[1] !== "--private") {
          log("error", {
            operation: "cli.failed",
            errorCode: "CLI_ERROR",
            reason: "explicit_private_chat_opt_in_required",
          });
          return 1;
        }
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        try {
          await (args[0] === "start" ? startGateway : startFakeGateway)(
            env,
            controller.signal,
            cwd,
          );
        } finally {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
        }
        return 0;
      }
      case "provider:health": {
        const provider = new ChatGptWebProvider(loadBrowserConfig(env, cwd));
        try {
          const health = await provider.health();
          log("info", { operation: "provider.health", providerState: health.state });
          return health.state === "ready" ? 0 : 1;
        } finally {
          await provider.close();
        }
      }
      case "browser:login": {
        const config = loadBrowserConfig(env, cwd);
        if (!process.stdin.isTTY) {
          log("error", {
            operation: "cli.failed",
            errorCode: "CLI_ERROR",
            reason: "interactive_login_requires_terminal",
          });
          return 1;
        }
        const provider = new ChatGptWebProvider({ ...config, headless: false });
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        try {
          process.stdout.write(
            "Sign in to ChatGPT in the dedicated Chrome window, confirm the composer, then quit that Chrome instance completely.\n",
          );
          await provider.login(controller.signal);
          const health = await provider.health();
          log("info", { operation: "browser.login_checked", providerState: health.state });
          return health.state === "ready" ? 0 : 1;
        } catch (error) {
          if (controller.signal.aborted) return 0;
          throw error;
        } finally {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          await provider.close();
        }
      }
      case "config:check":
        loadConfig(env, cwd);
        log("info", { operation: "config.valid" });
        return 0;
      case "db:migrate": {
        const config = loadDatabaseConfig(env, cwd);
        const database = openDatabase(config.path);
        try {
          migrateDatabase(database);
          log("info", { operation: "database.migrated" });
        } finally {
          database.close(true);
        }
        return 0;
      }
      default:
        log("error", {
          operation: "cli.failed",
          errorCode: "CLI_ERROR",
          reason: "unsupported_command",
        });
        return 1;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      log("error", { operation: "cli.failed", errorCode: error.code, issues: error.issues });
    } else if (error instanceof DatabaseError || error instanceof ToolchainError) {
      log("error", { operation: "cli.failed", errorCode: error.code, reason: error.reason });
    } else if (error instanceof TelegramError || error instanceof ProviderOperationError) {
      log("error", { operation: "cli.failed", errorCode: error.code });
    } else {
      log("error", { operation: "cli.failed", errorCode: "INTERNAL_ERROR" });
    }
    onFailure?.(canRestartService(error));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2), process.env);
