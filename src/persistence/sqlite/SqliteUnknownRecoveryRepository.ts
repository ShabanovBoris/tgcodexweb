import type { Database } from "bun:sqlite";
import { z } from "zod";
import { DatabaseError } from "./Database";
import { repositoryOperation } from "./repositoryOperation";
import { SqliteConversationRepository } from "./SqliteConversationRepository";
import { SqliteRequestRepository } from "./SqliteRequestRepository";

const resolutionSchema = z
  .strictObject({
    requestId: z.string().min(1),
    providerConversationId: z.string().min(1),
    confirmedAt: z.iso.datetime(),
    resolution: z.literal("operator_confirmed_completed"),
  })
  .readonly();
type Resolution = z.infer<typeof resolutionSchema>;

// Called only by offline maintenance under the gateway lease. This is an operator
// assertion of completed remote work, not fabricated provider evidence or a state transition.
export class SqliteUnknownRecoveryRepository {
  constructor(private readonly database: Database) {}

  confirmCompleted(requestId: string, confirmedAt: string): Resolution {
    return repositoryOperation(() =>
      this.database
        .transaction(() => {
          z.iso.datetime().parse(confirmedAt);
          const request = new SqliteRequestRepository(this.database).get(requestId);
          if (!request) throw new DatabaseError("entity_not_found");
          if (
            request.state !== "unknown" ||
            !request.finishedAt ||
            Date.parse(confirmedAt) < Date.parse(request.finishedAt)
          )
            throw new DatabaseError("invalid_request_input");
          const mapping = new SqliteConversationRepository(this.database).get(
            request.conversationId,
          );
          if (!mapping) throw new DatabaseError("entity_not_found");
          const previous = this.database
            .query<Resolution, [string]>(
              `SELECT request_id AS requestId, provider_conversation_id AS providerConversationId,
         confirmed_at AS confirmedAt, resolution FROM request_unknown_resolutions WHERE request_id=?`,
            )
            .get(requestId);
          if (previous) {
            const resolution = resolutionSchema.parse(previous);
            if (resolution.providerConversationId !== mapping.providerConversationId)
              throw new DatabaseError("invalid_request_input");
            return resolution;
          }
          const resolution = resolutionSchema.parse({
            requestId,
            providerConversationId: mapping.providerConversationId,
            confirmedAt,
            resolution: "operator_confirmed_completed",
          });
          this.database
            .query(`INSERT INTO request_unknown_resolutions
        (request_id, provider_conversation_id, confirmed_at, resolution) VALUES (?, ?, ?, ?)`)
            .run(
              resolution.requestId,
              resolution.providerConversationId,
              resolution.confirmedAt,
              resolution.resolution,
            );
          return resolution;
        })
        .immediate(),
    );
  }
}
