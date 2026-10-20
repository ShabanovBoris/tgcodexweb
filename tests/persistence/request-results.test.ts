import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../src/persistence/sqlite/Database";
import { migrateDatabase } from "../../src/persistence/sqlite/migrations";
import { SqliteRequestResultRepository } from "../../src/persistence/sqlite/SqliteRequestResultRepository";
import { QueueFixture, request, later } from "../fixtures/queue";

let f: QueueFixture;
let results: SqliteRequestResultRepository;
beforeEach(() => {
  f = new QueueFixture();
  results = new SqliteRequestResultRepository(f.database);
});
afterEach(() => f.close());
function running() {
  f.store.accept(request(), { text: "private input", attachments: [] }, 3);
  f.store.claim("r1", later);
  f.requests.transition("r1", { state: "running", at: later, providerRequestId: "provider-r1" });
}
function settled() {
  running();
  return results.settle(
    "r1",
    { state: "completed", at: later },
    { message: { text: "private answer" } },
  );
}
const after = (milliseconds: number) => new Date(Date.parse(later) + milliseconds).toISOString();

test("completion and operational result commit atomically with input cleanup and unchanged dedup", () => {
  const result = settled();
  expect(result.request.state).toBe("completed");
  expect(results.due(later)).toEqual(["r1"]);
  expect(f.database.query("SELECT * FROM request_inputs").all()).toEqual([]);
  expect(f.updates.get("1")?.requestId).toBe("r1");
  expect(results.start("r1", later)?.result.message?.text).toBe("private answer");
  expect(results.diagnostics()[0]).toMatchObject({
    state: "pending",
    attempts: 1,
    nextChunk: 0,
    expiresAt: after(86400000),
  });
  expect(JSON.stringify(results.diagnostics())).not.toContain("private");
});

test("a failed outbox write rolls back terminal settlement and preserves original input", () => {
  running();
  f.database.run(
    "CREATE TRIGGER reject_result BEFORE INSERT ON request_deliveries BEGIN SELECT RAISE(ABORT,'private failure'); END",
  );
  expect(() =>
    results.settle(
      "r1",
      { state: "completed", at: later },
      { message: { text: "private answer" } },
    ),
  ).toThrow("DATABASE_ERROR");
  expect(f.requests.get("r1")?.state).toBe("running");
  expect(f.database.query("SELECT count(*) AS count FROM request_inputs").get()).toEqual({
    count: 1,
  });
  expect(results.diagnostics()).toEqual([]);
  expect(f.updates.get("1")?.requestId).toBe("r1");
});

test("equivalent ISO timestamps with different precision do not delay or reorder delivery", () => {
  running();
  const noMilliseconds = later.replace(".000", "");
  results.settle("r1", { state: "completed", at: noMilliseconds }, { message: { text: "answer" } });
  expect(results.due(later)).toEqual(["r1"]);
  const attempt = results.start("r1", noMilliseconds)!;
  expect(attempt.nextAttemptAt).toBe(later);
  results.fail("r1", attempt.attempts, noMilliseconds, after(1000).replace(".000", ""));
  expect(results.due(later)).toEqual([]);
  expect(results.due(after(1000))).toEqual(["r1"]);
  expect(results.diagnostics()[0].nextAttemptAt).toBe(after(1000));
});

test("render plan and confirmed chunk cursor survive restart; only an unconfirmed part is eligible", () => {
  settled();
  const first = results.start("r1", later)!;
  const plan = [
    { html: "first", plain: "first" },
    { html: "second", plain: "second" },
  ];
  results.savePlan("r1", first.attempts, plan);
  expect(() => results.savePlan("r1", first.attempts, plan)).toThrow("DATABASE_ERROR");
  expect(() => results.acknowledge("r1", first.attempts, 2)).toThrow("DATABASE_ERROR");
  results.acknowledge("r1", first.attempts, 1);
  results.fail("r1", first.attempts, later, after(1000));
  f.reopen();
  results = new SqliteRequestResultRepository(f.database);
  expect(results.start("r1", later)).toBeNull();
  const next = results.start("r1", after(1000))!;
  expect(next.nextChunk).toBe(1);
  expect(next.plan).toEqual(plan);
  expect(next.attempts).toBe(2);
  expect(() => results.acknowledge("r1", first.attempts, 2)).toThrow("DATABASE_ERROR");
  results.acknowledge("r1", next.attempts, 2);
  expect(() => results.acknowledge("r1", next.attempts, 3)).toThrow("DATABASE_ERROR");
  results.complete("r1", next.attempts, after(1000));
  expect(
    f.database.query("SELECT state,result_payload,plan FROM request_deliveries").get(),
  ).toEqual({ state: "delivered", result_payload: null, plan: null });
  expect(results.due(after(2000))).toEqual([]);
  expect(results.diagnostics()).toEqual([]);
  expect(f.requests.get("r1")?.state).toBe("completed");
});

