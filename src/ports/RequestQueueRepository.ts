import type { Request } from "../domain/Request";
import type { RequestInput } from "../domain/RequestInput";
import type { ProcessedUpdate } from "./UpdateDedupRepository";

export type AcceptanceResult =
  | Readonly<{ kind: "accepted"; requestId: string }>
  | Readonly<{ kind: "duplicate"; update: ProcessedUpdate }>
  | Readonly<{ kind: "rejected"; code: "QUEUE_FULL" }>;

export type QueueWork = Readonly<{
  request: Request;
  input: RequestInput;
  providerConversationId: string;
  sequence: number;
}>;
export type QueueBlock = Readonly<{
  requestId: string;
  providerConversationId: string;
  reason: "reconciliation_required" | "input_unavailable";
}>;
export type QueueSnapshot = Readonly<{
  queued: readonly QueueWork[];
  blocked: readonly QueueBlock[];
}>;

// Compound port нужен для одной atomic acceptance: отдельные repository calls не связывают marker с payload.
// Snapshot согласует payload/lifecycle; claim проверяет FIFO и сохраняет начало работы до внешнего effect.
export interface RequestQueueRepository {
  accept(
    request: Request,
    input: RequestInput,
    maxPendingPerConversation: number,
  ): AcceptanceResult;
  snapshot(): QueueSnapshot;
  claim(requestId: string, at: string): QueueWork | null;
  getRequest(requestId: string): Request | null;
}
