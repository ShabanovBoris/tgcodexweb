import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment } from "../../src/domain/Attachment";
import type { Request } from "../../src/domain/Request";
import { openDatabase } from "../../src/persistence/sqlite/Database";
import { migrateDatabase } from "../../src/persistence/sqlite/migrations";
import { SqliteConversationRepository } from "../../src/persistence/sqlite/SqliteConversationRepository";
import { SqliteRequestQueueRepository } from "../../src/persistence/sqlite/SqliteRequestQueueRepository";
import { SqliteRequestRepository } from "../../src/persistence/sqlite/SqliteRequestRepository";
import { SqliteUpdateDedupRepository } from "../../src/persistence/sqlite/SqliteUpdateDedupRepository";

export const at = "2026-10-01T00:00:00.000Z";
export const later = "2026-10-01T00:00:01.000Z";

// Both suites share synthetic inputs so acceptance and execution verify the same contract.
export function request(id = "r1", update = "1", conversationId = "c1"): Request {
  return { id, telegramUpdateId: update, conversationId, state: "created", createdAt: at };
}

// Attachment ordering deliberately differs from lexical ordering and timestamps are identical.
export function attachment(id = "z", requestId = "r1"): Attachment {
  return {
    id,
    requestId,
    sourceFileId: `source-${id}`,
    filename: "../synthetic.ts",
    mimeType: "text/plain",
    sizeBytes: 10,
    temporaryStorageKey: `storage_${id}`,
    createdAt: at,
  };
}

// Reopen discards every adapter and retains only the on-disk database.
export class QueueFixture {
  readonly root = mkdtempSync(join(tmpdir(), "tgcodexweb-r2-"));
  readonly path = join(this.root, "gateway.sqlite");
  database!: Database;
  conversations!: SqliteConversationRepository;
  requests!: SqliteRequestRepository;
  updates!: SqliteUpdateDedupRepository;
  store!: SqliteRequestQueueRepository;
  constructor() {
    this.open();
    migrateDatabase(this.database);
    this.conversations.putUser({ telegramUserId: "123", enabled: true, createdAt: at });
    this.mapping("c1", "remote");
    this.mapping("alias", "remote");
    this.mapping("other", "Remote");
  }
  // Provider IDs remain opaque; case differences really identify separate keys.
  mapping(id: string, provider: string): void {
    this.conversations.create({
      id,
      alias: id,
      providerConversationId: provider,
      telegramUserId: "123",
      status: "ready",
      archived: false,
      createdAt: at,
      updatedAt: at,
    });
  }
  // A new connection ensures no in-memory queue order can leak through restart tests.
  open(): void {
    this.database = openDatabase(this.path);
    this.conversations = new SqliteConversationRepository(this.database);
    this.requests = new SqliteRequestRepository(this.database);
    this.updates = new SqliteUpdateDedupRepository(this.database);
    this.store = new SqliteRequestQueueRepository(this.database);
  }
  // Tests reopen after committing or rolling back actual SQLite transactions.
  reopen(): void {
    this.database.close(true);
    this.open();
  }
  // Fixture cleanup owns only its generated temporary directory.
  close(): void {
    this.database.close(true);
    rmSync(this.root, { recursive: true, force: true });
  }
  // The deterministic executor supplies synthetic completion evidence, never a network call.
  complete(id: string): void {
    if (this.requests.get(id)?.state === "uploading")
      this.requests.transition(id, { state: "sending", at: later });
    this.requests.transition(id, {
      state: "running",
      at: later,
      providerRequestId: `provider-${id}`,
    });
    this.requests.transition(id, { state: "completed", at: later });
  }
}
