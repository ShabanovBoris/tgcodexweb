import type { Database } from "bun:sqlite";
import { z } from "zod";
import { canonicalConversationKey } from "../../domain/Conversation";
import { type Request, requestSchema } from "../../domain/Request";
import { type RequestInput, requestInputSchema } from "../../domain/RequestInput";
import type {
  AcceptanceResult,
  QueueSnapshot,
  QueueWork,
  RequestQueueRepository,
} from "../../ports/RequestQueueRepository";
import { DatabaseError } from "./Database";
import { repositoryOperation } from "./repositoryOperation";
import { SqliteConversationRepository } from "./SqliteConversationRepository";
import { SqliteRequestRepository } from "./SqliteRequestRepository";
import { SqliteUpdateDedupRepository } from "./SqliteUpdateDedupRepository";

// Только порядок IDs хранится рядом с text: business metadata attachments имеет один источник истины.
const storedInputSchema = z.strictObject({
  text: z.string().min(1).optional(),
  attachmentIds: z.array(z.string().min(1)).refine((ids) => new Set(ids).size === ids.length),
});
type QueueRow = {
  requestId: string;
  providerConversationId: string;
  sequence: number | null;
  payload: string | null;
};

// Все adapters используют один connection: BEGIN IMMEDIATE охватывает dedup, capacity, request, input и QUEUED.
export class SqliteRequestQueueRepository implements RequestQueueRepository {
  private readonly requests: SqliteRequestRepository;
  private readonly updates: SqliteUpdateDedupRepository;
  private readonly conversations: SqliteConversationRepository;
  constructor(private readonly database: Database) {
    this.requests = new SqliteRequestRepository(database);
    this.updates = new SqliteUpdateDedupRepository(database);
    this.conversations = new SqliteConversationRepository(database);
  }

  // Durable marker проверяется первым: duplicate не меняет ни mapping, ни исходный payload даже при полной очереди.
  accept(
    requestInput: Request,
    inputValue: RequestInput,
    maxPendingPerConversation: number,
  ): AcceptanceResult {
    return repositoryOperation(() =>
      this.database
        .transaction((): AcceptanceResult => {
          z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(maxPendingPerConversation);
          const request = requestSchema.parse(requestInput);
          const updateId = request.telegramUpdateId;
          const duplicate = this.updates.get(updateId);
          if (duplicate) return { kind: "duplicate", update: duplicate };
          const input = requestInputSchema.parse(inputValue);
          if (
            request.state !== "created" ||
            input.attachments.some((file) => file.requestId !== request.id)
          )
            throw new DatabaseError("invalid_request_input");
          const conversation = this.conversations.get(request.conversationId);
          if (!conversation || conversation.archived || conversation.status !== "ready")
            throw new DatabaseError("invalid_selection");
          const key = canonicalConversationKey(conversation);
          const pending = this.database
            .query<{ count: number }, [string]>(
              `SELECT count(*) AS count FROM requests r JOIN conversations c ON c.id=r.conversation_id
         WHERE r.state IN ('created','queued') AND c.provider_conversation_id=?`,
            )
            .all(key)[0].count;
          if (pending >= maxPendingPerConversation) return { kind: "rejected", code: "QUEUE_FULL" };
          this.requests.create(request, input.attachments);
          this.database.query("INSERT INTO request_inputs (request_id, payload) VALUES (?,?)").run(
            request.id,
            JSON.stringify({
              text: input.text,
              attachmentIds: input.attachments.map((file) => file.id),
            }),
          );
          this.updates.record({
            telegramUpdateId: updateId,
            requestId: request.id,
            processedAt: request.createdAt,
          });
          this.requests.transition(request.id, { state: "queued", at: request.createdAt });
          return { kind: "accepted", requestId: request.id };
        })
        .immediate(),
    );
  }

  // Один read transaction возвращает lifecycle и input из одного durable frame; invalid input никогда не синтезируется.
  snapshot(): QueueSnapshot {
    return repositoryOperation(() =>
      this.database.transaction(() => {
        const queued: QueueWork[] = [];
        const blocked: QueueSnapshot["blocked"][number][] = [];
        const rows = this.database
          .query<QueueRow, []>(
            `SELECT r.id AS requestId, c.provider_conversation_id AS providerConversationId, i.sequence, i.payload
         FROM requests r JOIN conversations c ON c.id=r.conversation_id LEFT JOIN request_inputs i ON i.request_id=r.id
         WHERE r.state NOT IN ('completed','failed','cancelled','timeout') ORDER BY i.sequence, r.id`,
          )
          .all();
        for (const row of rows) {
          const request = this.requests.get(row.requestId) as Request;
          const work = request.state === "queued" ? this.readWork(row, request) : null;
          if (work) queued.push(work);
          else
            blocked.push({
              requestId: row.requestId,
              providerConversationId: row.providerConversationId,
              reason:
                request.state === "queued" || request.state === "created"
                  ? "input_unavailable"
                  : "reconciliation_required",
            });
        }
        return { queued, blocked };
      })(),
    );
  }

  // Повторная проверка под write lock закрывает race между snapshot и claim; запись precedes первый await executor.
  claim(requestId: string, at: string): QueueWork | null {
    return repositoryOperation(() =>
      this.database
        .transaction(() => {
          const snapshot = this.snapshot();
          const candidate = snapshot.queued.find((work) => work.request.id === requestId);
          if (
            !candidate ||
            snapshot.blocked.some(
              (block) => block.providerConversationId === candidate.providerConversationId,
            )
          )
            return null;
          const first = snapshot.queued.find(
            (work) => work.providerConversationId === candidate.providerConversationId,
          );
          if (first?.request.id !== requestId) return null;
          const request = this.requests.transition(requestId, {
            state: candidate.input.attachments.length > 0 ? "uploading" : "sending",
            at,
          });
          return { ...candidate, request };
        })
        .immediate(),
    );
  }

  // Queue проверяет durable settlement после executor; Promise completion сама по себе не является provider evidence.
  getRequest(requestId: string): Request | null {
    return this.requests.get(requestId);
  }

  // Recovery требует полный исходный input и его marker: часть attachments или чужая ссылка делают replay недоказанным.
  private readWork(row: QueueRow, request: Request): QueueWork | null {
    if (row.sequence === null || row.payload === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(row.payload);
    } catch {
      return null;
    }
    const parsed = storedInputSchema.safeParse(value);
    if (!parsed.success || this.updates.get(request.telegramUpdateId)?.requestId !== request.id)
      return null;
    const attachments = this.requests.listAttachments(request.id);
    const byId = new Map(attachments.map((file) => [file.id, file]));
    if (
      attachments.length !== parsed.data.attachmentIds.length ||
      parsed.data.attachmentIds.some((id) => !byId.has(id))
    )
      return null;
    const input = requestInputSchema.safeParse({
      text: parsed.data.text,
      attachments: parsed.data.attachmentIds.map((id) => byId.get(id)),
    });
    return input.success
      ? {
          request,
          input: input.data,
          sequence: row.sequence,
          providerConversationId: row.providerConversationId,
        }
      : null;
  }
}
