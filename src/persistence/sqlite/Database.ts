import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Persistence владеет ошибкой; CLI получает только стабильный reason, не SQL или filesystem message.
export class DatabaseError extends Error {
  readonly code = "DATABASE_ERROR";

  constructor(
    readonly reason:
      | "initialization_failed"
      | "migration_files_invalid"
      | "migration_history_changed"
      | "repository_failed"
      | "unique_conflict"
      | "foreign_key_violation"
      | "constraint_violation"
      | "entity_not_found"
      | "invalid_selection"
      | "invalid_request_input"
      | "migration_failed",
    cause?: unknown,
  ) {
    super("DATABASE_ERROR", { cause });
    this.name = "DatabaseError";
  }
}

// Настройки принадлежат connection lifecycle, поэтому foreign keys включаются при каждом открытии.
export function openDatabase(path: string): Database {
  let database: Database | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    database = new Database(path, { create: true, strict: true });
    database.run("PRAGMA foreign_keys = ON");
    database.run("PRAGMA journal_mode = WAL");
    database.run("PRAGMA synchronous = FULL");
    database.run("PRAGMA busy_timeout = 5000");
    return database;
  } catch (cause) {
    database?.close(true);
    throw new DatabaseError("initialization_failed", cause);
  }
}
