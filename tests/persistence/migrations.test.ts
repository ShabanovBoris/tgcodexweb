import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseError, openDatabase } from "../../src/persistence/sqlite/Database";
import { migrateDatabase } from "../../src/persistence/sqlite/migrations";

const fixtures = resolve(import.meta.dir, "../fixtures/migrations");
let root: string;
let directory: string;
let database: Database;

// Каждый тест владеет отдельной файловой БД и fixtures; production schema остаётся только ledger.
function addMigration(name: string): void {
  copyFileSync(join(fixtures, name), join(directory, name));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tgcodexweb-r0-migrations-"));
  directory = join(root, "migrations");
  mkdirSync(directory);
  database = openDatabase(join(root, "data", "gateway.sqlite"));
});

afterEach(() => {
  database.close(true);
  rmSync(root, { recursive: true, force: true });
});

describe("SQLite migrations", () => {
  test("fresh production database contains only the empty migration ledger", () => {
    expect(migrateDatabase(database)).toBe(0);
    expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
      { name: "schema_migrations" },
    ]);
    expect(database.query("SELECT * FROM schema_migrations").all()).toEqual([]);
  });

  test("applies SQL with its checksum and does not apply it twice", () => {
    addMigration("0001_probe.sql");
    expect(migrateDatabase(database, directory)).toBe(1);
    const ledger = database.query("SELECT * FROM schema_migrations").all();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ version: 1, name: "0001_probe.sql" });
    expect(ledger[0]).toHaveProperty(
      "checksum",
      new Bun.CryptoHasher("sha256")
        .update(readFileSync(join(directory, "0001_probe.sql")))
        .digest("hex"),
    );
    expect(migrateDatabase(database, directory)).toBe(0);
    expect(database.query("SELECT * FROM schema_migrations").all()).toEqual(ledger);
    expect(database.query("SELECT * FROM r0_probe").all()).toEqual([
      { id: 1, value: "fixture-persisted-value" },
    ]);
  });

  test("upgrades a reopened database without losing earlier data", () => {
    addMigration("0001_probe.sql");
    migrateDatabase(database, directory);
    database.close(true);
    database = openDatabase(join(root, "data", "gateway.sqlite"));
    addMigration("0002_probe_upgrade.sql");
    expect(migrateDatabase(database, directory)).toBe(1);
    expect(database.query("SELECT * FROM r0_probe").all()).toEqual([
      { id: 1, value: "fixture-persisted-value", upgraded: 1 },
    ]);
    database.close(true);
    database = openDatabase(join(root, "data", "gateway.sqlite"));
    expect(migrateDatabase(database, directory)).toBe(0);
    expect(database.query("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
    ]);
  });

  test("failure on fresh database rolls back schema, data and ledger", () => {
    addMigration("0001_probe.sql");
    addMigration("0002_probe_upgrade.sql");
    addMigration("0003_probe_failure.sql");
    expect(() => migrateDatabase(database, directory)).toThrow(DatabaseError);
    expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
  });

  test("failed upgrade preserves applied history and rolls back all pending migrations", () => {
    addMigration("0001_probe.sql");
    migrateDatabase(database, directory);
    const ledger = database.query("SELECT * FROM schema_migrations").all();
    addMigration("0002_probe_upgrade.sql");
    addMigration("0003_probe_failure.sql");
    expect(() => migrateDatabase(database, directory)).toThrow(DatabaseError);
    expect(database.query("SELECT * FROM schema_migrations").all()).toEqual(ledger);
    expect(database.query("SELECT * FROM r0_probe").all()).toEqual([
      { id: 1, value: "fixture-persisted-value" },
    ]);
    expect(
      database.query("SELECT name FROM sqlite_master WHERE name = 'r0_failed_probe'").all(),
    ).toEqual([]);
  });

  test.each(["change", "remove", "rename"])("rejects %s of applied SQL", (operation) => {
    addMigration("0001_probe.sql");
    migrateDatabase(database, directory);
    const original = join(directory, "0001_probe.sql");
    if (operation === "change") writeFileSync(original, "SELECT 1;\n");
    else {
      if (operation === "rename") copyFileSync(original, join(directory, "0001_renamed.sql"));
      unlinkSync(original);
    }
    expect(() => migrateDatabase(database, directory)).toThrow(DatabaseError);
    expect(database.query("SELECT * FROM r0_probe").all()).toEqual([
      { id: 1, value: "fixture-persisted-value" },
    ]);
  });

  test("rejects a new migration inserted before applied history", () => {
    copyFileSync(join(fixtures, "0001_probe.sql"), join(directory, "0002_probe.sql"));
    migrateDatabase(database, directory);
    writeFileSync(join(directory, "0001_inserted.sql"), "SELECT 1;\n");
    expect(() => migrateDatabase(database, directory)).toThrow(DatabaseError);
  });

  test.each(["invalid.sql", "0000_zero.sql", "0001_Uppercase.sql"])(
    "rejects malformed SQL file name: %s",
    (name) => {
      writeFileSync(join(directory, name), "SELECT 1;\n");
      expect(() => migrateDatabase(database, directory)).toThrow(DatabaseError);
      expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual(
        [],
      );
    },
  );

  test("rejects duplicate migration versions", () => {
    addMigration("0001_probe.sql");
    writeFileSync(join(directory, "0001_duplicate.sql"), "SELECT 1;\n");
    expect(() => migrateDatabase(database, directory)).toThrow(DatabaseError);
  });

  test("ledger enforces unique version and name", () => {
    addMigration("0001_probe.sql");
    migrateDatabase(database, directory);
    expect(() =>
      database.run("INSERT INTO schema_migrations SELECT * FROM schema_migrations"),
    ).toThrow();
    expect(() =>
      database.run(
        "INSERT INTO schema_migrations SELECT 2, name, checksum, applied_at FROM schema_migrations",
      ),
    ).toThrow();
  });

  test("connection pragmas and strict binding remain enabled after reopen", () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(database.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(database.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(database.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
      expect(database.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
      expect(() => database.query("SELECT $required").get({ wrong: "fixture" })).toThrow();
      if (attempt === 0) {
        database.run("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
        database.run("CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))");
      }
      expect(() => database.run("INSERT INTO child (parent_id) VALUES (999)")).toThrow();
      database.close(true);
      database = openDatabase(join(root, "data", "gateway.sqlite"));
    }
  });
});
