import type { Database } from "bun:sqlite";
import { z } from "zod";
import { terminalStates, type RequestTransition } from "../../domain/Request";
import {
  deliveryRetentionMs,
  maxDeliveryAttempts,
  type DeliveryAttempt,
  type DeliveryChunk,
  type DeliveryMetadata,
  type ResultDeliveryRepository,
} from "../../ports/ResultDeliveryRepository";
import type { RequestResult, RequestResultRepository } from "../../ports/RequestResultRepository";
import { DatabaseError } from "./Database";
import { repositoryOperation } from "./repositoryOperation";
import { SqliteRequestRepository } from "./SqliteRequestRepository";

const payloadSchema = z.strictObject({
  message: z.strictObject({ text: z.string(), id: z.string().min(1).optional() }).optional(),
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .optional(),
});
const planSchema = z.array(z.strictObject({ html: z.string(), plain: z.string() })).min(1);
function canonicalTime(at: string): string {
  return new Date(z.iso.datetime().parse(at)).toISOString();
}
const metadataSchema = z.strictObject({
  requestId: z.string().min(1),
  state: z.enum(["pending", "delivered", "failed", "expired"]),
  attempts: z.number().int().min(0).max(maxDeliveryAttempts),
  nextChunk: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime(),
  nextAttemptAt: z.iso.datetime().optional(),
  failureCode: z.enum(["TELEGRAM_DELIVERY_FAILED", "TELEGRAM_DELIVERY_EXPIRED"]).optional(),
});
type Row = {
  requestId: string;
  state: DeliveryMetadata["state"];
  attempts: number;
  nextChunk: number;
  expiresAt: string;
  nextAttemptAt: string | null;
  failureCode: DeliveryMetadata["failureCode"] | null;
  payload: string | null;
  plan: string | null;
};
const columns = `request_id AS requestId,state,attempts,next_chunk AS nextChunk,
  expires_at AS expiresAt,next_attempt_at AS nextAttemptAt,failure_code AS failureCode`;
function metadata(row: Omit<Row, "payload" | "plan">): DeliveryMetadata {
  return metadataSchema.parse({
    requestId: row.requestId,
    state: row.state,
    attempts: row.attempts,
    nextChunk: row.nextChunk,
    expiresAt: row.expiresAt,
    ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt } : {}),
    ...(row.failureCode ? { failureCode: row.failureCode } : {}),
  });
}

