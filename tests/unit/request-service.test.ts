import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type RequestResult, RequestService } from "../../src/application/RequestService";
import type {
  ProviderCancelResult,
  ProviderOutcome,
  ProviderRequestReference,
  ProviderSendInput,
  ProviderSendResult,
  ProviderSubmission,
} from "../../src/ports/ChatProvider";
import { FakeBarrier, FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
import { attachment, later, QueueFixture, request } from "../fixtures/queue";

let f: QueueFixture;
beforeEach(() => {
  f = new QueueFixture();
});
afterEach(() => f.close());

function setup(
  provider = new FakeChatProvider(),
  overrides: Partial<ConstructorParameters<typeof RequestService>[0]> = {},
) {
  const results: RequestResult[] = [];
  const service = new RequestService({
    queueRepository: f.store,
    requests: f.requests,
    provider,
    options: { maxPendingPerConversation: 3, generationTimeoutMs: 600000 },
    now: () => later,
    onResult: (result) => {
      results.push(result);
    },
    ...overrides,
  });
  return { service, provider, results };
}

describe("R3 request lifecycle", () => {
  test("service composition rejects a generation deadline beyond the runtime timer limit", () => {
    expect(() =>
      setup(new FakeChatProvider(), {
        options: { maxPendingPerConversation: 3, generationTimeoutMs: 2147483648 },
      }),
    ).toThrow();
  });
  test("AC-D01/D02/E01 success submits exact input once and returns only a final answer", async () => {
    const { service, provider, results } = setup();
    provider.plan("r1", { kind: "success", text: "4" });
    await service.start();
    expect(service.accept(request(), { text: "2+2?", attachments: [] }).kind).toBe("accepted");
    expect(service.accept(request("other-id"), { text: "changed", attachments: [] }).kind).toBe(
      "duplicate",
    );
    await service.waitForIdle();
    expect(provider.submissions).toEqual([
      {
        conversationId: "remote",
        clientRequestId: "r1",
        text: "2+2?",
        attachments: [],
      },
    ]);
    expect(f.requests.get("r1")).toMatchObject({
      state: "completed",
      submittedAt: later,
      providerRequestId: "fake-r1",
    });
    expect(results[0].message?.text).toBe("4");
    expect(f.database.query("SELECT * FROM request_inputs").all()).toEqual([]);
    expect(service.accept(request("third-id"), { text: "changed", attachments: [] }).kind).toBe(
      "duplicate",
    );
    expect(provider.submissions).toHaveLength(1);
    await service.shutdown();
  });

  test("AC-D03 slow generation and partial text remain running until completion evidence", async () => {
    const { service, provider, results } = setup();
    provider.plan("r1", { kind: "slow" });
    await service.start();
    service.accept(request(), { text: "synthetic", attachments: [] });
    await provider.waiting("r1");
    provider.partial("r1", "partial");
    expect(f.requests.get("r1")?.state).toBe("running");
    expect(results).toEqual([]);
    provider.complete("r1", "final");
    await service.waitForIdle();
    expect(results[0].message?.text).toBe("final");
    expect(f.requests.get("r1")?.state).toBe("completed");
    await service.shutdown();
  });

  test("pre-submit evidence fails safely and advances the same-key queue without retry", async () => {
    const { service, provider } = setup();
    provider.plan("r1", { kind: "pre_submit_failure" });
    await service.start();
    service.accept(request(), { text: "first", attachments: [] });
    service.accept(request("r2", "2", "alias"), { text: "next", attachments: [] });
    await service.waitForIdle();
    expect(f.requests.get("r1")).toMatchObject({
      state: "failed",
      failureCode: "SEND_FAILED_PRE_SUBMIT",
    });
    expect(f.requests.get("r1")?.submittedAt).toBeUndefined();
    expect(provider.submissions.map((input) => input.clientRequestId)).toEqual(["r2"]);
    expect(f.requests.get("r2")?.state).toBe("completed");
    await service.shutdown();
  });

  test("confirmed submission then exception preserves evidence and blocks successors", async () => {
    const { service, provider } = setup();
    provider.plan("r1", { kind: "confirmed_submit_then_failure" });
    await service.start();
    service.accept(request(), { text: "first", attachments: [] });
    service.accept(request("r2", "2"), { text: "next", attachments: [] });
    service.accept(request("r3", "3", "other"), { text: "independent", attachments: [] });
    await service.waitForIdle();
    expect(f.requests.get("r1")).toMatchObject({
      state: "unknown",
      providerRequestId: "fake-r1",
      submittedAt: later,
    });
    expect(f.requests.get("r2")?.state).toBe("queued");
    expect(f.requests.get("r3")?.state).toBe("completed");
    expect(provider.submissions.map((input) => input.clientRequestId)).toEqual(["r1", "r3"]);
    await service.shutdown();
  });

  test("attachments pass only generated storage references in accepted order", async () => {
    const { service, provider } = setup();
    await service.start();
    service.accept(request(), { attachments: [attachment("z"), attachment("a")] });
    await service.waitForIdle();
    expect(provider.submissions[0].attachments.map((input) => input.storageKey)).toEqual([
      "storage_z",
      "storage_a",
    ]);
    expect(provider.submissions[0].attachments[0]).not.toHaveProperty("sourceFileId");
    expect(f.requests.listAttachments("r1")).toEqual([]);
    await service.shutdown();
  });

  test.each(["throw_before_submit", "ambiguous_submit"] as const)(
    "a thrown %s is unknown rather than inferred pre-submit failure",
    async (kind) => {
      const { service, provider } = setup();
      provider.plan("r1", { kind });
      await service.start();
      service.accept(request(), { text: "synthetic", attachments: [] });
      service.accept(request("next", "2"), { text: "queued", attachments: [] });
      await service.waitForIdle();
      expect(f.requests.get("r1")).toMatchObject({ state: "unknown" });
      expect(f.requests.get("r1")?.submittedAt).toBeUndefined();
      expect(f.requests.get("next")?.state).toBe("queued");
      expect(provider.sendCalls).toEqual(["r1"]);
      expect(provider.submissions).toHaveLength(kind === "ambiguous_submit" ? 1 : 0);
      await service.shutdown();
    },
  );

  test.each(["auth_required", "unavailable"] as const)(
    "health %s prevents send and exposes a distinct normalized reason",
    async (state) => {
      const { service, provider, results } = setup();
      provider.setHealth(state);
      await service.start();
      service.accept(request(), { text: "synthetic", attachments: [] });
      await service.waitForIdle();
      expect(provider.sendCalls).toEqual([]);
      expect(f.requests.get("r1")?.state).toBe("failed");
      expect(results[0].errorCode).toBe(
        state === "auth_required" ? "AUTH_REQUIRED" : "PROVIDER_UNAVAILABLE",
      );
      expect(service.status().providerHealth?.state).toBe(state);
      await service.shutdown();
    },
  );

  test.each(["authentication_required", "provider_unavailable"] as const)(
    "%s at send retains normalized pre-submit evidence",
    async (kind) => {
      const { service, provider, results } = setup();
      provider.plan("r1", { kind });
      await service.start();
      service.accept(request(), { text: "synthetic", attachments: [] });
      await service.waitForIdle();
      expect(provider.sendCalls).toEqual(["r1"]);
      expect(provider.submissions).toEqual([]);
      expect(results[0].errorCode).toBe(
        kind === "authentication_required" ? "AUTH_REQUIRED" : "PROVIDER_UNAVAILABLE",
      );
      expect(f.requests.get("r1")?.submittedAt).toBeUndefined();
      await service.shutdown();
    },
  );

  test.each([true, false])(
    "timeout requires stopped evidence=%s before releasing a remote key",
    async (timeoutStopped) => {
      const { service, provider } = setup();
      provider.plan("r1", { kind: "timeout", timeoutStopped });
      await service.start();
      service.accept(request(), { text: "synthetic", attachments: [] });
      service.accept(request("next", "2"), { text: "next", attachments: [] });
      await service.waitForIdle();
      expect(f.requests.get("r1")?.state).toBe(timeoutStopped ? "timeout" : "unknown");
      expect(f.requests.get("next")?.state).toBe(timeoutStopped ? "completed" : "queued");
      expect(provider.submissions).toHaveLength(timeoutStopped ? 2 : 1);
      await service.shutdown();
    },
  );

  test("application deadline aborts only the observer and preserves unresolved capacity", async () => {
    let expire!: () => void;
    let cleared = 0;
    const provider = new FakeChatProvider({
      capabilities: { maxConcurrentConversations: 1, cancellation: true, fileUpload: true },
    });
    const { service, results } = setup(provider, {
      scheduleDeadline: (milliseconds, callback) => {
        expect(milliseconds).toBe(600000);
        expire = callback;
        return () => {
          cleared++;
        };
      },
    });
    provider.plan("r1", { kind: "slow" });
    await service.start();
    service.accept(request(), { text: "synthetic", attachments: [] });
    service.accept(request("next", "2", "other"), { text: "independent", attachments: [] });
    await provider.waiting("r1");
    expire();
    await service.waitForIdle();
    expect(f.requests.get("r1")?.state).toBe("unknown");
    expect(results[0].errorCode).toBe("GENERATION_TIMEOUT");
    expect(f.requests.get("next")?.state).toBe("queued");
    expect(provider.sendCalls).toEqual(["r1"]);
    expect(provider.cancelCalls).toEqual([]);
    expect(cleared).toBe(1);
    expect(
      (await provider.inspectRequest({ conversationId: "remote", clientRequestId: "r1" })).state,
    ).toBe("running");
    await service.shutdown();
  });

  test("confirmed generation failure settles once and does not block the next prompt", async () => {
    const { service, provider } = setup();
    provider.plan("r1", { kind: "generation_failure" });
    await service.start();
    service.accept(request(), { text: "first", attachments: [] });
    service.accept(request("next", "2"), { text: "next", attachments: [] });
    await service.waitForIdle();
    expect(f.requests.get("r1")).toMatchObject({
      state: "failed",
      failureCode: "GENERATION_FAILED",
      providerRequestId: "fake-r1",
    });
    expect(provider.sendCalls).toEqual(["r1", "next"]);
    await service.shutdown();
  });

  test.each(["unsupported", "missing_storage"])(
    "attachment %s rejects before send without opening source paths",
    async (mode) => {
      const provider = new FakeChatProvider({
        capabilities: {
          maxConcurrentConversations: 2,
          cancellation: true,
          fileUpload: mode !== "unsupported",
        },
      });
      const { service, results } = setup(provider);
      await service.start();
      service.accept(request(), {
        attachments: [
          {
            ...attachment(),
            temporaryStorageKey: mode === "missing_storage" ? undefined : "storage_z",
          },
        ],
      });
      await service.waitForIdle();
      expect(provider.sendCalls).toEqual([]);
      expect(results[0].errorCode).toBe("ATTACHMENT_REJECTED");
      expect(f.requests.get("r1")).toMatchObject({
        state: "failed",
        failureCode: "ATTACHMENT_REJECTED",
      });
      expect(f.requests.listAttachments("r1")).toEqual([]);
      await service.shutdown();
    },
  );

  test("AC-E02/E03/E05 aliases share FIFO through the whole generation", async () => {
    const { service, provider } = setup();
    for (const id of ["z", "a", "m"]) provider.plan(id, { kind: "slow" });
    await service.start();
    service.accept(request("z", "1"), { text: "first", attachments: [] });
    service.accept(request("a", "2", "alias"), { text: "second", attachments: [] });
    service.accept(request("m", "3"), { text: "third", attachments: [] });
    for (const [index, id] of ["z", "a", "m"].entries()) {
      await provider.waiting(id);
      expect(provider.sendCalls).toEqual(["z", "a", "m"].slice(0, index + 1));
      provider.complete(id);
    }
    await service.waitForIdle();
    expect(service.status().executionFailures).toEqual([]);
    expect(provider.maximumActive.get("remote")).toBe(1);
    await service.shutdown();
  });

  test.each([1, 2])(
    "AC-E04 global capability %s controls independent exact opaque keys",
    async (maxConcurrentConversations) => {
      const provider = new FakeChatProvider({
        capabilities: { maxConcurrentConversations, cancellation: true, fileUpload: true },
      });
      const { service } = setup(provider);
      provider.plan("r1", { kind: "slow" });
      provider.plan("r2", { kind: "slow" });
      await service.start();
      service.accept(request(), { text: "first", attachments: [] });
      service.accept(request("r2", "2", "other"), { text: "second", attachments: [] });
      await provider.waiting("r1");
      if (maxConcurrentConversations === 2) await provider.waiting("r2");
      expect(provider.sendCalls).toEqual(maxConcurrentConversations === 2 ? ["r1", "r2"] : ["r1"]);
      provider.complete("r1");
      await provider.waiting("r2");
      provider.complete("r2");
      await service.waitForIdle();
      expect(f.requests.get("r2")?.state).toBe("completed");
      await service.shutdown();
    },
  );

  test.each(["clientRequestId", "conversationId", "providerRequestId", "partial_only"])(
    "mismatched or incomplete %s completion is never applied",
    async (field) => {
      class WrongEvidence extends FakeChatProvider {
        override async awaitCompletion(
          input: Readonly<{ submission: ProviderSubmission; signal: AbortSignal }>,
        ): Promise<ProviderOutcome> {
          const valid = await super.awaitCompletion(input);
          return field === "partial_only"
            ? ({
                ...input.submission,
                state: "running",
                partialText: "partial",
              } as unknown as ProviderOutcome)
            : { ...valid, [field]: "foreign" };
        }
      }
      const { service, results } = setup(new WrongEvidence());
      await service.start();
      service.accept(request(), { text: "synthetic", attachments: [] });
      await service.waitForIdle();
      expect(f.requests.get("r1")?.state).toBe("unknown");
      expect(results[0].message).toBeUndefined();
      await service.shutdown();
    },
  );

  test("foreign pre-submit evidence is ambiguous even when its code is safe", async () => {
    class WrongSend extends FakeChatProvider {
      override async send(_input: ProviderSendInput): Promise<ProviderSendResult> {
        return {
          state: "not_submitted",
          clientRequestId: "foreign",
          conversationId: "remote",
          code: "SEND_FAILED_PRE_SUBMIT",
        };
      }
    }
    const { service } = setup(new WrongSend());
    await service.start();
    service.accept(request(), { text: "synthetic", attachments: [] });
    await service.waitForIdle();
    expect(f.requests.get("r1")?.state).toBe("unknown");
    await service.shutdown();
  });

  test("AC-D04 result delivery rejection cannot reclassify durable completion or resubmit", async () => {
    const { service, provider } = setup(new FakeChatProvider(), {
      onResult: () => {
        throw new Error("synthetic private delivery details");
      },
    });
    await service.start();
    service.accept(request(), { text: "synthetic private input", attachments: [] });
    await service.waitForIdle();
    expect(f.requests.get("r1")?.state).toBe("completed");
    expect(service.status().deliveryFailures).toEqual(["r1"]);
    expect(JSON.stringify(service.status())).not.toContain("private");
    expect(service.accept(request("duplicate"), { text: "retry", attachments: [] }).kind).toBe(
      "duplicate",
    );
    expect(provider.submissions).toHaveLength(1);
    await service.shutdown();
  });

  test("R4 progress failure after durable submission is auxiliary and does not prevent completion", async () => {
    const observed: string[] = [];
    const { service, provider, results } = setup(new FakeChatProvider(), {
      onProgress: (current) => {
        expect(f.requests.get(current.id)?.state).toBe("running");
        expect(current.submittedAt).toBe(later);
        observed.push(current.id);
        throw new Error("synthetic progress failure");
      },
    });
    await service.start();
    service.accept(request(), { text: "synthetic", attachments: [] });
    await service.waitForIdle();
    expect(observed).toEqual(["r1"]);
    expect(provider.submissions).toHaveLength(1);
    expect(results[0].request.state).toBe("completed");
    expect(service.status().deliveryFailures).toEqual([]);
    await service.shutdown();
  });

  test("R4 slow progress cannot delay provider observation or durable deadline settlement", async () => {
    const notification = new FakeBarrier();
    let expire!: () => void;
    const { service, provider } = setup(new FakeChatProvider(), {
      onProgress: async () => {
        await notification.promise;
      },
      scheduleDeadline: (_milliseconds, fire) => {
        expire = fire;
        return () => {};
      },
    });
    provider.plan("r1", { kind: "slow" });
    await service.start();
    service.accept(request(), { text: "synthetic", attachments: [] });
    await provider.waiting("r1");
    expire();
    await service.waitForIdle();
    expect(f.requests.get("r1")?.state).toBe("unknown");
    expect(provider.submissions).toHaveLength(1);
    notification.release();
    await service.shutdown();
  });

  test("failed persistence after send leaves a durable blocker and no result delivery", async () => {
    const { service, provider, results } = setup();
    f.database.exec(
      "CREATE TRIGGER fail_running BEFORE UPDATE OF state ON requests WHEN NEW.state='running' BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
    );
    await service.start();
    service.accept(request(), { text: "synthetic", attachments: [] });
    service.accept(request("next", "2"), { text: "next", attachments: [] });
    await service.waitForIdle();
    expect(f.requests.get("r1")?.state).toBe("sending");
    expect(f.requests.get("next")?.state).toBe("queued");
    expect(service.status().executionFailures).toEqual(["r1"]);
    expect(provider.submissions).toHaveLength(1);
    expect(results).toEqual([]);
    await service.shutdown();
  });
});

describe("R3 cancellation and shutdown", () => {
  const terminalKinds = ["completed", "failed", "timeout", "cancelled"] as const;
  test.each(
    terminalKinds.flatMap((observed) =>
      terminalKinds.map((cancelled) => [observed, cancelled] as const),
    ),
  )(
    "AC-H01 terminal observation %s and cancellation %s preserve approved source precedence",
    async (observed, cancelled) => {
      const evidence = (
        reference: ProviderRequestReference,
        state: (typeof terminalKinds)[number],
        source: string,
      ): ProviderOutcome => {
        if (state === "completed")
          return { ...reference, state, message: { text: `${source} final` } };
        if (state === "failed") return { ...reference, state, code: "GENERATION_FAILED" };
        return { ...reference, state };
      };
      class TerminalProvider extends FakeChatProvider {
        override async awaitCompletion(
          input: Readonly<{ submission: ProviderSubmission; signal: AbortSignal }>,
        ): Promise<ProviderOutcome> {
          const result = await super.awaitCompletion(input);
          return input.submission.clientRequestId === "r1"
            ? evidence(input.submission, observed, "observation")
            : result;
        }
        override async cancel(reference: ProviderRequestReference): Promise<ProviderCancelResult> {
          await super.cancel(reference);
          return evidence(reference, cancelled, "cancellation");
        }
      }
      const provider = new TerminalProvider({
        capabilities: { maxConcurrentConversations: 1, cancellation: true, fileUpload: true },
      });
      const { service, results } = setup(provider);
      const cancelGate = new FakeBarrier();
      provider.plan("r1", { kind: "slow", cancelGate });
      await service.start();
      service.accept(request(), { text: "first", attachments: [attachment()] });
      service.accept(request("same", "2", "alias"), {
        text: "same remote successor",
        attachments: [],
      });
      service.accept(request("independent", "3", "other"), {
        text: "independent successor",
        attachments: [],
      });
      await provider.waiting("r1");
      expect(service.stop("remote").kind).toBe("requested");
      await provider.cancelling("r1");
      expect(f.requests.get("r1")?.state).toBe("cancel_requested");
      expect(provider.sendCalls).toEqual(["r1"]);
      cancelGate.release();
      await service.waitForIdle();
      const expected = observed === "completed" || cancelled !== "completed" ? observed : cancelled;
      expect(f.requests.get("r1")).toMatchObject({
        state: expected,
        submittedAt: later,
        providerRequestId: "fake-r1",
      });
      expect(results.find((result) => result.request.id === "r1")?.message?.text).toBe(
        expected === "completed"
          ? observed === "completed"
            ? "observation final"
            : "cancellation final"
          : undefined,
      );
      expect(f.requests.get("same")?.state).toBe("completed");
      expect(f.requests.get("independent")?.state).toBe("completed");
      expect(provider.sendCalls).toEqual(["r1", "same", "independent"]);
      expect(provider.cancelCalls).toEqual(["r1"]);
      expect(f.requests.listAttachments("r1")).toEqual([]);
      expect(f.database.query("SELECT * FROM request_inputs WHERE request_id='r1'").all()).toEqual(
        [],
      );
      await service.shutdown();
    },
  );

  test.each([
    ["failed", "terminal"],
    ["failed", "unknown"],
    ["timeout", "terminal"],
    ["timeout", "unknown"],
  ] as const)(
    "AC-H01 proven %s with %s observation releases one-slot capacity and preserves successors",
    async (state, observation) => {
      const observing = new FakeBarrier();
      class ObservedProvider extends FakeChatProvider {
        override async awaitCompletion(
          input: Readonly<{ submission: ProviderSubmission; signal: AbortSignal }>,
        ): Promise<ProviderOutcome> {
          if (input.submission.clientRequestId !== "r1" || observation === "terminal")
            return super.awaitCompletion(input);
          observing.release();
          if (!input.signal.aborted)
            await new Promise<void>((resolve) =>
              input.signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          return {
            conversationId: input.submission.conversationId,
            clientRequestId: "r1",
            state: "unknown",
            code: "SUBMISSION_STATE_UNKNOWN",
          };
        }
      }
      const provider = new ObservedProvider({
        capabilities: { maxConcurrentConversations: 1, cancellation: true, fileUpload: true },
      });
      const { service } = setup(provider);
      const cancelGate = new FakeBarrier();
      provider.plan("r1", {
        kind:
          state === "failed"
            ? "cancellation_generation_failure"
            : "cancellation_generation_timeout",
        cancelGate,
      });
      await service.start();
      service.accept(request(), { text: "first", attachments: [attachment()] });
      service.accept(request("same", "2", "alias"), {
        text: "same remote successor",
        attachments: [],
      });
      service.accept(request("independent", "3", "other"), {
        text: "independent successor",
        attachments: [],
      });
      await (observation === "terminal" ? provider.waiting("r1") : observing.promise);
      expect(service.stop("remote").kind).toBe("requested");
      expect(service.stop("remote").kind).toBe("already_requested");
      await provider.cancelling("r1");
      expect(f.requests.get("r1")?.state).toBe("cancel_requested");
      expect(provider.sendCalls).toEqual(["r1"]);
      cancelGate.release();
      await service.waitForIdle();
      expect(f.requests.get("r1")).toMatchObject({
        state,
        submittedAt: later,
        providerRequestId: "fake-r1",
      });
      expect(f.requests.get("r1")?.failureCode).toBe(
        state === "failed" ? "GENERATION_FAILED" : undefined,
      );
      expect(f.requests.get("same")?.state).toBe("completed");
      expect(f.requests.get("independent")?.state).toBe("completed");
      expect(provider.sendCalls).toEqual(["r1", "same", "independent"]);
      expect(provider.cancelCalls).toEqual(["r1"]);
      expect(f.requests.listAttachments("r1")).toEqual([]);
      expect(f.database.query("SELECT * FROM request_inputs WHERE request_id='r1'").all()).toEqual(
        [],
      );
      await service.shutdown();
      f.reopen();
      expect(f.requests.get("r1")?.state).toBe(state);
      expect(f.updates.get("1")?.requestId).toBe("r1");
    },
  );

  test.each(["failed", "timeout"] as const)(
    "foreign %s cancellation evidence cannot release one-slot capacity",
    async (state) => {
      const observing = new FakeBarrier();
      class ForeignProvider extends FakeChatProvider {
        override async awaitCompletion(
          input: Readonly<{ submission: ProviderSubmission; signal: AbortSignal }>,
        ): Promise<ProviderOutcome> {
          observing.release();
          if (!input.signal.aborted)
            await new Promise<void>((resolve) =>
              input.signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          return {
            conversationId: input.submission.conversationId,
            clientRequestId: input.submission.clientRequestId,
            state: "unknown",
            code: "SUBMISSION_STATE_UNKNOWN",
          };
        }
        override async cancel(reference: ProviderRequestReference): Promise<ProviderCancelResult> {
          const identity = { ...reference, providerRequestId: "foreign" };
          return state === "failed"
            ? { ...identity, state, code: "GENERATION_FAILED" }
            : { ...identity, state };
        }
      }
      const provider = new ForeignProvider({
        capabilities: { maxConcurrentConversations: 1, cancellation: true, fileUpload: true },
      });
      const { service } = setup(provider);
      provider.plan("r1", { kind: "slow" });
      await service.start();
      service.accept(request(), { text: "first", attachments: [] });
      service.accept(request("independent", "2", "other"), {
        text: "independent",
        attachments: [],
      });
      await observing.promise;
      service.stop("remote");
      await service.waitForIdle();
      expect(f.requests.get("r1")?.state).toBe("unknown");
      expect(f.requests.get("independent")?.state).toBe("queued");
      expect(provider.sendCalls).toEqual(["r1"]);
      await service.shutdown();
    },
  );

  test("in-flight send holds its key; stop cannot target an unconfirmed submission", async () => {
    const { service, provider } = setup();
    const sendGate = new FakeBarrier();
    provider.plan("r1", { kind: "success", sendGate });
    await service.start();
    service.accept(request(), { text: "first", attachments: [] });
    service.accept(request("next", "2", "alias"), { text: "next", attachments: [] });
    await provider.sent("r1");
    expect(f.requests.get("r1")).toMatchObject({ state: "sending", startedAt: later });
    expect(f.requests.get("r1")?.submittedAt).toBeUndefined();
    expect(provider.sendCalls).toEqual(["r1"]);
    expect(service.stop("remote").kind).toBe("nothing_running");
    sendGate.release();
    await service.waitForIdle();
    expect(provider.sendCalls).toEqual(["r1", "next"]);
    expect(provider.cancelCalls).toEqual([]);
    await service.shutdown();
  });

  test.each(["cancellation_success", "cancellation_completion_race"] as const)(
    "AC-H01/H03 %s keeps later queued requests and one stop mutation",
    async (kind) => {
      const { service, provider } = setup();
      const cancelGate = new FakeBarrier();
      provider.plan("r1", { kind, cancelGate });
      await service.start();
      service.accept(request(), { text: "first", attachments: [] });
      service.accept(request("next", "2", "alias"), { text: "next", attachments: [] });
      await provider.waiting("r1");
      expect(service.stop("remote").kind).toBe("requested");
      expect(service.stop("remote").kind).toBe("already_requested");
      await provider.cancelling("r1");
      expect(f.requests.get("r1")?.state).toBe("cancel_requested");
      expect(f.requests.get("next")?.state).toBe("queued");
      cancelGate.release();
      await service.waitForIdle();
      expect(f.requests.get("r1")?.state).toBe(
        kind === "cancellation_success" ? "cancelled" : "completed",
      );
      expect(f.requests.get("next")?.state).toBe("completed");
      expect(provider.cancelCalls).toEqual(["r1"]);
      expect(provider.sendCalls).toEqual(["r1", "next"]);
      await service.shutdown();
    },
  );

  test("completion cannot release key while the cancellation mutation is still settling", async () => {
    const { service, provider } = setup();
    const cancelGate = new FakeBarrier();
    provider.plan("r1", { kind: "slow", cancelGate });
    await service.start();
    service.accept(request(), { text: "first", attachments: [] });
    service.accept(request("next", "2"), { text: "next", attachments: [] });
    await provider.waiting("r1");
    service.stop("remote");
    await provider.cancelling("r1");
    provider.complete("r1");
    expect(f.requests.get("r1")?.state).toBe("cancel_requested");
    expect(provider.sendCalls).toEqual(["r1"]);
    const shutdown = service.shutdown();
    expect(service.status().activeRequestIds).toEqual(["r1"]);
    cancelGate.release();
    await shutdown;
    expect(f.requests.get("r1")?.state).toBe("completed");
    expect(f.requests.get("next")?.state).toBe("queued");
    expect(provider.sendCalls).toEqual(["r1"]);
  });

  test("AC-H02 no active generation and unsupported cancellation make no stop call", async () => {
    const provider = new FakeChatProvider({
      capabilities: { maxConcurrentConversations: 2, cancellation: false, fileUpload: true },
    });
    const { service } = setup(provider);
    provider.plan("r1", { kind: "slow" });
    await service.start();
    expect(service.stop("remote").kind).toBe("nothing_running");
    service.accept(request(), { text: "synthetic", attachments: [] });
    await provider.waiting("r1");
    expect(service.stop("Remote").kind).toBe("nothing_running");
    expect(service.stop("remote").kind).toBe("unsupported");
    expect(f.requests.get("r1")?.state).toBe("running");
    expect(provider.cancelCalls).toEqual([]);
    provider.complete("r1");
    await service.waitForIdle();
    await service.shutdown();
  });

  test.each(["throw", "foreign"])(
    "%s cancel evidence cannot invent cancellation or release successors",
    async (mode) => {
      class UncertainCancel extends FakeChatProvider {
        override async cancel(reference: ProviderRequestReference): Promise<ProviderCancelResult> {
          if (mode === "throw") throw new Error("private raw error");
          return { ...reference, clientRequestId: "foreign", state: "cancelled" };
        }
      }
      const { service, provider } = setup(new UncertainCancel());
      provider.plan("r1", { kind: "slow" });
      await service.start();
      service.accept(request(), { text: "first", attachments: [] });
      service.accept(request("next", "2"), { text: "next", attachments: [] });
      await provider.waiting("r1");
      service.stop("remote");
      await service.waitForIdle();
      expect(f.requests.get("r1")?.state).toBe("unknown");
      expect(f.requests.get("next")?.state).toBe("queued");
      expect(provider.sendCalls).toEqual(["r1"]);
      expect(JSON.stringify(service.status())).not.toContain("private");
      await service.shutdown();
    },
  );

  test("cancellation acknowledgement alone leaves the generation running until final evidence", async () => {
    class Acknowledged extends FakeChatProvider {
      override async cancel(reference: ProviderRequestReference): Promise<ProviderCancelResult> {
        return {
          conversationId: reference.conversationId,
          clientRequestId: reference.clientRequestId,
          state: "not_cancelled",
        };
      }
    }
    const { service, provider, results } = setup(new Acknowledged());
    provider.plan("r1", { kind: "slow" });
    await service.start();
    service.accept(request(), { text: "synthetic", attachments: [] });
    await provider.waiting("r1");
    service.stop("remote");
    expect(f.requests.get("r1")?.state).toBe("cancel_requested");
    expect(results).toEqual([]);
    provider.complete("r1");
    await service.waitForIdle();
    expect(f.requests.get("r1")?.state).toBe("completed");
    await service.shutdown();
  });

  test("shutdown during startup cannot reopen admission or dispatch", async () => {
    const healthGate = new FakeBarrier();
    class SlowHealth extends FakeChatProvider {
      override async health() {
        await healthGate.promise;
        return super.health();
      }
    }
    const { service, provider } = setup(new SlowHealth());
    f.store.accept(request(), { text: "durable", attachments: [] }, 3);
    const start = service.start();
    expect(service.accept(request("next", "2"), { text: "rejected", attachments: [] })).toEqual({
      kind: "rejected",
      code: "QUEUE_NOT_RUNNING",
    });
    const shutdown = service.shutdown();
    healthGate.release();
    await Promise.all([start, shutdown]);
    expect(provider.sendCalls).toEqual([]);
    expect(f.requests.get("r1")?.state).toBe("queued");
    expect(service.status().phase).toBe("stopped");
  });
});
