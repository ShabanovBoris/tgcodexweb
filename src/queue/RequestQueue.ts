import { z } from "zod";
import { type Request, terminalStates } from "../domain/Request";
import type { RequestInput } from "../domain/RequestInput";
import type {
  AcceptanceResult,
  QueueSnapshot,
  QueueWork,
  RequestQueueRepository,
} from "../ports/RequestQueueRepository";

type QueueOptions = Readonly<{
  maxPendingPerConversation: number;
  maxConcurrentConversations: number;
  reserveUncertainConversations?: boolean;
}>;
type AdmissionResult = AcceptanceResult | Readonly<{ kind: "rejected"; code: "QUEUE_NOT_RUNNING" }>;
type QueuePhase = "idle" | "running" | "stopping" | "stopped" | "error";

// Queue владеет admission и локальными critical sections; durable FIFO/input остаются у repository.
// Executor обязан завершить lifecycle до resolve и охватывает всю remote mutation, не только send.
export class RequestQueue {
  private phase: QueuePhase = "idle";
  private readonly active = new Map<string, { requestId: string; done: Promise<void> }>();
  private readonly executionFailures = new Set<string>();
  private errorCode: "QUEUE_STORAGE_FAILED" | undefined;
  private readonly options: QueueOptions;
  constructor(
    private readonly repository: RequestQueueRepository,
    options: QueueOptions,
    private readonly execute: (work: QueueWork) => Promise<void>,
    private readonly now: () => string,
  ) {
    const limit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
    this.options = z
      .strictObject({
        maxPendingPerConversation: limit,
        maxConcurrentConversations: limit,
        reserveUncertainConversations: z.boolean().optional(),
      })
      .readonly()
      .parse(options);
  }

  // Startup сначала читает recovery evidence; ambiguity остаётся блокирующей, без provider reconciliation R3.
  start(): QueueSnapshot {
    if (this.phase !== "idle") throw new Error("QUEUE_ALREADY_STARTED");
    const recovery = this.repository.snapshot();
    this.phase = "running";
    this.pump();
    return recovery;
  }

  // После durable acceptance ошибка scheduling не отменяет принятый input и не заставляет caller создавать второй request.
  accept(request: Request, input: RequestInput): AdmissionResult {
    if (this.phase !== "running") return { kind: "rejected", code: "QUEUE_NOT_RUNNING" };
    const result = this.repository.accept(request, input, this.options.maxPendingPerConversation);
    if (result.kind === "accepted") this.pump();
    return result;
  }

  // Diagnostics содержит только operational IDs, без input или raw executor errors.
  status() {
    return {
      phase: this.phase,
      activeRequestIds: [...this.active.values()].map((active) => active.requestId),
      executionFailures: [...this.executionFailures],
      errorCode: this.errorCode,
    };
  }

  // Quiescence может включать blocked queued work: ожидание не выполняет небезопасный replay.
  async waitForIdle(): Promise<void> {
    while (this.active.size > 0)
      await Promise.all([...this.active.values()].map((active) => active.done));
  }

  // Stop не отменяет remote mutation: ждём уже начатые effects, а queued input оставляем durable для restart.
  async shutdown(): Promise<void> {
    if (this.phase === "stopped") return;
    this.phase = "stopping";
    await this.waitForIdle();
    this.phase = "stopped";
  }

  // Claim фиксирует старт до первого await; active map ограничивает только этот runtime, SQL повторно проверяет key/FIFO.
  private pump(): void {
    if (this.phase !== "running") return;
    try {
      const snapshot = this.repository.snapshot();
      const blockedKeys = new Set(snapshot.blocked.map((block) => block.providerConversationId));
      // R3 cannot release provider capacity while an uncertain remote generation may still exist.
      const occupiedKeys = new Set(this.active.keys());
      if (this.options.reserveUncertainConversations)
        for (const block of snapshot.blocked)
          if (block.reason === "reconciliation_required")
            occupiedKeys.add(block.providerConversationId);
      for (const candidate of snapshot.queued) {
        if (occupiedKeys.size >= this.options.maxConcurrentConversations) break;
        const key = candidate.providerConversationId;
        if (this.active.has(key) || blockedKeys.has(key)) continue;
        const work = this.repository.claim(candidate.request.id, this.now());
        if (!work) continue;
        // Microtask запускает executor после регистрации ownership, включая синхронный throw в callback.
        const done = Promise.resolve().then(() => this.run(work));
        this.active.set(key, { requestId: work.request.id, done });
        occupiedKeys.add(key);
      }
    } catch {
      this.errorCode = "QUEUE_STORAGE_FAILED";
      this.phase = "error";
    }
  }

  // Promise failure не доказывает pre-submit failure; текущий durable state сохраняется, его key блокируется snapshot.
  private async run(work: QueueWork): Promise<void> {
    const key = work.providerConversationId,
      requestId = work.request.id;
    try {
      await this.execute(work);
    } catch {
      this.executionFailures.add(requestId);
    }
    try {
      const current = this.repository.getRequest(requestId);
      if (!current || !terminalStates.includes(current.state))
        this.executionFailures.add(requestId);
    } catch {
      this.errorCode = "QUEUE_STORAGE_FAILED";
      if (this.phase === "running") this.phase = "error";
    }
    this.active.delete(key);
    this.pump();
  }
}
