import { describe, expect, test } from "bun:test";
import {
  ProviderOperationError,
  providerOutcomeSchema,
  providerSendResultSchema,
} from "../../src/ports/ChatProvider";
import { FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";

describe("R3 provider contract", () => {
  test("health and inspection are read-only; create returns an exact opaque canonical identity", async () => {
    const provider = new FakeChatProvider({ conversations: ["Case/Id", "case/Id"] });
    expect((await provider.health()).state).toBe("ready");
    expect((await provider.inspectConversation("Case/Id")).id).toBe("Case/Id");
    expect((await provider.inspectConversation("case/Id")).id).toBe("case/Id");
    await expect(provider.inspectConversation(" Case/Id ")).rejects.toThrow(ProviderOperationError);
    const created = await provider.createConversation({ titleHint: "synthetic" });
    expect(await provider.inspectConversation(created.id)).toEqual(created);
    expect(provider.sendCalls).toEqual([]);
    expect(provider.cancelCalls).toEqual([]);
    expect(
      await provider.inspectRequest({ conversationId: created.id, clientRequestId: "absent" }),
    ).toMatchObject({ state: "unknown" });
  });

  test.each(["auth_required", "unavailable"] as const)(
    "%s is distinguishable without submitting a prompt",
    async (state) => {
      const provider = new FakeChatProvider();
      provider.setHealth(state);
      expect((await provider.health()).state).toBe(state);
      const code = state === "auth_required" ? "AUTH_REQUIRED" : "PROVIDER_UNAVAILABLE";
      await expect(provider.createConversation()).rejects.toThrow(code);
      await expect(provider.inspectConversation("remote")).rejects.toThrow(code);
      expect(provider.submissions).toEqual([]);
    },
  );

  test("capabilities are an immutable validated lifetime contract", () => {
    const capabilities = { maxConcurrentConversations: 1, cancellation: true, fileUpload: false };
    const provider = new FakeChatProvider({ capabilities });
    capabilities.maxConcurrentConversations = 4;
    expect(provider.capabilities.maxConcurrentConversations).toBe(1);
    expect(Object.isFrozen(provider.capabilities)).toBe(true);
    for (const maximum of [0, -1, 1.5, Number.POSITIVE_INFINITY])
      expect(
        () =>
          new FakeChatProvider({
            capabilities: { ...capabilities, maxConcurrentConversations: maximum },
          }),
      ).toThrow();
  });

  test("aborting completion observation is not remote cancellation or completion", async () => {
    const provider = new FakeChatProvider();
    provider.plan("r", { kind: "slow" });
    const sent = await provider.send({
      conversationId: "remote",
      clientRequestId: "r",
      text: "synthetic",
      attachments: [],
    });
    if (sent.state !== "submitted") throw new Error("Expected synthetic submission");
    const controller = new AbortController();
    const waiting = provider.awaitCompletion({ submission: sent, signal: controller.signal });
    await provider.waiting("r");
    controller.abort();
    expect((await waiting).state).toBe("unknown");
    expect((await provider.inspectRequest(sent)).state).toBe("running");
    expect(provider.cancelCalls).toEqual([]);
    provider.complete("r", "final");
    expect(await provider.inspectRequest(sent)).toMatchObject({
      state: "completed",
      message: { text: "final" },
    });
  });

  test("partial text, arbitrary errors and extra upstream fields cannot masquerade as final evidence", () => {
    const reference = { conversationId: "remote", clientRequestId: "r" };
    expect(
      providerOutcomeSchema.safeParse({ ...reference, state: "running", partialText: "partial" })
        .success,
    ).toBe(false);
    expect(
      providerSendResultSchema.safeParse({
        ...reference,
        state: "not_submitted",
        code: "RAW_UPSTREAM_FAILURE",
      }).success,
    ).toBe(false);
    expect(
      providerOutcomeSchema.safeParse({
        ...reference,
        state: "completed",
        message: { text: "final" },
        cookie: "synthetic-private",
      }).success,
    ).toBe(false);
  });
});
