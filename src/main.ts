import { type Environment, loadConfig } from "./config/Config";
import { createLogger } from "./logging/logger";
import { openDatabase } from "./persistence/sqlite/Database";
import { migrateDatabase } from "./persistence/sqlite/migrations";

// R0 composition root проверяет локальные prerequisites; внешний transport/provider ещё отсутствует.
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
