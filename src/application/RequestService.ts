import { z } from "zod";
import { type Request, terminalStates } from "../domain/Request";
import type { RequestInput } from "../domain/RequestInput";
import {
  type ChatProvider,
  type ProviderAssistantMessage,
  type ProviderCancelResult,
  type ProviderHealth,
  type ProviderObservation,
  type ProviderOutcome,
  type ProviderRequestReference,
  type ProviderSendResult,
  type ProviderSubmission,
  providerCancelResultSchema,
  providerCapabilitiesSchema,
  providerHealthSchema,
  providerObservationSchema,
  providerOutcomeSchema,
  providerSendResultSchema,
} from "../ports/ChatProvider";
import type {
  QueueSnapshot,
  QueueWork,
  RequestQueueRepository,
} from "../ports/RequestQueueRepository";
import type { RequestRepository } from "../ports/RequestRepository";
import { RequestQueue } from "../queue/RequestQueue";

export type RequestResult = Readonly<{
  request: Request;
  message?: ProviderAssistantMessage;
  errorCode?: string;
}>;
export type StopResult = Readonly<{
  kind: "nothing_running" | "unsupported" | "requested" | "already_requested";
  requestId?: string;
}>;
type Dependencies = Readonly<{
  queueRepository: RequestQueueRepository;
  requests: RequestRepository;
  provider: ChatProvider;
  options: Readonly<{ maxPendingPerConversation: number; generationTimeoutMs: number }>;
  now: () => string;
  onResult: (result: RequestResult) => void | Promise<void>;
  scheduleDeadline?: (milliseconds: number, expire: () => void) => () => void;
}>;
type ActiveRequest = {
  work: QueueWork;
  submission?: ProviderSubmission;
  controller?: AbortController;
  cancellation?: Promise<ProviderCancelResult>;
};

export class RequestService {
  private readonly queue: RequestQueue;
  private readonly active = new Map<string, ActiveRequest>();
  private readonly deliveryFailures = new Set<string>();
  private readonly capabilities;
  private readonly options;
  private readonly scheduleDeadline;
  private started = false;
  private startup: Promise<QueueSnapshot> | undefined;
  private stopping = false;
  private providerHealth: ProviderHealth | undefined;

  constructor(private readonly dependencies: Dependencies) {
    this.capabilities = providerCapabilitiesSchema.parse(dependencies.provider.capabilities);
    const limit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
    this.options = z
      .strictObject({
        maxPendingPerConversation: limit,
        generationTimeoutMs: limit.max(2_147_483_647),
      })
      .parse(dependencies.options);
    this.scheduleDeadline =
      dependencies.scheduleDeadline ??
      ((milliseconds: number, expire: () => void) => {
        const timer = setTimeout(expire, milliseconds);
        return () => clearTimeout(timer);
      });
    this.queue = new RequestQueue(
      dependencies.queueRepository,
      {
        maxPendingPerConversation: this.options.maxPendingPerConversation,
        maxConcurrentConversations: this.capabilities.maxConcurrentConversations,
        reserveUncertainConversations: true,
      },
      (work) => this.execute(work),
      dependencies.now,
    );
  }

  start(): Promise<QueueSnapshot> {
    if (this.started || this.stopping) throw new Error("REQUEST_SERVICE_ALREADY_STARTED");
    this.started = true;
    this.startup = this.initialize();
    return this.startup;
  }

  private async initialize(): Promise<QueueSnapshot> {
    await this.health();
    await this.reconcile();
    return this.stopping ? this.dependencies.queueRepository.snapshot() : this.queue.start();
  }

  accept(request: Request, input: RequestInput) {
    return this.queue.accept(request, input);
  }
  waitForIdle(): Promise<void> {
    return this.queue.waitForIdle();
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    await this.queue.shutdown();
    await this.startup;
  }

  status() {
    return {
      ...this.queue.status(),
      providerHealth: this.providerHealth,
      deliveryFailures: [...this.deliveryFailures],
    };
  }

  async health(): Promise<ProviderHealth> {
    try {
      this.providerHealth = providerHealthSchema.parse(await this.dependencies.provider.health());
    } catch {
      this.providerHealth = { state: "unavailable", observedAt: this.dependencies.now() };
    }
    return this.providerHealth;
  }

