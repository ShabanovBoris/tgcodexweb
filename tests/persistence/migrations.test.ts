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

// Каждый тест владеет отдельной файловой БД и fixtures, независимо от production migrations.
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
  test("empty R0 migration directory creates only the ledger", () => {
    expect(migrateDatabase(database, directory)).toBe(0);
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

  test("rejects a renumbered applied migration", () => {
    addMigration("0001_probe.sql");
    migrateDatabase(database, directory);
    copyFileSync(join(directory, "0001_probe.sql"), join(directory, "0002_probe.sql"));
    writeFileSync(join(directory, "0001_probe.sql"), "SELECT 1;\n");
    expect(() => migrateDatabase(database, directory)).toThrow(DatabaseError);
  });

  test.each([{ names: ["0002_gap.sql"] }, { names: ["0001_probe.sql", "0003_gap.sql"] }])(
    "rejects noncontiguous versions before SQL: %j",
    ({ names }) => {
      for (const name of names) writeFileSync(join(directory, name), "CREATE TABLE gap(id);\n");
      expect(() => migrateDatabase(database, directory)).toThrow(DatabaseError);
      expect(database.query("SELECT name FROM sqlite_master").all()).toEqual([]);
    },
  );

  test.each([false, true])(
    "preflights COMMIT across all pending files (initialized=%s)",
    (initialized) => {
      if (initialized) {
        addMigration("0001_probe.sql");
        migrateDatabase(database, directory);
      }
      const schema = database.query("SELECT * FROM sqlite_master ORDER BY name").all();
      const ledger = initialized ? database.query("SELECT * FROM schema_migrations").all() : [];
      writeFileSync(
        join(directory, initialized ? "0002_partial.sql" : "0001_partial.sql"),
        "CREATE TABLE partial(id); INSERT INTO partial VALUES(1);",
      );
      writeFileSync(
        join(directory, initialized ? "0003_commit.sql" : "0002_commit.sql"),
        "COMMIT;",
      );
      expect(() => migrateDatabase(database, directory)).toThrow(DatabaseError);
      expect(database.query("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(schema);
      if (initialized) {
        expect(database.query("SELECT * FROM schema_migrations").all()).toEqual(ledger);
        expect(database.query("SELECT * FROM r0_probe").all()).toEqual([
          { id: 1, value: "fixture-persisted-value" },
        ]);
      }
    },
  );

  test.each(["version", "name", "checksum"])(
    "rejects altered applied ledger %s without rewriting it",
    (field) => {
      addMigration("0001_probe.sql");
      migrateDatabase(database, directory);
      database.run(`UPDATE schema_migrations SET ${field}=?`, [
        field === "version" ? 2 : "changed",
      ]);
      const ledger = database.query("SELECT * FROM schema_migrations").all();
      expect(() => migrateDatabase(database, directory)).toThrow(DatabaseError);
      expect(database.query("SELECT * FROM schema_migrations").all()).toEqual(ledger);
      expect(database.query("SELECT * FROM r0_probe").all()).toEqual([
        { id: 1, value: "fixture-persisted-value" },
      ]);
    },
  );

  for (const initialized of [false, true]) {
    test.each([
      "COMMIT",
      "/* boundary */ cOmMiT TRANSACTION",
      "END TRANSACTION",
      "BEGIN IMMEDIATE",
      "ROLLBACK",
      "SAVEPOINT probe",
      "RELEASE probe",
      "VACUUM",
      "PRAGMA foreign_keys=OFF",
      "PRAGMA main.journal_mode=OFF",
      "EXPLAIN PRAGMA writable_schema=ON",
      "ATTACH ':memory:' AS other",
      "DETACH other",
      "CREATE TRIGGER probe AFTER INSERT ON r0_probe BEGIN SELECT 1; END",
      "SELECT 1;\0 COMMIT",
      "SELECT 'unclosed",
      "SELECT 1; /* unclosed",
    ])(
      `rejects unsafe SQL preserving schema/data/ledger (initialized=${initialized}): %s`,
      (sql) => {
        if (initialized) {
          addMigration("0001_probe.sql");
          migrateDatabase(database, directory);
        }
        const schema = database.query("SELECT * FROM sqlite_master ORDER BY name").all();
        const ledger = initialized ? database.query("SELECT * FROM schema_migrations").all() : [];
        writeFileSync(
          join(directory, initialized ? "0002_unsafe.sql" : "0001_unsafe.sql"),
          `CREATE TABLE partial(id); INSERT INTO partial VALUES(1); ${sql};`,
        );
        expect(() => migrateDatabase(database, directory)).toThrow(DatabaseError);
        expect(database.query("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(schema);
        if (initialized) {
          expect(database.query("SELECT * FROM schema_migrations").all()).toEqual(ledger);
          expect(database.query("SELECT * FROM r0_probe").all()).toEqual([
            { id: 1, value: "fixture-persisted-value" },
          ]);
        }
        expect(database.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
        expect(database.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      },
    );
  }

  test("quoted control words, semicolons, escaped quotes and comments are ordinary SQL data", () => {
    writeFileSync(
      join(directory, "0001_lexical.sql"),
      `
      -- COMMIT;\n /* PRAGMA; */ CREATE TABLE "commit;" ([pragma;] TEXT, \`rollback;\` TEXT);
      INSERT INTO "commit;" VALUES ('it''s; COMMIT; -- /*', 'VACUUM;');
      SELECT CASE WHEN 1 THEN 'END' END;
    `,
    );
    expect(migrateDatabase(database, directory)).toBe(1);
    expect(database.query('SELECT * FROM "commit;"').all()).toEqual([
      { "pragma;": "it's; COMMIT; -- /*", "rollback;": "VACUUM;" },
    ]);
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
