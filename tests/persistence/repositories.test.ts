import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Conversation, canonicalConversationKey } from "../../src/domain/Conversation";
import {
  type Request,
  type RequestState,
  type RequestTransition,
  RequestTransitionError,
  transitionRequest,
} from "../../src/domain/Request";
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
function open(path = join(root, "gateway.sqlite")): void {
  database = openDatabase(path);
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

// Migration fixtures use the reducer with legacy SQL; normal state tests still exercise the actual adapter.
function reachState(id: string, state: RequestState, legacySchema = false): void {
  const advance = (transition: RequestTransition) => {
    if (!legacySchema) {
      requests.transition(id, transition);
      return;
    }
    const current = requests.get(id);
    if (!current) throw new Error("Missing fixture request");
    const next = transitionRequest(current, transition);
    database
      .query(
        `UPDATE requests SET state=?, started_at=?, submitted_at=?, finished_at=?, provider_request_id=?, failure_code=? WHERE id=?`,
      )
      .run(
        next.state,
        next.startedAt ?? null,
        next.submittedAt ?? null,
        next.finishedAt ?? null,
        next.providerRequestId ?? null,
        next.failureCode ?? null,
        id,
      );
  };
  if (state === "created") return;
  advance({ state: "queued", at });
  if (state === "queued") return;
  if (state === "failed") {
    advance({ state: "failed", at: later, failureCode: "PROVIDER_UNAVAILABLE" });
    return;
  }
  if (state === "uploading") {
    advance({ state: "uploading", at });
    return;
  }
  advance({ state: "sending", at });
  if (state === "sending") return;
  if (state === "unknown") {
    advance({ state: "unknown", at: later });
    return;
  }
  advance({ state: "running", at: later, providerRequestId: `opaque-${id}` });
  if (state !== "running") advance({ state, at: later });
}

// Seed the exact published 0001 independently of current migrations, including all nullable/evidence fields.
function openLegacyDatabase(): { path: string; directory: string } {
  const path = join(root, "legacy.sqlite");
  const directory = join(root, "legacy-migrations");
  mkdirSync(directory);
  copyFileSync(join(production, "0001_domain.sql"), join(directory, "0001_domain.sql"));
  database.close(true);
  open(path);
  expect(migrateDatabase(database, directory)).toBe(1);
  conversations.putUser({ telegramUserId: "123", enabled: true, createdAt: at });
  conversations.putUser({ telegramUserId: "456", enabled: false, createdAt: at });
  conversations.create({ ...conversation(), lastUsedAt: later });
  conversations.create({
    ...conversation("other", "456", "research", "other-provider"),
    providerUrl: undefined,
    status: "unavailable",
  });
  conversations.select("123", "c1");
  conversations.select("456", "other");
  const states: RequestState[] = [
    "created",
    "queued",
    "uploading",
    "sending",
    "running",
    "completed",
    "failed",
    "cancel_requested",
    "cancelled",
    "timeout",
    "unknown",
  ];
  states.forEach((state, index) => {
    const id = `legacy_${state}`;
    requests.create(
      { ...request(id, String(index + 10)), telegramMessageId: index % 2 === 0 ? undefined : "5" },
      [
        {
          id: `attachment_${state}`,
          requestId: id,
          sourceFileId: `source_${state}`,
          filename: "../../source.ts",
          mimeType: "text/plain",
          sizeBytes: index,
          temporaryStorageKey: index % 2 === 0 ? undefined : `storage_${state}`,
          createdAt: at,
        },
      ],
    );
    reachState(id, state, true);
    updates.record({ telegramUpdateId: String(index + 10), requestId: id, processedAt: later });
  });
  updates.record({ telegramUpdateId: "100", processedAt: at });
  conversations.create(conversation("archived", "123", "history", "historical-provider"));
  requests.create(request("historical", "101", "archived"));
  conversations.archive("123", "archived", later);
  return { path, directory };
}

// Exact rows are the migration preservation oracle; ordering does not depend on SQLite insertion order.
function operationalRows() {
  const tables = [
    ["users", "telegram_user_id"],
    ["conversations", "id"],
    ["active_conversations", "telegram_user_id"],
    ["requests", "id"],
    ["processed_updates", "telegram_update_id"],
    ["attachments", "id"],
  ];
  return Object.fromEntries(
    tables.map(([table, key]) => [
      table,
      database.query(`SELECT * FROM ${table} ORDER BY ${key}`).all(),
    ]),
  );
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
    conversations.rename("123", "c1", "coding", later);
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
    expect(() => conversations.rename("123", "c1", "c2", later)).toThrow(DatabaseError);
    expect(conversations.getActive("123")).toEqual(conversation());
    expect(() => conversations.rename("123", "missing", "new", later)).toThrow(DatabaseError);
  });

  test("archive clears active selection atomically and preserves request metadata", () => {
    conversations.select("123", "c1");
    requests.create(request());
    conversations.archive("123", "c1", later);
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
    expect(() => conversations.archive("123", "missing", later)).toThrow(DatabaseError);
    database.close(true);
    open();
    expect(conversations.getActive("123")).toBeNull();
    expect(conversations.get("c1")?.archived).toBe(true);
  });

  test.each(["rename", "archive"] as const)(
    "%s rejects another owner's ID without changing either user's state",
    (operation) => {
      const other = conversation("other", "456", "research", "other-provider");
      conversations.create(other);
      conversations.select("123", "c1");
      conversations.select("456", "other");
      requests.create(request());
      const otherRequest = request("r2", "2", "other");
      requests.create(otherRequest);
      for (const [actor, target] of [
        ["123", "other"],
        ["456", "c1"],
      ]) {
        try {
          if (operation === "rename") conversations.rename(actor, target, "stolen", later);
          else conversations.archive(actor, target, later);
          throw new Error("Expected ownership rejection");
        } catch (error) {
          expect(error).toBeInstanceOf(DatabaseError);
          if (!(error instanceof DatabaseError)) throw error;
          expect(error.reason).toBe("entity_not_found");
        }
      }
      database.close(true);
      open();
      expect(conversations.get("c1")).toEqual(conversation());
      expect(conversations.get("other")).toEqual(other);
      expect(conversations.getActive("123")).toEqual(conversation());
      expect(conversations.getActive("456")).toEqual(other);
      expect(requests.get("r1")).toEqual(request());
      expect(requests.get("r2")).toEqual(otherRequest);
      if (operation === "rename") {
        conversations.rename("456", "other", "renamed", later);
        expect(conversations.getActive("456")).toEqual({
          ...other,
          alias: "renamed",
          updatedAt: later,
        });
      } else {
        conversations.archive("456", "other", later);
        expect(conversations.getActive("456")).toBeNull();
        expect(conversations.get("other")).toEqual({ ...other, archived: true, updatedAt: later });
      }
      expect(conversations.getActive("123")).toEqual(conversation());
      expect(requests.get("r2")).toEqual(otherRequest);
    },
  );

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

  test("archive releases alias for a new mapping without rebinding historical requests", () => {
    conversations.select("123", "c1");
    requests.create(request());
    conversations.archive("123", "c1", later);
    const replacement = conversation("replacement", "123", "c1", "new-provider");
    conversations.create(replacement);
    expect(conversations.getActive("123")).toBeNull();
    conversations.select("123", "replacement");
    database.close(true);
    open();
    expect(conversations.findByAlias("123", "c1")).toEqual(replacement);
    expect(conversations.list("123")).toEqual([replacement]);
    expect(conversations.getActive("123")).toEqual(replacement);
    expect(conversations.get("c1")).toEqual({
      ...conversation(),
      archived: true,
      updatedAt: later,
    });
    expect(requests.get("r1")).toEqual(request());
    expect(canonicalConversationKey(replacement)).toBe("new-provider");
    expect(() => conversations.create(conversation("collision", "123", "c1"))).toThrow(
      DatabaseError,
    );
  });

  test("rename may reuse archived alias but live uniqueness still applies", () => {
    conversations.archive("123", "c1", later);
    const current = conversation("c2", "123", "other", "current-provider");
    conversations.create(current);
    conversations.select("123", "c2");
    conversations.rename("123", "c2", "c1", later);
    expect(conversations.getActive("123")).toEqual({ ...current, alias: "c1", updatedAt: later });
    conversations.create({ ...conversation("historical", "123", "c1"), archived: true });
    expect(() =>
      database.run("UPDATE conversations SET archived=0 WHERE id='historical'"),
    ).toThrow();
    expect(() => conversations.rename("123", "c1", "hidden", later)).toThrow(DatabaseError);
    expect(conversations.findByAlias("123", "c1")?.id).toBe("c2");
  });

  test("forward alias migration preserves populated 0001 schema data, ledger and all request states", () => {
    const legacy = openLegacyDatabase();
    const rows = operationalRows();
    const ledger = database.query("SELECT * FROM schema_migrations ORDER BY version").all();
    expect(() => conversations.create(conversation("old-conflict", "123", "history"))).toThrow(
      DatabaseError,
    );
    database.close(true);
    open(legacy.path);
    expect(migrateDatabase(database)).toBe(2);
    expect(operationalRows()).toEqual(rows);
    expect(database.query("SELECT * FROM schema_migrations WHERE version=1").all()).toEqual(ledger);
    expect(database.query("SELECT name FROM sqlite_temp_master WHERE type='table'").all()).toEqual(
      [],
    );
    expect(database.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    conversations.create(conversation("replacement", "123", "history", "new-provider"));
    database.close(true);
    open(legacy.path);
    expect(migrateDatabase(database)).toBe(0);
    expect(conversations.findByAlias("123", "history")?.id).toBe("replacement");
    expect(requests.get("historical")?.conversationId).toBe("archived");
    expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(() => database.run("INSERT INTO active_conversations VALUES('789','c1')")).toThrow();
    expect(() =>
      database.run(
        "UPDATE active_conversations SET conversation_id='c1' WHERE telegram_user_id='456'",
      ),
    ).toThrow();
    expect(() =>
      database.run("UPDATE requests SET conversation_id='missing' WHERE id='historical'"),
    ).toThrow();
    expect(() => conversations.create(conversation("collision", "123", "history"))).toThrow(
      DatabaseError,
    );
  });

  test("later migration failure rolls back the populated alias rebuild and its temporary tables", () => {
    const legacy = openLegacyDatabase();
    const rows = operationalRows();
    const schema = database
      .query("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")
      .all();
    const ledger = database.query("SELECT * FROM schema_migrations ORDER BY version").all();
    copyFileSync(
      join(production, "0002_reuse_archived_alias.sql"),
      join(legacy.directory, "0002_reuse_archived_alias.sql"),
    );
    writeFileSync(
      join(legacy.directory, "0003_failure.sql"),
      "INSERT INTO r1_missing_table VALUES(1);",
    );
    try {
      migrateDatabase(database, legacy.directory);
      throw new Error("Expected migration failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseError);
      if (!(error instanceof DatabaseError)) throw error;
      expect(error.reason).toBe("migration_failed");
      expect(error.cause).toBeInstanceOf(Error);
      if (!(error.cause instanceof Error)) throw error;
      expect(error.cause.message).toContain("r1_missing_table");
    }
    expect(operationalRows()).toEqual(rows);
    expect(
      database.query("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(),
    ).toEqual(schema);
    expect(database.query("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(
      ledger,
    );
    expect(database.query("SELECT name FROM sqlite_temp_master WHERE type='table'").all()).toEqual(
      [],
    );
    expect(() => conversations.create(conversation("still-conflict", "123", "history"))).toThrow(
      DatabaseError,
    );
    database.close(true);
    open(legacy.path);
    expect(operationalRows()).toEqual(rows);
    expect(migrateDatabase(database)).toBe(2);
    expect(operationalRows()).toEqual(rows);
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
    reachState("r1", state);
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
    expect(migrateDatabase(database, migrations)).toBe(3);
    expect(
      database.query("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(),
    ).toEqual(freshSchema);
    expect(database.query("SELECT version,name,checksum FROM schema_migrations").all()).toEqual(
      ledger,
    );
    expect(migrateDatabase(database, migrations)).toBe(0);
    expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  test("storage contains operational input/metadata and no history/auth tables", () => {
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
      "request_inputs",
      "requests",
      "schema_migrations",
      "sqlite_sequence",
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
