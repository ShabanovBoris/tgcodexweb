import { checkToolchain, ToolchainError } from "../../scripts/check-toolchain";
import { ConfigError, type Environment, loadConfig, loadDatabaseConfig } from "../config/Config";
import { createLogger } from "../logging/logger";
import { bootstrap, startFakeGateway } from "../main";
import { DatabaseError, openDatabase } from "../persistence/sqlite/Database";
import { migrateDatabase } from "../persistence/sqlite/migrations";
import { TelegramError } from "../transports/telegram/TelegramApi";

// CLI владеет exit code и safe receipt; raw exceptions не пересекают пользовательскую границу.
export async function runCli(
  args: readonly string[],
  env: Environment,
  cwd = process.cwd(),
): Promise<number> {
  const log = createLogger({ knownSecrets: [env.TELEGRAM_BOT_TOKEN?.trim() ?? ""] });
  try {
    checkToolchain();
    if (
      args.length !== 1 &&
      !(args.length === 2 && args[0] === "start:fake" && args[1] === "--private")
    ) {
      log("error", {
        operation: "cli.failed",
        errorCode: "CLI_ERROR",
        reason: "unsupported_command",
      });
      return 1;
    }
    switch (args[0]) {
      case "start":
        loadConfig(env, cwd);
        log("error", {
          operation: "cli.failed",
          errorCode: "PROVIDER_UNAVAILABLE",
          reason: "adapter_not_implemented",
        });
        return 1;
      case "bootstrap":
        bootstrap(env, cwd);
        return 0;
      case "start:fake": {
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
          await startFakeGateway(env, controller.signal, cwd);
        } finally {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
        }
        return 0;
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
    } else if (error instanceof TelegramError) {
      log("error", { operation: "cli.failed", errorCode: error.code });
    } else {
      log("error", { operation: "cli.failed", errorCode: "INTERNAL_ERROR" });
    }
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2), process.env);
