import type { Database } from "bun:sqlite";
import { type Attachment, attachmentSchema } from "../../domain/Attachment";
import type { Request } from "../../domain/Request";
import type { RequestInput } from "../../domain/RequestInput";
import {
  type AttachmentBatch,
  type AttachmentBatchItem,
  type AttachmentBatchRepository,
  batchText,
} from "../../ports/AttachmentBatchRepository";
import { DatabaseError } from "./Database";
import { repositoryOperation } from "./repositoryOperation";
import { SqliteUpdateDedupRepository } from "./SqliteUpdateDedupRepository";

const columns =
  "id, telegram_user_id AS userId, telegram_chat_id AS chatId, media_group_id AS groupId, conversation_id AS conversationId, created_at AS createdAt, expires_at AS expiresAt, state";

export class SqliteAttachmentBatchRepository implements AttachmentBatchRepository {
  constructor(private readonly database: Database) {}

  getOpen(userId: string): AttachmentBatch | null {
    return repositoryOperation(() =>
      this.database
        .query<AttachmentBatch, [string]>(
          `SELECT ${columns} FROM attachment_batches WHERE telegram_user_id=? AND state='open'`,
        )
        .get(userId),
    );
  }
  getGroup(userId: string, chatId: string, groupId: string): AttachmentBatch | null {
    return repositoryOperation(() =>
      this.database
        .query<AttachmentBatch, [string, string, string]>(
          `SELECT ${columns} FROM attachment_batches WHERE telegram_user_id=? AND telegram_chat_id=? AND media_group_id=?`,
        )
        .get(userId, chatId, groupId),
    );
  }
  items(batchId: string): AttachmentBatchItem[] {
    return repositoryOperation(() =>
      this.database
        .query<
          Attachment & { updateId: string; messageId: number; caption: string | null },
          [string]
        >(
          `SELECT id, batch_id AS requestId, telegram_update_id AS updateId, telegram_message_id AS messageId, caption, source_file_id AS sourceFileId, filename, mime_type AS mimeType, size_bytes AS sizeBytes, temporary_storage_key AS temporaryStorageKey, created_at AS createdAt FROM attachment_batch_items WHERE batch_id=? ORDER BY telegram_message_id`,
        )
        .all(batchId)
        .map(({ updateId, messageId, caption, ...file }) => ({
          updateId,
          messageId,
          caption: caption ?? undefined,
          attachment: attachmentSchema.parse(file),
        })),
    );
  }
  append(batch: AttachmentBatch, item: AttachmentBatchItem): void {
    repositoryOperation(() =>
      this.database
        .transaction(() => {
          const existing = this.getGroup(batch.userId, batch.chatId, batch.groupId);
          if (
            batch.state !== "open" ||
            item.attachment.requestId !== batch.id ||
            (existing && (existing.id !== batch.id || existing.state !== "open"))
          )
            throw new DatabaseError("invalid_request_input");
          if (!existing)
            this.database
              .query(
                "INSERT INTO attachment_batches (id, telegram_user_id, telegram_chat_id, media_group_id, conversation_id, created_at, expires_at, state) VALUES (?,?,?,?,?,?,?,?)",
              )
              .run(
                batch.id,
                batch.userId,
                batch.chatId,
                batch.groupId,
                batch.conversationId,
                batch.createdAt,
                batch.expiresAt,
                batch.state,
              );
          const file = attachmentSchema.parse(item.attachment);
          new SqliteUpdateDedupRepository(this.database).record({
            telegramUpdateId: item.updateId,
            processedAt: file.createdAt,
          });
          this.database
            .query(
              "INSERT INTO attachment_batch_items (id, batch_id, telegram_update_id, telegram_message_id, caption, source_file_id, filename, mime_type, size_bytes, temporary_storage_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              file.id,
              batch.id,
              item.updateId,
              item.messageId,
              item.caption ?? null,
              file.sourceFileId,
              file.filename,
              file.mimeType,
              file.sizeBytes,
              file.temporaryStorageKey ?? null,
              file.createdAt,
            );
        })
        .immediate(),
    );
  }
  close(userId: string, batchId: string): readonly Attachment[] {
    return repositoryOperation(() =>
      this.database
        .transaction(() => {
          if (this.getOpen(userId)?.id !== batchId)
            throw new DatabaseError("invalid_request_input");
          const files = this.items(batchId).map((item) => item.attachment);
          this.database
            .query("UPDATE attachment_batches SET state='closed' WHERE id=? AND telegram_user_id=?")
            .run(batchId, userId);
          this.database.query("DELETE FROM attachment_batch_items WHERE batch_id=?").run(batchId);
          return files;
        })
        .immediate(),
    );
  }
  expire(at: string): void {
    repositoryOperation(() =>
      this.database
        .transaction(() => {
          this.database
            .query(
              "UPDATE attachment_batches SET state='closed' WHERE state='open' AND expires_at<=?",
            )
            .run(at);
          this.database
            .query(
              "DELETE FROM attachment_batch_items WHERE batch_id IN (SELECT id FROM attachment_batches WHERE state='closed')",
            )
            .run();
        })
        .immediate(),
    );
  }
  retainedStorageKeys(): ReadonlySet<string> {
    return repositoryOperation(
      () =>
        new Set(
          this.database
            .query<{ key: string }, []>(
              "SELECT temporary_storage_key AS key FROM attachments WHERE temporary_storage_key IS NOT NULL UNION SELECT temporary_storage_key AS key FROM attachment_batch_items",
            )
            .all()
            .map((row) => row.key),
        ),
    );
  }

  // Called inside queue acceptance's transaction, before dispatch can start. No remote effects here.
  completeAcceptance(request: Request, input: RequestInput): void {
    repositoryOperation(() => {
      const batch = this.database
        .query<AttachmentBatch, [string]>(`SELECT ${columns} FROM attachment_batches WHERE id=?`)
        .get(input.attachmentBatchId as string);
      if (
        batch?.state !== "open" ||
        batch.id !== request.id ||
        batch.conversationId !== request.conversationId ||
        batch.expiresAt <= request.createdAt
      )
        throw new DatabaseError("invalid_request_input");
      const items = this.items(batch.id);
      if (
        !items.length ||
        batchText(items) !== input.text ||
        JSON.stringify(items.map((item) => item.attachment)) !== JSON.stringify(input.attachments)
      )
        throw new DatabaseError("invalid_request_input");
      for (const item of items) {
        const result = this.database
          .query(
            "UPDATE processed_updates SET request_id=? WHERE telegram_update_id=? AND request_id IS NULL",
          )
          .run(request.id, item.updateId);
        if (result.changes !== 1) throw new DatabaseError("invalid_request_input");
      }
      this.close(batch.userId, batch.id);
    });
  }
}
