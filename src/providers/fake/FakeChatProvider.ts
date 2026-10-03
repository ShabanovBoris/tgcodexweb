import {
  type ChatProvider,
  type ProviderCancelResult,
  type ProviderCapabilities,
  type ProviderConversation,
  type ProviderHealth,
  type ProviderObservation,
  type ProviderOutcome,
  type ProviderRequestReference,
  type ProviderSendInput,
  type ProviderSendResult,
  type ProviderSubmission,
  ProviderOperationError,
  providerCapabilitiesSchema,
} from "../../ports/ChatProvider";

export class FakeBarrier {
  readonly promise: Promise<void>;
  release!: () => void;
  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
}

export type FakeScenario = Readonly<{
  kind:
    | "success"
    | "slow"
    | "pre_submit_failure"
    | "throw_before_submit"
    | "ambiguous_submit"
    | "confirmed_submit_then_failure"
    | "generation_failure"
    | "timeout"
    | "cancellation_success"
    | "cancellation_completion_race"
    | "cancellation_generation_failure"
    | "cancellation_generation_timeout"
    | "provider_unavailable"
    | "authentication_required";
  text?: string;
  timeoutStopped?: boolean;
  sendGate?: FakeBarrier;
  cancelGate?: FakeBarrier;
}>;
type Operation = {
  submission: ProviderSubmission;
  scenario: FakeScenario;
  observation: ProviderObservation;
  finished: FakeBarrier;
};

// This provider holds only synthetic remote state. No filesystem, network, real clock or sleeps.
export class FakeChatProvider implements ChatProvider {
  readonly capabilities: ProviderCapabilities;
  readonly sendCalls: string[] = [];
  readonly cancelCalls: string[] = [];
  readonly inspections: string[] = [];
  readonly submissions: ProviderSendInput[] = [];
  readonly maximumActive = new Map<string, number>();
  private healthState: ProviderHealth["state"] = "ready";
  private readonly conversations: Set<string>;
  private readonly plans = new Map<string, FakeScenario>();
  private readonly operations = new Map<string, Operation>();
  private readonly active = new Map<string, string>();
  private readonly signals = new Map<string, FakeBarrier>();
  private nextConversation = 1;

  constructor(
    options: Readonly<{
      capabilities?: ProviderCapabilities;
      conversations?: readonly string[];
    }> = {},
  ) {
    this.capabilities = providerCapabilitiesSchema.parse(
      options.capabilities ?? {
        maxConcurrentConversations: 2,
        cancellation: true,
        fileUpload: true,
      },
    );
    this.conversations = new Set(options.conversations ?? ["remote", "Remote"]);
  }

  plan(requestId: string, scenario: FakeScenario): void {
    if (this.operations.has(requestId)) throw new Error("FAKE_ALREADY_SUBMITTED");
    this.plans.set(requestId, { ...scenario });
  }

  setHealth(state: ProviderHealth["state"]): void {
    this.healthState = state;
  }

  async health(): Promise<ProviderHealth> {
    return { state: this.healthState, observedAt: "2026-10-01T00:00:00.000Z" };
  }

  async createConversation(
    _input?: Readonly<{ titleHint?: string }>,
  ): Promise<ProviderConversation> {
    this.requireReady();
    let id: string;
    do {
      id = `fake-conversation-${this.nextConversation++}`;
    } while (this.conversations.has(id));
    this.conversations.add(id);
    return { id };
  }

