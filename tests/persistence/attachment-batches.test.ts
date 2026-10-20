import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDatabase } from "../../src/persistence/sqlite/Database";
import { migrateDatabase } from "../../src/persistence/sqlite/migrations";
import { SqliteAttachmentBatchRepository } from "../../src/persistence/sqlite/SqliteAttachmentBatchRepository";
import { type AttachmentBatch, batchText } from "../../src/ports/AttachmentBatchRepository";
import { at, attachment, later, QueueFixture, request } from "../fixtures/queue";

let f: QueueFixture;
let batches: SqliteAttachmentBatchRepository;
beforeEach(() => {
  f = new QueueFixture();
  batches = new SqliteAttachmentBatchRepository(f.database);
});
afterEach(() => f.close());
function batch(id = "r1", groupId = "album"): AttachmentBatch {
  return {
    id,
    userId: "123",
    chatId: "123",
    groupId,
    conversationId: "c1",
    createdAt: at,
    expiresAt: "2026-10-02T00:00:00.000Z",
    state: "open",
  };
}
function append(updateId = "1", messageId = 1) {
  batches.append(batch(), {
    updateId,
    messageId,
    caption: `caption ${messageId}`,
    attachment: attachment(`file-${messageId}`),
  });
}

test("draft append writes file metadata/caption/update marker atomically and protects generated key across reopen", () => {
  append("2", 2);
  append("1", 1);
  f.reopen();
  batches = new SqliteAttachmentBatchRepository(f.database);
  expect(batches.getOpen("123")).toEqual(batch());
  expect(batches.items("r1").map((item) => item.updateId)).toEqual(["1", "2"]);
  expect(batchText(batches.items("r1"))).toBe("caption 1\ncaption 2");
  expect([...batches.retainedStorageKeys()].sort()).toEqual(["storage_file-1", "storage_file-2"]);
  expect(f.updates.get("1")?.requestId).toBeUndefined();
  expect(() => append("1", 3)).toThrow();
  expect(batches.items("r1")).toHaveLength(2);
});

test("source markers, queue acceptance and closing draft commit together, including rejection/rollback", () => {
  append();
  const items = batches.items("r1");
  const input = {
    text: batchText(items),
    attachments: items.map((item) => item.attachment),
    attachmentBatchId: "r1",
  };
  expect(() =>
    f.store.accept(request("r1", "2"), { ...input, text: "foreign caption" }, 3),
  ).toThrow();
  expect(f.requests.get("r1")).toBeNull();
  expect(f.updates.get("2")).toBeNull();
  expect(f.updates.get("1")?.requestId).toBeUndefined();
  expect(batches.getOpen("123")?.id).toBe("r1");
  expect(f.store.accept(request("r1", "2"), input, 3).kind).toBe("accepted");
  for (const id of ["1", "2"]) expect(f.updates.get(id)?.requestId).toBe("r1");
  expect(batches.getOpen("123")).toBeNull();
  expect(batches.items("r1")).toEqual([]);
  expect(f.store.snapshot().queued[0].input.text).toBe("caption 1");
  expect([...batches.retainedStorageKeys()]).toEqual(["storage_file-1"]);
  f.reopen();
  batches = new SqliteAttachmentBatchRepository(f.database);
  expect(f.store.accept(request("r1", "2"), input, 3).kind).toBe("duplicate");
  expect(f.store.snapshot().queued).toHaveLength(1);
});

test("draft ownership, one-open constraint, closed identity and expiry cannot be bypassed on another connection", () => {
  append();
  expect(() => batches.close("456", "r1")).toThrow();
  expect(() =>
    batches.append(batch("r2", "other"), {
      updateId: "2",
      messageId: 2,
      attachment: attachment("x", "r2"),
    }),
  ).toThrow();
  expect(f.updates.get("2")).toBeNull();
  batches.expire(later);
  expect(batches.items("r1")).toHaveLength(1);
  batches.expire("2026-10-03T00:00:00.000Z");
  expect(batches.items("r1")).toEqual([]);
  expect(batches.getGroup("123", "123", "album")?.state).toBe("closed");
  expect(() => append("2", 2)).toThrow();
  expect(batches.retainedStorageKeys().size).toBe(0);
  expect(f.updates.get("1")).not.toBeNull();
  expect(f.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("0005 upgrades populated 0004, rolls back a subsequent failed migration, and reopens with unchanged old rows/ledger", () => {
  const production = resolve(import.meta.dir, "../../src/persistence/sqlite/migrations");
  const directory = join(f.root, "migrations");
  mkdirSync(directory);
  const path = join(f.root, "upgrade.sqlite");
  let db = openDatabase(path);
  try {
    for (const name of readdirSync(production).filter((name) => /^000[1-4]_.*\.sql$/.test(name)))
      copyFileSync(join(production, name), join(directory, name));
    expect(migrateDatabase(db, directory)).toBe(4);
    db.run("INSERT INTO users VALUES ('123',1,?)", [at]);
    const ledger = db.query("SELECT * FROM schema_migrations ORDER BY version").all();
    const rows = db.query("SELECT * FROM users").all();
    copyFileSync(
      join(production, "0005_attachment_batches.sql"),
      join(directory, "0005_attachment_batches.sql"),
    );
    writeFileSync(join(directory, "0006_failure.sql"), "INSERT INTO missing_table VALUES (1);");
    expect(() => migrateDatabase(db, directory)).toThrow();
    expect(
      db.query("SELECT name FROM sqlite_master WHERE name LIKE 'attachment_batch%'").all(),
    ).toEqual([]);
    expect(db.query("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(ledger);
    db.close(true);
    db = openDatabase(path);
    expect(migrateDatabase(db)).toBe(2);
    expect(
      db.query("SELECT * FROM schema_migrations WHERE version<=4 ORDER BY version").all(),
    ).toEqual(ledger);
    expect(db.query("SELECT * FROM users").all()).toEqual(rows);
    db.close(true);
    db = openDatabase(path);
    expect(migrateDatabase(db)).toBe(0);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    db.close(true);
  }
});
