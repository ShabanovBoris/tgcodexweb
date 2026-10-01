import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Conversation, canonicalConversationKey } from "../../src/domain/Conversation";
import { type Request, RequestTransitionError } from "../../src/domain/Request";
import { DatabaseError, openDatabase } from "../../src/persistence/sqlite/Database";
import { migrateDatabase } from "../../src/persistence/sqlite/migrations";
import { SqliteConversationRepository } from "../../src/persistence/sqlite/SqliteConversationRepository";
import { SqliteRequestRepository } from "../../src/persistence/sqlite/SqliteRequestRepository";
import { SqliteUpdateDedupRepository } from "../../src/persistence/sqlite/SqliteUpdateDedupRepository";

const at = "2026-10-01T00:00:00.000Z";
const later = "2026-10-01T00:00:01.000Z";
const production = resolve(import.meta.dir, "../../src/persistence/sqlite/migrations");
let root: string;
let database: Database;
let conversations: SqliteConversationRepository;
let requests: SqliteRequestRepository;
let updates: SqliteUpdateDedupRepository;

// Reconstruct adapters with each reopened connection, preserving only on-disk business state.
function open(): void {
  database = openDatabase(join(root, "gateway.sqlite"));
  conversations = new SqliteConversationRepository(database);
  requests = new SqliteRequestRepository(database);
  updates = new SqliteUpdateDedupRepository(database);
}

// Synthetic domain fixtures exercise aliases converging on one provider identity.
function conversation(
  id = "c1",
  user = "123",
  alias = id,
  provider = "opaque-remote",
): Conversation {
  return {
    id,
    telegramUserId: user,
    alias,
    providerConversationId: provider,
    providerUrl: "https://example.invalid/conversation",
    status: "ready",
    createdAt: at,
    updatedAt: at,
    archived: false,
  };
}

// Fixtures include only operational correlation fields, no prompts or auth state.
function request(id = "r1", update = "1", conversationId = "c1"): Request {
  return {
    id,
    conversationId,
    telegramUpdateId: update,
    telegramMessageId: "5",
    state: "created",
    createdAt: at,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tgcodexweb-r1-repository-"));
  open();
  migrateDatabase(database);
  conversations.putUser({ telegramUserId: "123", enabled: true, createdAt: at });
  conversations.putUser({ telegramUserId: "456", enabled: true, createdAt: at });
  conversations.create(conversation());
});
afterEach(() => {
  database.close(true);
  rmSync(root, { recursive: true, force: true });
});