  async inspectConversation(reference: string): Promise<ProviderConversation> {
    this.requireReady();
    if (!this.conversations.has(reference)) throw new ProviderOperationError("CHAT_NOT_FOUND");
    return { id: reference };
  }

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    const id = input.clientRequestId;
    const identity = { clientRequestId: id, conversationId: input.conversationId };
    this.sendCalls.push(id);
    this.signal(`send:${id}`).release();
    const scenario = this.plans.get(id) ?? { kind: "success" };
    if (scenario.sendGate) await scenario.sendGate.promise;
    if (scenario.kind === "throw_before_submit") throw new Error("FAKE_SEND_INTERRUPTED");
    if (this.healthState !== "ready")
      return {
        ...identity,
        state: "not_submitted",
        code: this.healthState === "auth_required" ? "AUTH_REQUIRED" : "PROVIDER_UNAVAILABLE",
      };
    if (!this.conversations.has(input.conversationId))
      return { ...identity, state: "not_submitted", code: "CHAT_NOT_FOUND" };
    if (input.attachments.length > 0 && !this.capabilities.fileUpload)
      return { ...identity, state: "not_submitted", code: "ATTACHMENT_REJECTED" };
    if (
      ["pre_submit_failure", "provider_unavailable", "authentication_required"].includes(
        scenario.kind,
      )
    ) {
      return {
        ...identity,
        state: "not_submitted",
        code:
          scenario.kind === "provider_unavailable"
            ? "PROVIDER_UNAVAILABLE"
            : scenario.kind === "authentication_required"
              ? "AUTH_REQUIRED"
              : "SEND_FAILED_PRE_SUBMIT",
      };
    }
    if (this.operations.has(id)) throw new Error("FAKE_DUPLICATE_SEND");
    if (
      this.active.has(input.conversationId) ||
      this.active.size >= this.capabilities.maxConcurrentConversations
    )
      throw new Error("FAKE_CONCURRENT_MUTATION");
    const submission: ProviderSubmission = {
      ...identity,
      state: "submitted",
      providerRequestId: `fake-${id}`,
    };
    this.operations.set(id, {
      submission,
      scenario,
      observation: { ...submission, state: "running" },
      finished: new FakeBarrier(),
    });
    this.submissions.push(structuredClone(input));
    this.active.set(input.conversationId, id);
    this.maximumActive.set(input.conversationId, 1);
    if (scenario.kind === "ambiguous_submit") throw new Error("FAKE_SEND_INTERRUPTED");
    return { ...submission };
  }

  async awaitCompletion(
    input: Readonly<{ submission: ProviderSubmission; signal: AbortSignal }>,
  ): Promise<ProviderOutcome> {
    const operation = this.lookup(input.submission);
    const id = input.submission.clientRequestId;
    this.signal(`waiting:${id}`).release();
    if (!operation) return this.unknown(input.submission);
    const { scenario } = operation;
    if (scenario.kind === "confirmed_submit_then_failure")
      throw new Error("FAKE_OBSERVATION_FAILED");
    if (scenario.kind === "success") this.complete(id, scenario.text ?? "fake response");
    if (scenario.kind === "generation_failure")
      this.finish(id, { ...operation.submission, state: "failed", code: "GENERATION_FAILED" });
    if (scenario.kind === "timeout") {
      if (!scenario.timeoutStopped) return this.unknown(input.submission, "GENERATION_TIMEOUT");
      this.finish(id, { ...operation.submission, state: "timeout" });
    }
    const aborted = new FakeBarrier();
    const onAbort = () => aborted.release();
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) aborted.release();
    try {
      await Promise.race([operation.finished.promise, aborted.promise]);
      const observation = operation.observation;
      return observation.state === "running" || observation.state === "not_submitted"
        ? this.unknown(input.submission)
        : structuredClone(observation);
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
  }

  async cancel(reference: ProviderRequestReference): Promise<ProviderCancelResult> {
    this.cancelCalls.push(reference.clientRequestId);
    this.signal(`cancel:${reference.clientRequestId}`).release();
    if (!this.capabilities.cancellation)
      return {
        conversationId: reference.conversationId,
        clientRequestId: reference.clientRequestId,
        state: "not_cancelled",
      };
    const operation = this.lookup(reference);
    if (!operation) return this.unknown(reference);
    if (operation.scenario.cancelGate) await operation.scenario.cancelGate.promise;
    if (operation.observation.state === "running") {
      if (operation.scenario.kind === "cancellation_completion_race")
        this.complete(reference.clientRequestId, operation.scenario.text ?? "completion won");
      else if (operation.scenario.kind === "cancellation_generation_failure")
        this.finish(reference.clientRequestId, {
          ...operation.submission,
          state: "failed",
          code: "GENERATION_FAILED",
        });
      else if (operation.scenario.kind === "cancellation_generation_timeout")
        this.finish(reference.clientRequestId, { ...operation.submission, state: "timeout" });
      else this.finish(reference.clientRequestId, { ...operation.submission, state: "cancelled" });
    }
    const observation = operation.observation;
    return observation.state === "running" || observation.state === "not_submitted"
      ? this.unknown(reference)
      : structuredClone(observation);
  }

  async inspectRequest(reference: ProviderRequestReference): Promise<ProviderObservation> {
    this.inspections.push(reference.clientRequestId);
    return structuredClone(this.lookup(reference)?.observation ?? this.unknown(reference));
  }

  sent(id: string): Promise<void> {
    return this.signal(`send:${id}`).promise;
  }
  waiting(id: string): Promise<void> {
    return this.signal(`waiting:${id}`).promise;
  }
  cancelling(id: string): Promise<void> {
    return this.signal(`cancel:${id}`).promise;
  }

  partial(id: string, text: string): void {
    const operation = this.operations.get(id);
    if (operation?.observation.state !== "running") throw new Error("FAKE_NOT_RUNNING");
    operation.observation = { ...operation.submission, state: "running", partialText: text };
  }

  complete(id: string, text = "fake response"): void {
    const operation = this.operations.get(id);
    if (!operation) throw new Error("FAKE_NOT_SUBMITTED");
    this.finish(id, { ...operation.submission, state: "completed", message: { text } });
  }

  private finish(id: string, outcome: ProviderOutcome): void {
    const operation = this.operations.get(id);
    if (operation?.observation.state !== "running") throw new Error("FAKE_NOT_RUNNING");
    operation.observation = outcome;
    this.active.delete(operation.submission.conversationId);
    operation.finished.release();
  }

  private lookup(reference: ProviderRequestReference): Operation | undefined {
    const operation = this.operations.get(reference.clientRequestId);
    return operation?.submission.conversationId === reference.conversationId &&
      (!reference.providerRequestId ||
        operation.submission.providerRequestId === reference.providerRequestId)
      ? operation
      : undefined;
  }

  private signal(key: string): FakeBarrier {
    let signal = this.signals.get(key);
    if (!signal) {
      signal = new FakeBarrier();
      this.signals.set(key, signal);
    }
    return signal;
  }

  private unknown(
    reference: ProviderRequestReference,
    code: "SUBMISSION_STATE_UNKNOWN" | "GENERATION_TIMEOUT" = "SUBMISSION_STATE_UNKNOWN",
  ): ProviderOutcome & { state: "unknown" } {
    return {
      state: "unknown",
      conversationId: reference.conversationId,
      clientRequestId: reference.clientRequestId,
      code,
    };
  }

  private requireReady(): void {
    if (this.healthState !== "ready")
      throw new ProviderOperationError(
        this.healthState === "auth_required" ? "AUTH_REQUIRED" : "PROVIDER_UNAVAILABLE",
      );
  }
}