export class SqliteRequestResultRepository
  implements RequestResultRepository, ResultDeliveryRepository
{
  private readonly requests: SqliteRequestRepository;
  constructor(private readonly database: Database) {
    this.requests = new SqliteRequestRepository(database);
  }

  settle(
    id: string,
    transition: RequestTransition,
    output: Omit<RequestResult, "request">,
  ): RequestResult {
    return repositoryOperation(() =>
      this.database
        .transaction(() => {
          if (
            !terminalStates.includes(transition.state) ||
            (transition.state !== "completed" && output.message !== undefined)
          )
            throw new DatabaseError("invalid_request_input");
          const payload = payloadSchema.parse(output);
          const request = this.requests.transition(id, transition);
          const at = canonicalTime(transition.at);
          this.database
            .query(`INSERT INTO request_deliveries
        (request_id,state,result_payload,created_at,expires_at,next_attempt_at) VALUES (?,'pending',?,?,?,?)`)
            .run(
              id,
              JSON.stringify(payload),
              at,
              new Date(Date.parse(at) + deliveryRetentionMs).toISOString(),
              at,
            );
          return { request, ...payload };
        })
        .immediate(),
    );
  }

  due(at: string): readonly string[] {
    return repositoryOperation(() => {
      const time = canonicalTime(at);
      return this.database
        .query<{ id: string }, [string]>(
          "SELECT request_id AS id FROM request_deliveries WHERE state='pending' AND next_attempt_at<=? ORDER BY created_at,request_id LIMIT 100",
        )
        .all(time)
        .map((row) => row.id);
    });
  }

  start(id: string, at: string): DeliveryAttempt | null {
    return repositoryOperation(() =>
      this.database
        .transaction(() => {
          const time = canonicalTime(at);
          this.expire(time);
          const row = this.database
            .query<Row, [string]>(
              `SELECT ${columns},result_payload AS payload,plan FROM request_deliveries WHERE request_id=?`,
            )
            .get(id);
          if (!row || row.state !== "pending" || !row.nextAttemptAt || row.nextAttemptAt > time)
            return null;
          const request = this.requests.get(id);
          if (!request || !terminalStates.includes(request.state))
            throw new DatabaseError("invalid_request_input");
          const payload = payloadSchema.parse(JSON.parse(row.payload as string));
          const plan = row.plan === null ? undefined : planSchema.parse(JSON.parse(row.plan));
          if (row.nextChunk > (plan?.length ?? 0)) throw new DatabaseError("invalid_request_input");
          if (plan && row.nextChunk === plan.length) {
            this.complete(id, row.attempts, time);
            return null;
          }
          if (row.attempts >= maxDeliveryAttempts) {
            this.database
              .query(
                "UPDATE request_deliveries SET state='failed',next_attempt_at=NULL,failure_code='TELEGRAM_DELIVERY_FAILED' WHERE request_id=?",
              )
              .run(id);
            return null;
          }
          this.database
            .query("UPDATE request_deliveries SET attempts=attempts+1 WHERE request_id=?")
            .run(id);
          return {
            ...metadata(row),
            attempts: row.attempts + 1,
            result: { request, ...payload },
            ...(plan ? { plan } : {}),
          };
        })
        .immediate(),
    );
  }

  savePlan(id: string, attempt: number, chunks: readonly DeliveryChunk[]): void {
    repositoryOperation(() => {
      const plan = planSchema.parse(chunks);
      const updated = this.database
        .query(
          "UPDATE request_deliveries SET plan=? WHERE request_id=? AND state='pending' AND attempts=? AND plan IS NULL AND next_chunk=0",
        )
        .run(JSON.stringify(plan), id, attempt);
      if (updated.changes !== 1) throw new DatabaseError("invalid_request_input");
    });
  }

  acknowledge(id: string, attempt: number, nextChunk: number): void {
    repositoryOperation(() => {
      z.number().int().positive().parse(nextChunk);
      const updated = this.database
        .query(
          "UPDATE request_deliveries SET next_chunk=? WHERE request_id=? AND state='pending' AND attempts=? AND next_chunk=? AND plan IS NOT NULL AND next_chunk<json_array_length(plan)",
        )
        .run(nextChunk, id, attempt, nextChunk - 1);
      if (updated.changes !== 1) throw new DatabaseError("invalid_request_input");
    });
  }

  complete(id: string, attempt: number, at: string): void {
    repositoryOperation(() =>
      this.database
        .transaction(() => {
          const time = canonicalTime(at);
          const row = this.database
            .query<Row, [string]>(
              `SELECT ${columns},result_payload AS payload,plan FROM request_deliveries WHERE request_id=?`,
            )
            .get(id);
          if (
            !row ||
            row.state !== "pending" ||
            row.attempts !== attempt ||
            row.plan === null ||
            row.nextChunk !== planSchema.parse(JSON.parse(row.plan)).length
          )
            throw new DatabaseError("invalid_request_input");
          this.database
            .query(
              "UPDATE request_deliveries SET state='delivered',result_payload=NULL,plan=NULL,next_attempt_at=NULL,failure_code=NULL,delivered_at=? WHERE request_id=?",
            )
            .run(time, id);
        })
        .immediate(),
    );
  }

  fail(id: string, attempt: number, at: string, nextAttemptAt?: string): void {
    repositoryOperation(() => {
      const time = canonicalTime(at);
      const next = nextAttemptAt ? canonicalTime(nextAttemptAt) : undefined;
      if (next && next <= time) throw new DatabaseError("invalid_request_input");
      this.database
        .query(`UPDATE request_deliveries SET
        state=CASE WHEN ? IS NOT NULL AND attempts<? AND ?<expires_at THEN 'pending' ELSE 'failed' END,
        next_attempt_at=CASE WHEN ? IS NOT NULL AND attempts<? AND ?<expires_at THEN ? ELSE NULL END,
        failure_code='TELEGRAM_DELIVERY_FAILED' WHERE request_id=? AND state='pending' AND attempts=?`)
        .run(
          next ?? null,
          maxDeliveryAttempts,
          next ?? null,
          next ?? null,
          maxDeliveryAttempts,
          next ?? null,
          next ?? null,
          id,
          attempt,
        );
      this.expire(time);
    });
  }

  expire(at: string): void {
    repositoryOperation(() => {
      const time = canonicalTime(at);
      this.database
        .query(
          `UPDATE request_deliveries SET
            state=CASE WHEN plan IS NOT NULL AND next_chunk=json_array_length(plan) THEN 'delivered' ELSE 'expired' END,
            delivered_at=CASE WHEN plan IS NOT NULL AND next_chunk=json_array_length(plan) THEN ? ELSE NULL END,
            failure_code=CASE WHEN plan IS NOT NULL AND next_chunk=json_array_length(plan) THEN NULL ELSE 'TELEGRAM_DELIVERY_EXPIRED' END,
            result_payload=NULL,plan=NULL,next_attempt_at=NULL
            WHERE state IN ('pending','failed') AND expires_at<=?`,
        )
        .run(time, time);
    });
  }

  diagnostics(): readonly DeliveryMetadata[] {
    return repositoryOperation(() =>
      this.database
        .query<Omit<Row, "payload" | "plan">, []>(
          `SELECT ${columns} FROM request_deliveries WHERE state!='delivered' ORDER BY created_at,request_id`,
        )
        .all()
        .map(metadata),
    );
  }
}