  // R4 resolves/authorizes the selected mapping before supplying this exact opaque key.
  stop(providerConversationId: string): StopResult {
    const active = this.active.get(providerConversationId);
    if (!active?.submission || !active.controller) return { kind: "nothing_running" };
    const current = this.dependencies.requests.get(active.work.request.id);
    if (!current || !["running", "cancel_requested"].includes(current.state))
      return { kind: "nothing_running" };
    if (!this.capabilities.cancellation) return { kind: "unsupported", requestId: current.id };
    if (active.cancellation) return { kind: "already_requested", requestId: current.id };
    this.dependencies.requests.transition(current.id, {
      state: "cancel_requested",
      at: this.dependencies.now(),
    });
    active.cancellation = this.cancel(active);
    return { kind: "requested", requestId: current.id };
  }

  private async execute(work: QueueWork): Promise<void> {
    const active: ActiveRequest = { work };
    this.active.set(work.providerConversationId, active);
    const reference = this.reference(work.request, work.providerConversationId);
    try {
      const health = await this.health();
      if (health.state !== "ready") {
        await this.failBeforeSend(
          work,
          health.state === "auth_required" ? "AUTH_REQUIRED" : "PROVIDER_UNAVAILABLE",
        );
        return;
      }
      if (
        work.input.attachments.length > 0 &&
        (!this.capabilities.fileUpload ||
          work.input.attachments.some((file) => !file.temporaryStorageKey))
      ) {
        await this.failBeforeSend(work, "ATTACHMENT_REJECTED");
        return;
      }
      if (work.request.state === "uploading")
        this.dependencies.requests.transition(work.request.id, {
          state: "sending",
          at: this.dependencies.now(),
        });
      let sent: ProviderSendResult;
      try {
        sent = providerSendResultSchema.parse(
          await this.dependencies.provider.send({
            conversationId: work.providerConversationId,
            clientRequestId: work.request.id,
            text: work.input.text,
            attachments: work.input.attachments.map((file) => ({
              storageKey: file.temporaryStorageKey as string,
              filename: file.filename,
              mimeType: file.mimeType,
              sizeBytes: file.sizeBytes,
            })),
          }),
        );
        if (!this.matches(sent, reference)) sent = this.unknown(reference);
      } catch {
        sent = this.unknown(reference);
      }
      if (sent.state === "not_submitted") {
        await this.failBeforeSend(work, sent.code);
        return;
      }
      if (sent.state === "unknown") {
        await this.settle(work.request.id, sent);
        return;
      }
      this.dependencies.requests.transition(work.request.id, {
        state: "running",
        at: this.dependencies.now(),
        providerRequestId: sent.providerRequestId,
      });
      active.submission = Object.freeze(sent);
      active.controller = new AbortController();
      let expired = false;
      const clearDeadline = this.scheduleDeadline(this.options.generationTimeoutMs, () => {
        expired = true;
        active.controller?.abort();
      });
      let outcome: ProviderOutcome;
      try {
        try {
          outcome = providerOutcomeSchema.parse(
            await this.dependencies.provider.awaitCompletion({
              submission: sent,
              signal: active.controller.signal,
            }),
          );
          if (!this.matches(outcome, sent)) outcome = this.unknown(sent);
        } catch {
          outcome = this.unknown(sent);
        }
        if (expired && outcome.state === "unknown")
          outcome = this.unknown(sent, "GENERATION_TIMEOUT");
        // Both operations must finish before settlement/key release, even when completion wins.
        if (active.cancellation) {
          const cancellation = await active.cancellation;
          outcome = this.combine(outcome, cancellation);
        }
      } finally {
        clearDeadline();
      }
      await this.settle(work.request.id, outcome);
    } finally {
      this.active.delete(work.providerConversationId);
    }
  }

  private async cancel(active: ActiveRequest): Promise<ProviderCancelResult> {
    const submission = active.submission as ProviderSubmission;
    let result: ProviderCancelResult;
    try {
      result = providerCancelResultSchema.parse(
        await this.dependencies.provider.cancel(submission),
      );
      if (!this.matches(result, submission)) result = this.unknown(submission);
    } catch {
      result = this.unknown(submission);
    }
    if (result.state !== "not_cancelled") active.controller?.abort();
    return result;
  }

