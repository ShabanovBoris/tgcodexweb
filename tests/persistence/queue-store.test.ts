import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseError, openDatabase } from "../../src/persistence/sqlite/Database";
import { migrateDatabase } from "../../src/persistence/sqlite/migrations";
import { SqliteRequestQueueRepository } from "../../src/persistence/sqlite/SqliteRequestQueueRepository";
import { SqliteRequestRepository } from "../../src/persistence/sqlite/SqliteRequestRepository";
import { at, attachment, later, QueueFixture, request } from "../fixtures/queue";

let f: QueueFixture;
beforeEach(() => {
  f = new QueueFixture();
});
afterEach(() => f.close());

describe("R2 durable acceptance", () => {
  test("duplicate update retains exactly one request, payload, attachments and marker across reopen", () => {
    const input = { text: "synthetic input", attachments: [attachment("z"), attachment("a")] };
    expect(f.store.accept(request(), input, 2)).toEqual({ kind: "accepted", requestId: "r1" });
    f.reopen();
    expect(f.store.accept(request("r2"), { text: "changed", attachments: [] }, 2)).toEqual({
      kind: "duplicate",
      update: { telegramUpdateId: "1", requestId: "r1", processedAt: at },
    });
    const snapshot = f.store.snapshot();
    expect(snapshot.blocked).toEqual([]);
    expect(snapshot.queued).toHaveLength(1);
    expect(snapshot.queued[0].input).toEqual(input);
    expect(f.requests.get("r2")).toBeNull();
    expect(f.database.query("SELECT count(*) AS n FROM request_inputs").get()).toEqual({ n: 1 });
    expect(f.database.query("SELECT count(*) AS n FROM requests").get()).toEqual({ n: 1 });
    expect(f.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("a command marker is duplicate even without a request; legacy request is never accepted again", () => {
    f.updates.record({ telegramUpdateId: "1", processedAt: at });
    expect(f.store.accept(request(), { text: "x", attachments: [] }, 2).kind).toBe("duplicate");
    expect(f.requests.get("r1")).toBeNull();
    f.requests.create(request("legacy", "2"));
    expect(() => f.store.accept(request("new", "2"), { text: "x", attachments: [] }, 2)).toThrow(
      DatabaseError,
    );
    expect(f.requests.get("new")).toBeNull();
    expect(f.updates.get("2")).toBeNull();
  });

  test.each(["provenance", "payload", "marker", "queued"])(
    "rollback at %s leaves no partial acceptance after reopen",
    (step) => {
      const sql =
        step === "provenance"
          ? "BEFORE INSERT ON request_acceptances"
          : step === "payload"
            ? "BEFORE INSERT ON request_inputs"
            : step === "marker"
              ? "BEFORE INSERT ON processed_updates"
              : "BEFORE UPDATE OF state ON requests WHEN NEW.state='queued'";
      f.database.run(
        `CREATE TRIGGER fail_accept ${sql} BEGIN SELECT RAISE(ABORT, 'synthetic'); END`,
      );
      expect(() =>
        f.store.accept(request(), { text: "x", attachments: [attachment()] }, 2),
      ).toThrow(DatabaseError);
      f.reopen();
      expect(f.requests.get("r1")).toBeNull();
      expect(f.requests.listAttachments("r1")).toEqual([]);
      expect(f.updates.get("1")).toBeNull();
      expect(f.database.query("SELECT * FROM request_acceptances").all()).toEqual([]);
      expect(f.store.snapshot()).toEqual({ queued: [], blocked: [] });
      f.database.run("DROP TRIGGER fail_accept");
      expect(f.store.accept(request(), { text: "x", attachments: [] }, 2).kind).toBe("accepted");
    },
  );

  test("capacity shares the exact remote key across aliases, excludes active work, and checks duplicates first", () => {
    expect(f.store.accept(request(), { text: "1", attachments: [] }, 1).kind).toBe("accepted");
    expect(f.store.accept(request("r2", "2", "alias"), { text: "2", attachments: [] }, 1)).toEqual({
      kind: "rejected",
      code: "QUEUE_FULL",
    });
    expect(f.updates.get("2")).toBeNull();
    expect(
      f.store.accept(request("r3", "3", "other"), { text: "3", attachments: [] }, 1).kind,
    ).toBe("accepted");
    expect(f.store.accept(request("duplicate"), { text: "x", attachments: [] }, 1).kind).toBe(
      "duplicate",
    );
    expect(f.store.claim("r1", later)?.request.state).toBe("sending");
    expect(
      f.store.accept(request("r2", "2", "alias"), { text: "2", attachments: [] }, 1).kind,
    ).toBe("accepted");
    expect(f.store.claim("r2", later)).toBeNull();
  });

  test("second connection observes committed dedup/capacity and cannot double-claim", () => {
    const database = openDatabase(f.path);
    const second = new SqliteRequestQueueRepository(database);
    try {
      f.store.accept(request(), { text: "x", attachments: [] }, 1);
      expect(second.accept(request("again"), { text: "x", attachments: [] }, 1).kind).toBe(
        "duplicate",
      );
      expect(second.accept(request("r2", "2"), { text: "x", attachments: [] }, 1).kind).toBe(
        "rejected",
      );
      expect(second.claim("r1", later)?.request.state).toBe("sending");
      expect(f.store.claim("r1", later)).toBeNull();
    } finally {
      database.close(true);
    }
  });

  test("acceptance sequence preserves FIFO across identical timestamps, reversed IDs, deletion and reopen", () => {
    f.store.accept(request("z", "1"), { text: "first", attachments: [] }, 3);
    f.store.accept(request("a", "2", "alias"), { text: "second", attachments: [] }, 3);
    f.store.accept(request("m", "3"), { text: "third", attachments: [] }, 3);
    f.reopen();
    const queued = f.store.snapshot().queued;
    expect(queued.map((work) => work.request.id)).toEqual(["z", "a", "m"]);
    expect(f.store.claim("a", later)).toBeNull();
    expect(f.store.claim("z", later)?.input.text).toBe("first");
    f.complete("z");
    f.requests.transition("a", { state: "failed", at: later, failureCode: "PROVIDER_UNAVAILABLE" });
    f.requests.transition("m", { state: "failed", at: later, failureCode: "PROVIDER_UNAVAILABLE" });
    f.reopen();
    f.store.accept(request("next", "4"), { text: "next", attachments: [] }, 3);
    expect(f.store.snapshot().queued[0].sequence).toBeGreaterThan(queued[2].sequence);
  });

  test.each(["completed", "failed", "cancelled", "timeout", "unknown"] as const)(
    "%s deletes operational input atomically but retains identity and dedup",
    (state) => {
      f.store.accept(request(), { text: "synthetic", attachments: [attachment()] }, 2);
      f.store.claim("r1", later);
      f.requests.transition("r1", { state: "sending", at: later });
      if (state !== "unknown") f.requests.transition("r1", { state: "running", at: later });
      f.requests.transition("r1", {
        state,
        at: later,
        failureCode: state === "failed" ? "PROVIDER_UNAVAILABLE" : undefined,
      });
      f.reopen();
      expect(f.requests.get("r1")?.state).toBe(state);
      expect(f.requests.get("r1")?.conversationId).toBe("c1");
      expect(f.requests.listAttachments("r1")).toEqual([]);
      expect(f.database.query("SELECT * FROM request_inputs").all()).toEqual([]);
      expect(f.updates.get("1")?.requestId).toBe("r1");
      expect(f.database.query("SELECT * FROM request_acceptances").all()).toEqual([
        { request_id: "r1" },
      ]);
      expect(f.store.accept(request("again"), { text: "x", attachments: [] }, 2).kind).toBe(
        "duplicate",
      );
    },
  );

  test("failed terminal cleanup rolls back terminal state and input together", () => {
    f.store.accept(request(), { text: "synthetic", attachments: [attachment()] }, 2);
    f.database.run(
      "CREATE TRIGGER fail_cleanup BEFORE DELETE ON request_inputs BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
    );
    expect(() =>
      f.requests.transition("r1", {
        state: "failed",
        at: later,
        failureCode: "PROVIDER_UNAVAILABLE",
      }),
    ).toThrow(DatabaseError);
    f.reopen();
    expect(f.requests.get("r1")?.state).toBe("queued");
    expect(f.requests.listAttachments("r1")).toHaveLength(1);
    expect(f.store.snapshot().queued[0].input.text).toBe("synthetic");
  });

  test.each(["failed", "unknown"] as const)(
    "lost R2 payload still cleans working attachments on %s while preserving legacy R1 references",
    (state) => {
      const legacyAttachment = attachment("legacy-file", "legacy");
      f.requests.create(request("legacy", "9", "other"), [legacyAttachment]);
      f.store.accept(request(), { text: "synthetic", attachments: [attachment()] }, 2);
      if (state === "unknown") {
        f.store.claim("r1", later);
        f.requests.transition("r1", { state: "sending", at: later });
      }
      f.database.run("DELETE FROM request_inputs WHERE request_id='r1'");
      f.reopen();
      expect(f.store.snapshot().blocked).toContainEqual({
        requestId: "r1",
        providerConversationId: "remote",
        reason: state === "failed" ? "input_unavailable" : "reconciliation_required",
      });
      f.requests.transition("r1", {
        state,
        at: later,
        failureCode: state === "failed" ? "PROVIDER_UNAVAILABLE" : undefined,
      });
      f.requests.transition("legacy", {
        state: "failed",
        at: later,
        failureCode: "PROVIDER_UNAVAILABLE",
      });
      f.reopen();
      expect(f.requests.listAttachments("r1")).toEqual([]);
      expect(f.requests.listAttachments("legacy")).toEqual([legacyAttachment]);
      expect(f.requests.get("r1")?.state).toBe(state);
      expect(f.requests.get("r1")?.conversationId).toBe("c1");
      expect(f.updates.get("1")?.requestId).toBe("r1");
      expect(f.store.accept(request("again"), { text: "x", attachments: [] }, 2).kind).toBe(
        "duplicate",
      );
    },
  );

  test("lost-payload cleanup failure rolls back lifecycle and preserves durable ownership", () => {
    f.store.accept(request(), { text: "synthetic", attachments: [attachment()] }, 2);
    f.database.run("DELETE FROM request_inputs WHERE request_id='r1'");
    f.database.run(
      "CREATE TRIGGER fail_refs BEFORE DELETE ON attachments BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
    );
    expect(() =>
      f.requests.transition("r1", {
        state: "failed",
        at: later,
        failureCode: "PROVIDER_UNAVAILABLE",
      }),
    ).toThrow(DatabaseError);
    f.reopen();
    expect(f.requests.get("r1")?.state).toBe("queued");
    expect(f.requests.listAttachments("r1")).toHaveLength(1);
    expect(f.database.query("SELECT * FROM request_acceptances").all()).toEqual([
      { request_id: "r1" },
    ]);
    expect(f.store.snapshot().blocked[0].reason).toBe("input_unavailable");
    f.database.run("DROP TRIGGER fail_refs");
    f.requests.transition("r1", {
      state: "failed",
      at: later,
      failureCode: "PROVIDER_UNAVAILABLE",
    });
    expect(f.requests.listAttachments("r1")).toEqual([]);
  });

  test("acceptance provenance requires an existing request and cannot overwrite its durable record", () => {
    f.store.accept(request(), { text: "synthetic", attachments: [] }, 2);
    expect(() => f.database.run("INSERT INTO request_acceptances VALUES('r1')")).toThrow();
    expect(() => f.database.run("INSERT INTO request_acceptances VALUES('missing')")).toThrow();
    expect(() => f.database.run("INSERT INTO request_acceptances VALUES(NULL)")).toThrow();
    f.reopen();
    expect(f.database.query("SELECT * FROM request_acceptances").all()).toEqual([
      { request_id: "r1" },
    ]);
    expect(f.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("0004 upgrades populated 0003 with independent R2 provenance and preserves old rows/ledger through rollback and reopen", () => {
    const production = resolve(import.meta.dir, "../../src/persistence/sqlite/migrations");
    const directory = join(f.root, "published-r2");
    mkdirSync(directory);
    for (const name of [
      "0001_domain.sql",
      "0002_reuse_archived_alias.sql",
      "0003_request_inputs.sql",
    ])
      copyFileSync(join(production, name), join(directory, name));
    const path = join(f.root, "published-r2.sqlite");
    let db = openDatabase(path);
    try {
      expect(migrateDatabase(db, directory)).toBe(3);
      db.run("INSERT INTO users VALUES('123',1,?)", [at]);
      db.run(
        "INSERT INTO conversations VALUES('c1','123','old','remote',NULL,'ready',?,?,NULL,0)",
        [at, at],
      );
      const requests = new SqliteRequestRepository(db);
      requests.create(request(), [attachment()]);
      requests.transition("r1", { state: "queued", at });
      requests.create(request("legacy", "9"), [attachment("legacy-file", "legacy")]);
      db.query("INSERT INTO request_inputs (request_id, payload) VALUES (?,?)").run(
        "r1",
        JSON.stringify({ text: "synthetic", attachmentIds: ["z"] }),
      );
      db.run("INSERT INTO processed_updates VALUES('1','r1',?)", [at]);
      const names = [
        "users",
        "conversations",
        "requests",
        "attachments",
        "processed_updates",
        "request_inputs",
        "sqlite_sequence",
      ];
      const rows = names.map((name) => db.query(`SELECT * FROM ${name}`).all());
      const schema = db.query("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
      const ledger = db.query("SELECT * FROM schema_migrations ORDER BY version").all();
      copyFileSync(
        join(production, "0004_request_acceptances.sql"),
        join(directory, "0004_request_acceptances.sql"),
      );
      writeFileSync(join(directory, "0005_failure.sql"), "INSERT INTO missing_table VALUES(1);");
      expect(() => migrateDatabase(db, directory)).toThrow(DatabaseError);
      db.close(true);
      db = openDatabase(path);
      expect(names.map((name) => db.query(`SELECT * FROM ${name}`).all())).toEqual(rows);
      expect(db.query("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(
        schema,
      );
      expect(db.query("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(ledger);
      expect(migrateDatabase(db)).toBe(1);
      expect(names.map((name) => db.query(`SELECT * FROM ${name}`).all())).toEqual(rows);
      expect(
        db.query("SELECT * FROM schema_migrations WHERE version<=3 ORDER BY version").all(),
      ).toEqual(ledger);
      expect(db.query("SELECT * FROM request_acceptances").all()).toEqual([{ request_id: "r1" }]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      db.close(true);
      db = openDatabase(path);
      const reopened = new SqliteRequestRepository(db),
        store = new SqliteRequestQueueRepository(db);
      expect(migrateDatabase(db)).toBe(0);
      expect(store.snapshot().queued[0].input.text).toBe("synthetic");
      db.run("DELETE FROM request_inputs");
      expect(store.snapshot().blocked.find((block) => block.requestId === "r1")?.reason).toBe(
        "input_unavailable",
      );
      reopened.transition("r1", {
        state: "failed",
        at: later,
        failureCode: "PROVIDER_UNAVAILABLE",
      });
      reopened.transition("legacy", {
        state: "failed",
        at: later,
        failureCode: "PROVIDER_UNAVAILABLE",
      });
      expect(reopened.listAttachments("r1")).toEqual([]);
      expect(reopened.listAttachments("legacy")).toEqual([attachment("legacy-file", "legacy")]);
      expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      db.close(true);
    }
  });

  test("file-only input and attachment order survive claim; mismatched/duplicate attachment IDs roll back", () => {
    f.store.accept(request(), { attachments: [attachment("z"), attachment("a")] }, 2);
    f.reopen();
    expect(f.store.claim("r1", later)?.input.attachments.map((file) => file.id)).toEqual([
      "z",
      "a",
    ]);
    expect(f.requests.get("r1")?.state).toBe("uploading");
    for (const attachments of [
      [attachment("x", "wrong")],
      [attachment("x", "r2"), attachment("x", "r2")],
    ]) {
      expect(() => f.store.accept(request("r2", "2"), { attachments }, 2)).toThrow(DatabaseError);
      expect(f.requests.get("r2")).toBeNull();
      expect(f.updates.get("2")).toBeNull();
    }
    expect(() => f.store.accept(request("empty", "3"), { attachments: [] }, 2)).toThrow(
      DatabaseError,
    );
  });

  test.each(["sending", "running", "cancel_requested", "unknown", "uploading"] as const)(
    "restart never replays %s or starts its same-key successor",
    (state) => {
      f.store.accept(
        request(),
        { text: "x", attachments: state === "uploading" ? [attachment()] : [] },
        3,
      );
      f.store.accept(request("next", "2", "alias"), { text: "next", attachments: [] }, 3);
      f.store.claim("r1", later);
      if (["running", "cancel_requested"].includes(state))
        f.requests.transition("r1", { state: "running", at: later });
      if (["cancel_requested", "unknown"].includes(state))
        f.requests.transition("r1", { state, at: later });
      f.reopen();
      expect(f.store.snapshot().blocked).toContainEqual({
        requestId: "r1",
        providerConversationId: "remote",
        reason: "reconciliation_required",
      });
      expect(f.store.claim("r1", later)).toBeNull();
      expect(f.store.claim("next", later)).toBeNull();
      expect(f.requests.get("r1")?.state).toBe(state);
    },
  );

  test.each(["missing", "malformed", "attachment", "marker", "provenance"])(
    "queued with %s input/evidence is surfaced, never fabricated or executed",
    (problem) => {
      f.store.accept(request(), { text: "x", attachments: [attachment()] }, 2);
      if (problem === "missing") f.database.run("DELETE FROM request_inputs");
      if (problem === "malformed") f.database.run("UPDATE request_inputs SET payload='invalid'");
      if (problem === "attachment") f.database.run("DELETE FROM attachments");
      if (problem === "marker") f.database.run("DELETE FROM processed_updates");
      if (problem === "provenance") f.database.run("DELETE FROM request_acceptances");
      f.reopen();
      expect(f.store.snapshot().queued).toEqual([]);
      expect(f.store.snapshot().blocked[0].reason).toBe("input_unavailable");
      expect(f.store.claim("r1", later)).toBeNull();
    },
  );

  test("archive and reused alias cannot redirect an already accepted remote target", () => {
    f.store.accept(request(), { text: "x", attachments: [] }, 2);
    f.conversations.archive("123", "c1", later);
    const other = f.conversations.get("other");
    if (!other) throw new Error("Missing fixture mapping");
    f.conversations.create({ ...other, id: "replacement", alias: "c1" });
    f.reopen();
    expect(f.store.claim("r1", later)?.providerConversationId).toBe("remote");
    expect(f.requests.get("r1")?.conversationId).toBe("c1");
    expect(() => f.store.accept(request("new", "2"), { text: "x", attachments: [] }, 2)).toThrow(
      DatabaseError,
    );
  });

  test.each([1, 2])(
    "forward upgrade from populated 000%s retains rows, old ledger and FK; rollback/reopen is complete",
    (version) => {
      const production = resolve(import.meta.dir, "../../src/persistence/sqlite/migrations");
      const directory = join(f.root, "legacy");
      mkdirSync(directory);
      for (const name of ["0001_domain.sql", "0002_reuse_archived_alias.sql"].slice(0, version))
        copyFileSync(join(production, name), join(directory, name));
      const path = join(f.root, "legacy.sqlite");
      let db = openDatabase(path);
      try {
        migrateDatabase(db, directory);
        db.run("INSERT INTO users VALUES('123',1,?)", [at]);
        db.run(
          "INSERT INTO conversations VALUES('c','123','old','opaque',NULL,'ready',?,?,NULL,1)",
          [at, at],
        );
        db.run(
          "INSERT INTO requests (id, conversation_id, telegram_update_id, state, created_at) VALUES('r','c','7','queued',?)",
          [at],
        );
        db.run("INSERT INTO processed_updates VALUES('7','r',?)", [at]);
        db.run("INSERT INTO attachments VALUES('a','r','f','file','text/plain',1,NULL,?)", [at]);
        const names = [
          "users",
          "conversations",
          "requests",
          "processed_updates",
          "attachments",
          "active_conversations",
        ];
        const rows = names.map((name) => db.query(`SELECT * FROM ${name}`).all());
        const ledger = db.query("SELECT * FROM schema_migrations ORDER BY version").all();
        copyFileSync(
          join(production, "0002_reuse_archived_alias.sql"),
          join(directory, "0002_reuse_archived_alias.sql"),
        );
        copyFileSync(
          join(production, "0003_request_inputs.sql"),
          join(directory, "0003_request_inputs.sql"),
        );
        copyFileSync(
          join(production, "0004_request_acceptances.sql"),
          join(directory, "0004_request_acceptances.sql"),
        );
        writeFileSync(join(directory, "0005_failure.sql"), "INSERT INTO missing_table VALUES(1);");
        expect(() => migrateDatabase(db, directory)).toThrow(DatabaseError);
        db.close(true);
        db = openDatabase(path);
        expect(db.query("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(ledger);
        expect(names.map((name) => db.query(`SELECT * FROM ${name}`).all())).toEqual(rows);
        expect(
          db.query("SELECT name FROM sqlite_master WHERE name='request_inputs'").all(),
        ).toEqual([]);
        expect(migrateDatabase(db)).toBe(4 - version);
        expect(names.map((name) => db.query(`SELECT * FROM ${name}`).all())).toEqual(rows);
        expect(
          db
            .query("SELECT * FROM schema_migrations WHERE version<=? ORDER BY version")
            .all(version),
        ).toEqual(ledger);
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(new SqliteRequestQueueRepository(db).snapshot().blocked[0].reason).toBe(
          "input_unavailable",
        );
        new SqliteRequestRepository(db).transition("r", {
          state: "failed",
          at: later,
          failureCode: "PROVIDER_UNAVAILABLE",
        });
        expect(db.query("SELECT * FROM attachments").all()).toEqual(rows[4]);
      } finally {
        db.close(true);
      }
    },
  );
});
