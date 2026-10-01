import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseError } from "./Database";

type Migration = Readonly<{ version: number; name: string; checksum: string; sql: string }>;
type AppliedMigration = Readonly<{ version: number; name: string; checksum: string }>;
const productionDirectory = join(import.meta.dir, "migrations");

// Bun 1.4.0 не предоставляет authorizer: проверяем лексические границы до любого SQL.
// Поддерживаем обычные DDL/DML, но не trigger bodies, transaction control или connection commands.
function validateMigrationSql(sql: string): void {
  if (sql.includes("\0")) throw new DatabaseError("migration_files_invalid");
  const allowed = new Set([
    "CREATE",
    "ALTER",
    "DROP",
    "INSERT",
    "UPDATE",
    "DELETE",
    "SELECT",
    "WITH",
    "REPLACE",
  ]);
  const forbidden = new Set([
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT",
    "RELEASE",
    "TRANSACTION",
    "VACUUM",
    "PRAGMA",
    "ATTACH",
    "DETACH",
    "TRIGGER",
  ]);
  let statementStart = true;
  for (let index = 0; index < sql.length; ) {
    const char = sql[index];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index + 2);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) throw new DatabaseError("migration_files_invalid");
      index = end + 2;
      continue;
    }
    if (char === ";") {
      statementStart = true;
      index++;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(index))?.[0];
    if (statementStart && (!word || !allowed.has(word.toUpperCase()))) {
      throw new DatabaseError("migration_files_invalid");
    }
    statementStart = false;
    if (word) {
      if (forbidden.has(word.toUpperCase())) throw new DatabaseError("migration_files_invalid");
      index += word.length;
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const closing = char === "[" ? "]" : char;
      let closed = false;
      for (index++; index < sql.length; index++) {
        if (sql[index] !== closing) continue;
        if (char !== "[" && sql[index + 1] === closing) {
          index++;
          continue;
        }
        index++;
        closed = true;
        break;
      }
      if (!closed) throw new DatabaseError("migration_files_invalid");
      continue;
    }
    index++;
  }
}

// SQL bytes и порядок фиксируются до transaction: checksum описывает именно исполненный файл.
function readMigrations(directory: string): Migration[] {
  const versions = new Set<number>();
  const migrations = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".sql"))
    .map((entry) => {
      const match = /^([0-9]{4})_[a-z0-9_]+\.sql$/.exec(entry.name);
      const version = match ? Number(match[1]) : 0;
      if (!entry.isFile() || version < 1 || versions.has(version)) {
        throw new DatabaseError("migration_files_invalid");
      }
      versions.add(version);
      const bytes = readFileSync(join(directory, entry.name));
      const sql = bytes.toString("utf8");
      validateMigrationSql(sql);
      return {
        version,
        name: entry.name,
        checksum: createHash("sha256").update(bytes).digest("hex"),
        sql,
      };
    })
    .sort((left, right) => left.version - right.version);
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1) throw new DatabaseError("migration_files_invalid");
  }
  return migrations;
}

// Schema и ledger изменяются атомарно: после сбоя нельзя считать частичный upgrade завершённым.
// Applied history обязан оставаться prefix файлов; исправления добавляются только новой migration.
export function migrateDatabase(database: Database, directory = productionDirectory): number {
  try {
    const migrations = readMigrations(directory);
    return database
      .transaction(() => {
        database.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`);
        const applied = database
          .query<AppliedMigration, []>(
            "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
          )
          .all();
        for (const [index, row] of applied.entries()) {
          const file = migrations[index];
          if (
            !file ||
            row.version !== file.version ||
            row.name !== file.name ||
            row.checksum !== file.checksum
          ) {
            throw new DatabaseError("migration_history_changed");
          }
        }
        const pending = migrations.slice(applied.length);
        for (const migration of pending) {
          database.run(migration.sql);
          database
            .query(
              "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
            )
            .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
        }
        return pending.length;
      })
      .immediate();
  } catch (cause) {
    if (cause instanceof DatabaseError) throw cause;
    throw new DatabaseError("migration_failed", cause);
  }
}
