import { checkToolchain, ToolchainError } from "../../scripts/check-toolchain";
import { ConfigError, type Environment, loadConfig, loadDatabaseConfig } from "../config/Config";
import { createLogger } from "../logging/logger";
import { bootstrap } from "../main";
import { DatabaseError, openDatabase } from "../persistence/sqlite/Database";
import { migrateDatabase } from "../persistence/sqlite/migrations";

// CLI владеет exit code и safe receipt; raw exceptions не пересекают пользовательскую границу.
export function runCli(args: readonly string[], env: Environment, cwd = process.cwd()): number {
  const log = createLogger({ knownSecrets: [env.TELEGRAM_BOT_TOKEN?.trim() ?? ""] });
  try {
    checkToolchain();
    if (args.length !== 1) {
      log("error", {
        operation: "cli.failed",
        errorCode: "CLI_ERROR",
        reason: "unsupported_command",
      });
      return 1;
    }
    switch (args[0]) {
      case "start":
        bootstrap(env, cwd);
        return 0;
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
    } else {
      log("error", { operation: "cli.failed", errorCode: "INTERNAL_ERROR" });
    }
    return 1;
  }
}

if (import.meta.main) process.exitCode = runCli(process.argv.slice(2), process.env);