test("crashed attempts consume the persisted budget and do not reset it on restart", () => {
  settled();
  for (let attempt = 1; attempt <= 6; attempt++) {
    expect(results.start("r1", later)?.attempts).toBe(attempt);
    f.reopen();
    results = new SqliteRequestResultRepository(f.database);
  }
  expect(results.start("r1", later)).toBeNull();
  expect(results.diagnostics()[0]).toMatchObject({
    state: "failed",
    attempts: 6,
    failureCode: "TELEGRAM_DELIVERY_FAILED",
  });
  expect(f.requests.get("r1")?.state).toBe("completed");
});

test.each([0, 86400000])(
  "a persisted final acknowledgement survives crash and the exhausted budget at +%sms",
  (elapsed) => {
    settled();
    for (let attempt = 1; attempt <= 6; attempt++)
      expect(results.start("r1", later)?.attempts).toBe(attempt);
    results.savePlan("r1", 6, [{ html: "answer", plain: "answer" }]);
    results.acknowledge("r1", 6, 1);
    f.reopen();
    results = new SqliteRequestResultRepository(f.database);
    expect(results.start("r1", after(elapsed))).toBeNull();
    expect(
      f.database.query("SELECT state,result_payload,plan FROM request_deliveries").get(),
    ).toEqual({ state: "delivered", result_payload: null, plan: null });
    expect(results.diagnostics()).toEqual([]);
  },
);

test.each(["pending", "failed"] as const)(
  "24h expiration purges %s payload/plan but retains delivery error and provider completion",
  (state) => {
    settled();
    const attempt = results.start("r1", later)!;
    results.savePlan("r1", attempt.attempts, [{ html: "private answer", plain: "private answer" }]);
    if (state === "failed") results.fail("r1", attempt.attempts, later);
    results.expire(after(86400000 - 1));
    expect(f.database.query("SELECT result_payload FROM request_deliveries").get()).not.toEqual({
      result_payload: null,
    });
    results.expire(after(86400000));
    expect(results.start("r1", after(86400000))).toBeNull();
    expect(
      f.database
        .query("SELECT state,result_payload,plan,failure_code FROM request_deliveries")
        .get(),
    ).toEqual({
      state: "expired",
      result_payload: null,
      plan: null,
      failure_code: "TELEGRAM_DELIVERY_EXPIRED",
    });
    expect(f.requests.get("r1")?.state).toBe("completed");
    expect(f.updates.get("1")?.requestId).toBe("r1");
  },
);

test("0007 upgrades populated 0006 without inventing prior results; failed upgrade rolls back and reopen preserves output", () => {
  const directory = join(f.root, "old");
  mkdirSync(directory);
  for (const name of [
    "0001_domain.sql",
    "0002_reuse_archived_alias.sql",
    "0003_request_inputs.sql",
    "0004_request_acceptances.sql",
    "0005_attachment_batches.sql",
    "0006_unknown_resolutions.sql",
  ])
    copyFileSync(
      join(import.meta.dir, "../../src/persistence/sqlite/migrations", name),
      join(directory, name),
    );
  const path = join(f.root, "upgrade.sqlite");
  let database = openDatabase(path);
  migrateDatabase(database, directory);
  database.query("INSERT INTO users VALUES ('123',1,?)").run(later);
  const before = database.query("SELECT * FROM users").all();
  copyFileSync(
    join(import.meta.dir, "../../src/persistence/sqlite/migrations/0007_request_deliveries.sql"),
    join(directory, "0007_request_deliveries.sql"),
  );
  database.run("CREATE TABLE request_deliveries (conflict TEXT)");
  expect(() => migrateDatabase(database, directory)).toThrow("DATABASE_ERROR");
  expect(database.query("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({
    count: 6,
  });
  database.run("DROP TABLE request_deliveries");
  expect(migrateDatabase(database, directory)).toBe(1);
  expect(database.query("SELECT * FROM request_deliveries").all()).toEqual([]);
  database.close(true);
  database = openDatabase(path);
  expect(database.query("SELECT * FROM users").all()).toEqual(before);
  expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  database.close(true);
});

test("schema constraints reject missing FK, invalid delivery states and unbounded attempts", () => {
  running();
  const insert = f.database.query(
    "INSERT INTO request_deliveries (request_id,state,result_payload,created_at,expires_at,next_attempt_at,attempts) VALUES (?,?,?,?,?,?,?)",
  );
  for (const values of [
    ["missing", "pending", "{}", later, after(86400000), later, 0],
    ["r1", "wrong", "{}", later, after(86400000), later, 0],
    ["r1", "pending", null, later, after(86400000), later, 0],
    ["r1", "pending", "{}", later, after(86400000), later, 7],
  ] as const)
    expect(() => insert.run(...values)).toThrow();
});
