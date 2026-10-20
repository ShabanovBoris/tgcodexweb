import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectDatabase } from "../../src/persistence/sqlite/DatabaseDiagnostics";
import { openDatabase } from "../../src/persistence/sqlite/Database";
import { migrateDatabase } from "../../src/persistence/sqlite/migrations";
import { QueueFixture, request, later } from "../fixtures/queue";

let f: QueueFixture;
beforeEach(() => {
  f = new QueueFixture();
});
afterEach(() => f.close());

test("doctor does not create a missing database or its parent directory", () => {
  const before = readdirSync(f.root);
  expect(inspectDatabase(join(f.root, "missing", "gateway.sqlite"))).toEqual({ state: "missing" });
  expect(readdirSync(f.root)).toEqual(before);
});

test("read-only database diagnostics preserve UNKNOWN, dedup and queued input", () => {
  f.store.accept(request("blocked", "1"), { text: "private prompt", attachments: [] }, 3);
  f.store.claim("blocked", later);
  f.requests.transition("blocked", { state: "unknown", at: later });
  f.store.accept(request("successor", "2"), { text: "private successor", attachments: [] }, 3);
  const before = f.database.serialize();
  expect(inspectDatabase(f.path)).toEqual({
    state: "ready",
    appliedMigrations: 7,
    pendingMigrations: 0,
    queuedRequests: 1,
    blockedRequests: 1,
    pendingDeliveries: 0,
    failedDeliveries: 0,
    expiredDeliveries: 0,
  });
  expect(f.database.serialize()).toEqual(before);
  expect(f.requests.get("blocked")?.state).toBe("unknown");
  expect(f.updates.get("1")?.requestId).toBe("blocked");
  expect(f.store.snapshot().queued[0].input.text).toBe("private successor");
  expect(JSON.stringify(inspectDatabase(f.path))).not.toContain("private");
});

test("doctor reports pending migrations without applying them to a populated old database", () => {
  const directory = join(f.root, "old-migrations");
  mkdirSync(directory);
  copyFileSync(
    join(import.meta.dir, "../../src/persistence/sqlite/migrations/0001_domain.sql"),
    join(directory, "0001_domain.sql"),
  );
  const path = join(f.root, "old.sqlite");
  const database = openDatabase(path);
  try {
    migrateDatabase(database, directory);
    database
      .query("INSERT INTO users (telegram_user_id,enabled,created_at) VALUES ('789',1,?)")
      .run(later);
    const before = database.serialize();
    expect(inspectDatabase(path)).toEqual({
      state: "migration_required",
      appliedMigrations: 1,
      pendingMigrations: 6,
    });
    expect(database.serialize()).toEqual(before);
    expect(database.query("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({
      count: 1,
    });
  } finally {
    database.close(true);
  }
});

test("empty existing SQLite is diagnosed without creating a migration ledger", () => {
  const path = join(f.root, "empty.sqlite");
  const database = new Database(path, { create: true });
  database.close();
  const before = readFileSync(path);
  expect(inspectDatabase(path)).toEqual({
    state: "migration_required",
    appliedMigrations: 0,
    pendingMigrations: 7,
  });
  expect(readFileSync(path)).toEqual(before);
});

test("changed applied history is unavailable and never repaired by diagnostics", () => {
  f.database.run("UPDATE schema_migrations SET checksum='private corruption' WHERE version=1");
  const before = f.database.serialize();
  expect(inspectDatabase(f.path)).toEqual({
    state: "unavailable",
    errorCode: "DATABASE_ERROR",
    reason: "migration_history_changed",
  });
  expect(f.database.serialize()).toEqual(before);
});

test("foreign key violations and malformed files return only fixed safe diagnostics", () => {
  f.database.run("PRAGMA foreign_keys=OFF");
  f.database.run("DELETE FROM users");
  expect(inspectDatabase(f.path)).toEqual({
    state: "unavailable",
    errorCode: "DATABASE_ERROR",
    reason: "integrity_check_failed",
  });
  const malformed = join(f.root, "private.sqlite");
  writeFileSync(malformed, "private browser cookie and filesystem details");
  const result = inspectDatabase(malformed);
  expect(result.state).toBe("unavailable");
  expect(JSON.stringify(result)).not.toContain("private");
  expect(readFileSync(malformed, "utf8")).toContain("private browser cookie");
});
