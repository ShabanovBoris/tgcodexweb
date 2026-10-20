import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RequestService } from "../../src/application/RequestService";
import { openDatabase } from "../../src/persistence/sqlite/Database";
import { migrateDatabase } from "../../src/persistence/sqlite/migrations";
import { SqliteUnknownRecoveryRepository } from "../../src/persistence/sqlite/SqliteUnknownRecoveryRepository";
import { FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
import { at, later, QueueFixture, request } from "../fixtures/queue";

let f: QueueFixture;
beforeEach(() => {
  f = new QueueFixture();
});
afterEach(() => f.close());

function unknown(id = "r1", update = "1", conversation = "c1") {
  f.store.accept(
    request(id, update, conversation),
    { text: "private original", attachments: [] },
    3,
  );
  f.store.claim(id, later);
  f.requests.transition(id, { state: "unknown", at: later });
}

test("operator completion preserves UNKNOWN/dedup and resumes only queued successors once after restart", async () => {
  unknown();
  f.store.accept(request("z", "2", "alias"), { text: "first pending", attachments: [] }, 3);
  f.store.accept(request("a", "3"), { text: "second pending", attachments: [] }, 3);
  const original = f.requests.get("r1");
  const pending = f.database.query("SELECT * FROM request_inputs ORDER BY sequence").all();
  const markers = f.database
    .query("SELECT * FROM processed_updates ORDER BY telegram_update_id")
    .all();
  const recovery = new SqliteUnknownRecoveryRepository(f.database);
  expect(f.store.snapshot().blocked).toHaveLength(1);
  const receipt = recovery.confirmCompleted("r1", later);
  expect(receipt).toEqual({
    requestId: "r1",
    providerConversationId: "remote",
    confirmedAt: later,
    resolution: "operator_confirmed_completed",
  });
  expect(recovery.confirmCompleted("r1", "2026-10-01T00:01:00.000Z")).toEqual(receipt);
  expect(f.requests.get("r1")).toEqual(original);
  expect(f.database.query("SELECT * FROM request_inputs ORDER BY sequence").all()).toEqual(pending);
  expect(
    f.database.query("SELECT * FROM processed_updates ORDER BY telegram_update_id").all(),
  ).toEqual(markers);
  f.reopen();
  expect(f.store.snapshot().blocked).toEqual([]);
  const run = async () => {
    const provider = new FakeChatProvider({
      capabilities: { maxConcurrentConversations: 1, fileUpload: true, cancellation: false },
    });
    const service = new RequestService({
      queueRepository: f.store,
      requests: f.requests,
      provider,
      options: { maxPendingPerConversation: 3, generationTimeoutMs: 60000 },
      now: () => later,
      onResult: () => {},
    });
    await service.start();
    await service.waitForIdle();
    await service.shutdown();
    return provider;
  };
  expect((await run()).sendCalls).toEqual(["z", "a"]);
  expect(f.requests.get("r1")).toEqual(original);
  f.reopen();
  expect((await run()).sendCalls).toEqual([]);
  expect(
    f.store.accept(request("duplicate", "1"), { text: "changed", attachments: [] }, 3).kind,
  ).toBe("duplicate");
});

test("confirmation releases only its exact request and canonical key", () => {
  unknown();
  f.requests.create(request("second", "2", "alias"));
  for (const state of ["queued", "sending", "unknown"] as const)
    f.requests.transition("second", { state, at: later });
  new SqliteUnknownRecoveryRepository(f.database).confirmCompleted("r1", later);
  expect(f.store.snapshot().blocked.map((row) => row.requestId)).toEqual(["second"]);
  f.database.run("UPDATE request_unknown_resolutions SET provider_conversation_id='foreign'");
  expect(f.store.snapshot().blocked.map((row) => row.requestId)).toEqual(["r1", "second"]);
});

test.each(["queued", "sending", "running", "completed", "failed"] as const)(
  "cannot confirm %s as an UNKNOWN completion",
  (state) => {
    f.store.accept(request(), { text: "private pending", attachments: [] }, 3);
    if (state !== "queued") f.store.claim("r1", later);
    if (state === "running" || state === "completed")
      f.requests.transition("r1", { state: "running", at: later, providerRequestId: "turn" });
    if (state === "completed") f.requests.transition("r1", { state, at: later });
    if (state === "failed")
      f.requests.transition("r1", { state, at: later, failureCode: "SEND_FAILED_PRE_SUBMIT" });
    const before = f.requests.get("r1");
    expect(() =>
      new SqliteUnknownRecoveryRepository(f.database).confirmCompleted("r1", later),
    ).toThrow();
    expect(f.requests.get("r1")).toEqual(before);
    expect(f.database.query("SELECT * FROM request_unknown_resolutions").all()).toEqual([]);
  },
);

test("missing/stale/invalid confirmations and a failed audit write leave the key blocked", () => {
  unknown();
  const recovery = new SqliteUnknownRecoveryRepository(f.database);
  for (const [id, time] of [
    ["missing", later],
    ["r1", at],
    ["r1", "invalid"],
  ])
    expect(() => recovery.confirmCompleted(id, time)).toThrow();
  f.database.exec(
    "CREATE TRIGGER reject_resolution AFTER INSERT ON request_unknown_resolutions BEGIN SELECT RAISE(ABORT, 'private failure'); END",
  );
  expect(() => recovery.confirmCompleted("r1", later)).toThrow("DATABASE_ERROR");
  f.reopen();
  expect(f.store.snapshot().blocked).toHaveLength(1);
  expect(f.database.query("SELECT * FROM request_unknown_resolutions").all()).toEqual([]);
});

test("fresh schema enforces audit identity, outcome and request FK", () => {
  unknown();
  const insert = f.database.query("INSERT INTO request_unknown_resolutions VALUES (?, ?, ?, ?)");
  expect(() => insert.run("missing", "remote", later, "operator_confirmed_completed")).toThrow();
  expect(() => insert.run("r1", "remote", later, "retry")).toThrow();
  expect(() => insert.run("r1", "", later, "operator_confirmed_completed")).toThrow();
  insert.run("r1", "remote", later, "operator_confirmed_completed");
  expect(() => insert.run("r1", "remote", later, "operator_confirmed_completed")).toThrow();
  expect(f.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("0006 upgrades populated 0005 atomically and preserves previous rows/ledger through failure and restart", () => {
  const directory = join(f.root, "migrations");
  mkdirSync(directory);
  const production = resolve(import.meta.dir, "../../src/persistence/sqlite/migrations");
  for (const name of readdirSync(production).filter((name) => /^000[1-5]_.*\.sql$/.test(name)))
    copyFileSync(join(production, name), join(directory, name));
  const path = join(f.root, "legacy.sqlite");
  let database = openDatabase(path);
  try {
    expect(migrateDatabase(database, directory)).toBe(5);
    database.run("INSERT INTO users VALUES ('123',1,?)", [at]);
    const rows = database.query("SELECT * FROM users").all();
    const ledger = database.query("SELECT * FROM schema_migrations ORDER BY version").all();
    copyFileSync(
      join(production, "0006_unknown_resolutions.sql"),
      join(directory, "0006_unknown_resolutions.sql"),
    );
    writeFileSync(join(directory, "0007_failure.sql"), "INSERT INTO missing VALUES(1);");
    expect(() => migrateDatabase(database, directory)).toThrow();
    expect(database.query("SELECT * FROM users").all()).toEqual(rows);
    expect(database.query("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(
      ledger,
    );
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE name='request_unknown_resolutions'")
        .all(),
    ).toEqual([]);
    expect(migrateDatabase(database)).toBe(1);
    database.close(true);
    database = openDatabase(path);
    expect(migrateDatabase(database)).toBe(0);
    expect(database.query("SELECT * FROM users").all()).toEqual(rows);
    expect(
      database.query("SELECT * FROM schema_migrations WHERE version<=5 ORDER BY version").all(),
    ).toEqual(ledger);
    expect(database.query("SELECT * FROM request_unknown_resolutions").all()).toEqual([]);
  } finally {
    database.close(true);
  }
});
