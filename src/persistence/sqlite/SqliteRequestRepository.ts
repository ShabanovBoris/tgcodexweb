import type { Database } from "bun:sqlite";
import { type Attachment, attachmentSchema } from "../../domain/Attachment";
import {
  type Request,
  type RequestTransition,
  requestSchema,
  terminalStates,
  transitionRequest,
} from "../../domain/Request";
import type { RequestRepository } from "../../ports/RequestRepository";
import { DatabaseError } from "./Database";
import { repositoryOperation } from "./repositoryOperation";

type RequestRow = Omit<
  Request,
  | "telegramMessageId"
  | "startedAt"
  | "submittedAt"
  | "finishedAt"
  | "providerRequestId"
  | "failureCode"
> & {
  telegramMessageId: string | null;
  startedAt: string | null;
  submittedAt: string | null;
  finishedAt: string | null;
  providerRequestId: string | null;
  failureCode: string | null;
};
const columns = `id, conversation_id AS conversationId, telegram_update_id AS telegramUpdateId,
  telegram_message_id AS telegramMessageId, state, created_at AS createdAt, started_at AS startedAt,
  submitted_at AS submittedAt, finished_at AS finishedAt, provider_request_id AS providerRequestId, failure_code AS failureCode`;

// SQL null преобразуется только на persistence boundary, не становясь business failure value.
function requestFromRow(row: RequestRow): Request {
  return requestSchema.parse({
    ...row,
    telegramMessageId: row.telegramMessageId ?? undefined,
    startedAt: row.startedAt ?? undefined,
    submittedAt: row.submittedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
    providerRequestId: row.providerRequestId ?? undefined,
    failureCode: row.failureCode ?? undefined,
  });
}

// Храним lifecycle evidence, не conversational history; queue/recovery orchestration принадлежит будущим фазам.
export class SqliteRequestRepository implements RequestRepository {
  constructor(private readonly database: Database) {}

  // Durable requestId и attachment FK появляются вместе, ещё до provider submission.
  create(input: Request, attachmentInputs: readonly Attachment[] = []): void {
    const request = requestSchema.parse(input);
    const attachments = attachmentInputs.map((attachment) => attachmentSchema.parse(attachment));
    if (
      request.state !== "created" ||
      attachments.some((attachment) => attachment.requestId !== request.id)
    )
      throw new DatabaseError("invalid_request_input");
    repositoryOperation(() =>
      this.database
        .transaction(() => {
          this.database
            .query(`INSERT INTO requests (id, conversation_id, telegram_update_id, telegram_message_id, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
            .run(
              request.id,
              request.conversationId,
              request.telegramUpdateId,
              request.telegramMessageId ?? null,
              request.state,
              request.createdAt,
            );
          for (const attachment of attachments) {
            this.database
              .query(`INSERT INTO attachments (id, request_id, source_file_id, filename, mime_type, size_bytes, temporary_storage_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(
                attachment.id,
                attachment.requestId,
                attachment.sourceFileId,
                attachment.filename,
                attachment.mimeType,
                attachment.sizeBytes,
                attachment.temporaryStorageKey ?? null,
                attachment.createdAt,
              );
          }
        })
        .immediate(),
    );
  }

  // Null означает отсутствие entity; technical error остаётся DATABASE_ERROR.
  get(id: string): Request | null {
    return repositoryOperation(() => {
      const row = this.database
        .query<RequestRow, [string]>(`SELECT ${columns} FROM requests WHERE id=?`)
        .get(id);
      return row ? requestFromRow(row) : null;
    });
  }

  // UNIQUE ingress identity не позволяет создать второй request даже до R2 service.
  findByUpdate(telegramUpdateId: string): Request | null {
    return repositoryOperation(() => {
      const row = this.database
        .query<RequestRow, [string]>(`SELECT ${columns} FROM requests WHERE telegram_update_id=?`)
        .get(telegramUpdateId);
      return row ? requestFromRow(row) : null;
    });
  }

  // Возвращаем evidence для будущего reconciliation, не выполняя requeue или replay.
  listUnfinished(): Request[] {
    return repositoryOperation(() =>
      this.database
        .query<RequestRow, string[]>(
          `SELECT ${columns} FROM requests WHERE state NOT IN (${terminalStates.map(() => "?").join(",")}) ORDER BY created_at, id`,
        )
        .all(...terminalStates)
        .map(requestFromRow),
    );
  }

  // BEGIN IMMEDIATE связывает чтение/reducer/update; другой connection не может перезаписать stale state.
  transition(id: string, transition: RequestTransition): Request {
    return repositoryOperation(() =>
      this.database
        .transaction(() => {
          const current = this.get(id);
          if (!current) throw new DatabaseError("entity_not_found");
          const next = transitionRequest(current, transition);
          const fields = [
            ["state", "state"],
            ["startedAt", "started_at"],
            ["submittedAt", "submitted_at"],
            ["finishedAt", "finished_at"],
            ["providerRequestId", "provider_request_id"],
            ["failureCode", "failure_code"],
          ] as const;
          const changed = fields.filter(([key]) => current[key] !== next[key]);
          this.database
            .query(
              `UPDATE requests SET ${changed.map(([, column]) => `${column}=?`).join(",")} WHERE id=?`,
            )
            .run(...changed.map(([key]) => next[key] ?? null), id);
          return next;
        })
        .immediate(),
    );
  }

  // Метаданные не открывают файлы; generated key разрешается только будущим attachment store.
  listAttachments(requestId: string): Attachment[] {
    return repositoryOperation(() =>
      this.database
        .query<
          Omit<Attachment, "temporaryStorageKey"> & { temporaryStorageKey: string | null },
          [string]
        >(
          `SELECT id, request_id AS requestId, source_file_id AS sourceFileId, filename, mime_type AS mimeType, size_bytes AS sizeBytes, temporary_storage_key AS temporaryStorageKey, created_at AS createdAt FROM attachments WHERE request_id=? ORDER BY created_at, id`,
        )
        .all(requestId)
        .map((row) =>
          attachmentSchema.parse({
            ...row,
            temporaryStorageKey: row.temporaryStorageKey ?? undefined,
          }),
        ),
    );
  }
}