  private combine(outcome: ProviderOutcome, cancellation: ProviderCancelResult): ProviderOutcome {
    if (outcome.state === "completed") return outcome;
    if (cancellation.state === "completed") return cancellation;
    if (
      outcome.state === "unknown" &&
      cancellation.state !== "not_cancelled" &&
      cancellation.state !== "unknown"
    )
      return cancellation;
    return outcome;
  }

  private async failBeforeSend(work: QueueWork, code: string): Promise<void> {
    const current = this.dependencies.requests.get(work.request.id) as Request;
    const request = this.dependencies.requests.transition(current.id, {
      state: "failed",
      at: this.dependencies.now(),
      failureCode: current.state === "sending" ? "SEND_FAILED_PRE_SUBMIT" : code,
    });
    await this.deliver({ request, errorCode: code });
  }

  private async settle(id: string, evidence: ProviderOutcome): Promise<void> {
    const request = this.dependencies.requests.transition(id, {
      state: evidence.state,
      at: this.dependencies.now(),
      failureCode: evidence.state === "failed" ? evidence.code : undefined,
    });
    await this.deliver({
      request,
      message: evidence.state === "completed" ? evidence.message : undefined,
      errorCode: "code" in evidence ? evidence.code : undefined,
    });
  }

  // Delivery is auxiliary only after durable provider settlement; failure cannot reclassify or resubmit it.
  private async deliver(result: RequestResult): Promise<void> {
    try {
      await this.dependencies.onResult(result);
    } catch {
      this.deliveryFailures.add(result.request.id);
    }
  }

  private async reconcile(): Promise<void> {
    const snapshot = this.dependencies.queueRepository.snapshot();
    for (const block of snapshot.blocked) {
      const current = this.dependencies.requests.get(block.requestId);
      if (
        !current ||
        terminalStates.includes(current.state) ||
        block.reason === "input_unavailable"
      )
        continue;
      const reference = this.reference(current, block.providerConversationId);
      let evidence: ProviderObservation;
      try {
        evidence = providerObservationSchema.parse(
          await this.dependencies.provider.inspectRequest(reference),
        );
        if (!this.matches(evidence, reference)) evidence = this.unknown(reference);
      } catch {
        evidence = this.unknown(reference);
      }
      if (evidence.state === "not_submitted" && !current.submittedAt) {
        const request = this.dependencies.requests.transition(current.id, {
          state: "failed",
          at: this.dependencies.now(),
          failureCode: current.state === "sending" ? "SEND_FAILED_PRE_SUBMIT" : evidence.code,
        });
        await this.deliver({ request, errorCode: evidence.code });
        continue;
      }
      // Running at restart is not terminal evidence. R3 never resumes/replays an interrupted prompt.
      const outcome =
        evidence.state === "running" || evidence.state === "not_submitted"
          ? this.unknown(reference)
          : evidence;
      if (outcome.state !== "unknown" && !current.submittedAt) {
        if (current.state === "uploading")
          this.dependencies.requests.transition(current.id, {
            state: "sending",
            at: this.dependencies.now(),
          });
        this.dependencies.requests.transition(current.id, {
          state: "running",
          at: this.dependencies.now(),
          providerRequestId: outcome.providerRequestId,
        });
      }
      await this.settle(current.id, outcome);
    }
  }

  private reference(request: Request, conversationId: string): ProviderRequestReference {
    return {
      conversationId,
      clientRequestId: request.id,
      providerRequestId: request.providerRequestId,
    };
  }

  private matches(
    evidence: ProviderSendResult | ProviderObservation | ProviderCancelResult,
    reference: ProviderRequestReference,
  ): boolean {
    return (
      evidence.clientRequestId === reference.clientRequestId &&
      evidence.conversationId === reference.conversationId &&
      (!reference.providerRequestId ||
        ("providerRequestId" in evidence &&
          evidence.providerRequestId === reference.providerRequestId) ||
        evidence.state === "unknown" ||
        evidence.state === "not_cancelled")
    );
  }

  private unknown(
    reference: ProviderRequestReference,
    code: "SUBMISSION_STATE_UNKNOWN" | "GENERATION_TIMEOUT" = "SUBMISSION_STATE_UNKNOWN",
  ): ProviderOutcome & { state: "unknown" } {
    return {
      conversationId: reference.conversationId,
      clientRequestId: reference.clientRequestId,
      state: "unknown",
      code,
    };
  }
}