describe("R1 repositories", () => {
  test("conversation/user round trip and missing vs empty lookup", () => {
    expect(conversations.get("c1")).toEqual(conversation());
    expect(conversations.findByAlias("123", "c1")).toEqual(conversation());
    expect(conversations.list("123")).toEqual([conversation()]);
    expect(conversations.list("789")).toEqual([]);
    expect(conversations.get("missing")).toBeNull();
    expect(conversations.getUser("missing")).toBeNull();
    conversations.putUser({ telegramUserId: "123", enabled: false, createdAt: later });
    expect(conversations.getUser("123")).toEqual({
      telegramUserId: "123",
      enabled: false,
      createdAt: at,
    });
  });

  test("alias uniqueness is per user and allows convergence on opaque provider identity", () => {
    expect(() => conversations.create(conversation("collision", "123", "c1"))).toThrow(
      DatabaseError,
    );
    conversations.create(conversation("c2", "123", "another"));
    conversations.create(conversation("c3", "456", "c1"));
    expect(conversations.list("123")).toHaveLength(2);
    const first = conversations.get("c1"),
      second = conversations.get("c2");
    if (!first || !second) throw new Error("Missing fixture conversation");
    expect(canonicalConversationKey(first)).toBe(canonicalConversationKey(second));
    expect(() => conversations.create(conversation("orphan", "789"))).toThrow(DatabaseError);
  });

  test("durable active selection enforces ownership and rename preserves identity", () => {
    conversations.create(conversation("c2"));
    conversations.select("123", "c1");
    expect(() => conversations.select("456", "c1")).toThrow(DatabaseError);
    expect(() => conversations.select("123", "missing")).toThrow(DatabaseError);
    expect(() => database.run("INSERT INTO active_conversations VALUES('456','c1')")).toThrow();
    conversations.rename("c1", "coding", later);
    expect(conversations.getActive("123")).toEqual({
      ...conversation(),
      alias: "coding",
      updatedAt: later,
    });
    conversations.select("123", "c2");
    expect(conversations.getActive("123")?.id).toBe("c2");
    database.close(true);
    open();
    expect(migrateDatabase(database)).toBe(0);
    expect(conversations.getActive("123")?.id).toBe("c2");
    expect(conversations.findByAlias("123", "coding")?.providerConversationId).toBe(
      "opaque-remote",
    );
  });

  test("rename collision rolls back without losing selection or remote identity", () => {
    conversations.create(conversation("c2"));
    conversations.select("123", "c1");
    expect(() => conversations.rename("c1", "c2", later)).toThrow(DatabaseError);
    expect(conversations.getActive("123")).toEqual(conversation());
    expect(() => conversations.rename("missing", "new", later)).toThrow(DatabaseError);
  });

  test("archive clears active selection atomically and preserves request metadata", () => {
    conversations.select("123", "c1");
    requests.create(request());
    conversations.archive("c1", later);
    expect(conversations.getActive("123")).toBeNull();
    expect(conversations.list("123")).toEqual([]);
    expect(conversations.findByAlias("123", "c1")).toBeNull();
    expect(conversations.get("c1")).toEqual({
      ...conversation(),
      archived: true,
      updatedAt: later,
    });
    expect(requests.get("r1")).toEqual(request());
    expect(() => conversations.select("123", "c1")).toThrow(DatabaseError);
    expect(() => conversations.archive("missing", later)).toThrow(DatabaseError);
    database.close(true);
    open();
    expect(conversations.getActive("123")).toBeNull();
    expect(conversations.get("c1")?.archived).toBe(true);
  });

  test("request/attachment round trip survives separate-process inspection", () => {
    const attachment = {
      id: "a1",
      requestId: "r1",
      sourceFileId: "opaque-file",
      filename: "../../source.ts",
      mimeType: "text/plain",
      sizeBytes: 12,
      temporaryStorageKey: "generated_1",
      createdAt: at,
    };
    requests.create(request(), [attachment]);
    updates.record({ telegramUpdateId: "1", requestId: "r1", processedAt: at });
    expect(requests.get("r1")).toEqual(request());
    expect(requests.findByUpdate("1")).toEqual(request());
    expect(requests.listAttachments("r1")).toEqual([attachment]);
    conversations.select("123", "c1");
    database.close(true);
    const child = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../fixtures/reopen.ts"),
        join(root, "gateway.sqlite"),
      ],
      { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" },
    );
    open();
    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).toBe("");
    expect(JSON.parse(child.stdout.toString())).toEqual({
      active: "c1",
      request: request(),
      update: { telegramUpdateId: "1", requestId: "r1", processedAt: at },
      attachments: [attachment],
      migrations: 0,
    });
  });

  test("duplicate request ingress identity fails and cannot replace original", () => {
    requests.create(request());
    expect(() => requests.create(request("r2", "1"))).toThrow(DatabaseError);
    expect(requests.get("r1")).toEqual(request());
    expect(requests.get("r2")).toBeNull();
    expect(() => requests.create(request("r3", "3", "missing"))).toThrow(DatabaseError);
    expect(() => requests.create({ ...request("r4", "4"), state: "queued" })).toThrow(
      DatabaseError,
    );
  });

  test("request plus attachments roll back together on any metadata constraint failure", () => {
    const attachment = {
      id: "same",
      requestId: "r1",
      sourceFileId: "file",
      filename: "file.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      createdAt: at,
    };
    expect(() => requests.create(request(), [attachment, attachment])).toThrow(DatabaseError);
    expect(requests.get("r1")).toBeNull();
    expect(requests.listAttachments("r1")).toEqual([]);
    expect(() => requests.create(request(), [{ ...attachment, requestId: "other" }])).toThrow(
      DatabaseError,
    );
    expect(requests.get("r1")).toBeNull();
  });

  test("processed updates are immutable, nullable for commands and identity-constrained", () => {
    requests.create(request());
    updates.record({ telegramUpdateId: "1", requestId: "r1", processedAt: at });
    updates.record({ telegramUpdateId: "2", processedAt: at });
    expect(() => updates.record({ telegramUpdateId: "1", processedAt: later })).toThrow(
      DatabaseError,
    );
    updates.record({ telegramUpdateId: "3", requestId: "r1", processedAt: at });
    expect(() =>
      updates.record({ telegramUpdateId: "4", requestId: "missing", processedAt: at }),
    ).toThrow(DatabaseError);
    database.close(true);
    open();
    expect(updates.get("1")).toEqual({ telegramUpdateId: "1", requestId: "r1", processedAt: at });
    expect(updates.get("2")).toEqual({ telegramUpdateId: "2", processedAt: at });
    expect(updates.get("3")).toEqual({ telegramUpdateId: "3", requestId: "r1", processedAt: at });
    expect(updates.get("missing")).toBeNull();
  });

  test("valid transitions persist evidence and failed transitions leave rows unchanged", () => {
    requests.create(request());
    requests.transition("r1", { state: "queued", at });
    requests.transition("r1", { state: "sending", at });
    const sending = requests.get("r1");
    expect(() =>
      requests.transition("r1", { state: "failed", at, failureCode: "SUBMISSION_STATE_UNKNOWN" }),
    ).toThrow(RequestTransitionError);
    expect(requests.get("r1")).toEqual(sending);
    requests.transition("r1", {
      state: "running",
      at: later,
      providerRequestId: "opaque-operation",
    });
    const completed = requests.transition("r1", { state: "completed", at: later });
    expect(() => requests.transition("r1", { state: "queued", at: later })).toThrow(
      RequestTransitionError,
    );
    database.close(true);
    open();
    expect(requests.get("r1")).toEqual(completed);
    expect(requests.listUnfinished()).toEqual([]);
    expect(() => requests.transition("missing", { state: "queued", at })).toThrow(DatabaseError);
  });

  test.each([
    "created",
    "queued",
    "uploading",
    "sending",
    "running",
    "cancel_requested",
    "unknown",
    "completed",
    "failed",
    "cancelled",
    "timeout",
  ] as const)("reopen preserves %s without reconciliation/replay", (state) => {
    requests.create(request());
    if (state !== "created") requests.transition("r1", { state: "queued", at });
    if (state === "uploading") requests.transition("r1", { state: "uploading", at });
    if (
      [
        "sending",
        "running",
        "cancel_requested",
        "unknown",
        "completed",
        "cancelled",
        "timeout",
      ].includes(state)
    )
      requests.transition("r1", { state: "sending", at });
    if (["running", "cancel_requested", "completed", "cancelled", "timeout"].includes(state))
      requests.transition("r1", { state: "running", at: later, providerRequestId: "opaque" });
    if (state === "cancel_requested")
      requests.transition("r1", { state: "cancel_requested", at: later });
    if (["unknown", "completed", "cancelled", "timeout"].includes(state))
      requests.transition("r1", { state, at: later });
    if (state === "failed")
      requests.transition("r1", {
        state: "failed",
        at: later,
        failureCode: "PROVIDER_UNAVAILABLE",
      });
    const before = requests.get("r1");
    if (!before) throw new Error("Missing fixture request");
    database.close(true);
    open();
    migrateDatabase(database);
    expect(requests.get("r1")).toEqual(before);
    expect(requests.listUnfinished()).toEqual(
      ["unknown", "completed", "failed", "cancelled", "timeout"].includes(state) ? [] : [before],
    );
    if (state === "unknown")
      expect(() => requests.transition("r1", { state: "sending", at: later })).toThrow(
        RequestTransitionError,
      );
  });

  test("foreign keys and persisted state checks reject invalid raw writes", () => {
    requests.create(request());
    expect(() => database.run("UPDATE requests SET state='invalid' WHERE id='r1'")).toThrow();
    expect(() => database.run("UPDATE requests SET state='running' WHERE id='r1'")).toThrow();
    expect(() => database.run("UPDATE requests SET submitted_at=? WHERE id='r1'", [at])).toThrow();
    expect(() => database.run("UPDATE conversations SET status='invalid' WHERE id='c1'")).toThrow();
    expect(() => database.run("DELETE FROM conversations WHERE id='c1'")).toThrow();
    expect(() => database.run("DELETE FROM users WHERE telegram_user_id='123'")).toThrow();
    expect(() =>
      database.run("INSERT INTO attachments VALUES('x','missing','f','f','text/plain',0,NULL,?)", [
        at,
      ]),
    ).toThrow();
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("separate connection transitions read current persisted state", () => {
    requests.create(request());
    const other = openDatabase(join(root, "gateway.sqlite"));
    try {
      const otherRequests = new SqliteRequestRepository(other);
      expect(otherRequests.get("r1")?.state).toBe("created");
      requests.transition("r1", { state: "queued", at });
      expect(() => otherRequests.transition("r1", { state: "queued", at })).toThrow(
        RequestTransitionError,
      );
      otherRequests.transition("r1", { state: "sending", at });
      expect(requests.get("r1")?.state).toBe("sending");
    } finally {
      other.close(true);
    }
  });

  test("adapter distinguishes constraint errors without exposing SQL in its public message", () => {
    const cases = [
      {
        run: () => conversations.create(conversation("duplicate", "123", "c1")),
        reason: "unique_conflict",
      },
      {
        run: () => conversations.create(conversation("orphan", "789")),
        reason: "foreign_key_violation",
      },
    ] as const;
    for (const scenario of cases) {
      try {
        scenario.run();
        throw new Error("Expected constraint violation");
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseError);
        if (!(error instanceof DatabaseError)) throw error;
        expect(error.reason).toBe(scenario.reason);
        expect(error.message).toBe("DATABASE_ERROR");
      }
    }
  });

  test("R0 empty-ledger upgrade and fresh migration produce identical schema and ledger hashes", () => {
    const freshSchema = database
      .query("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")
      .all();
    const ledger = database.query("SELECT version,name,checksum FROM schema_migrations").all();
    database.close(true);
    database = openDatabase(join(root, "r0.sqlite"));
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(migrateDatabase(database, empty)).toBe(0);
    database.close(true);
    database = openDatabase(join(root, "r0.sqlite"));
    const migrations = join(root, "copy");
    mkdirSync(migrations);
    for (const name of readdirSync(production)
      .filter((name) => name.endsWith(".sql"))
      .reverse())
      copyFileSync(join(production, name), join(migrations, name));
    expect(migrateDatabase(database, migrations)).toBe(1);
    expect(
      database.query("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(),
    ).toEqual(freshSchema);
    expect(database.query("SELECT version,name,checksum FROM schema_migrations").all()).toEqual(
      ledger,
    );
    expect(migrateDatabase(database, migrations)).toBe(0);
    expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  test("storage contains operational metadata columns and no history/auth tables", () => {
    const names = database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(names).toEqual([
      "active_conversations",
      "attachments",
      "conversations",
      "processed_updates",
      "requests",
      "schema_migrations",
      "users",
    ]);
    const fields = names.flatMap((name) =>
      database
        .query<{ name: string }, []>(`PRAGMA table_info(${name})`)
        .all()
        .map((row) => row.name),
    );
    expect(fields.some((field) => /cookie|token|auth|prompt|response|history/i.test(field))).toBe(
      false,
    );
  });
});
