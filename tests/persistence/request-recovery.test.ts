import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { RequestService, type RequestResult } from "../../src/application/RequestService";
import type { ProviderObservation, ProviderRequestReference } from "../../src/ports/ChatProvider";
import { FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
import { attachment, later, QueueFixture, request } from "../fixtures/queue";

let f: QueueFixture;
beforeEach(() => {
  f = new QueueFixture();
});
afterEach(() => f.close());

function setup(provider = new FakeChatProvider()) {
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
  });
  return { service, provider, results };
}

function interrupted(state: "uploading" | "sending" | "running" | "cancel_requested" | "unknown") {
  f.store.accept(request(), { text: "private synthetic input", attachments: [attachment()] }, 3);
  f.store.claim("r1", later);
  if (state === "uploading") return;
  f.requests.transition("r1", { state: "sending", at: later });
  if (state === "sending") return;
  if (state === "unknown") {
    f.requests.transition("r1", { state, at: later });
    return;
  }
  f.requests.transition("r1", { state: "running", at: later, providerRequestId: "fake-r1" });
  if (state === "cancel_requested") f.requests.transition("r1", { state, at: later });
}

describe("R3 startup reconciliation", () => {
  test.each([1, 2])(
    "recovered uncertain canonical key consumes one of %s provider slots across aliases",
    async (maxConcurrentConversations) => {
      interrupted("unknown");
      f.requests.create(request("legacy", "4", "alias"));
      for (const state of ["queued", "sending", "unknown"] as const)
        f.requests.transition("legacy", { state, at: later });
      f.store.accept(request("independent", "3", "other"), { text: "other", attachments: [] }, 3);
      f.reopen();
      const { service, provider } = setup(
        new FakeChatProvider({
          capabilities: { maxConcurrentConversations, cancellation: true, fileUpload: true },
        }),
      );
      await service.start();
      await service.waitForIdle();
      expect(provider.sendCalls).toEqual(maxConcurrentConversations === 1 ? [] : ["independent"]);
      expect(f.requests.get("independent")?.state).toBe(
        maxConcurrentConversations === 1 ? "queued" : "completed",
      );
      await service.shutdown();
    },
  );

  test("AC-F02 safe queued input executes once in committed order after reconnect", async () => {
    f.store.accept(request("z", "1"), { text: "first", attachments: [] }, 3);
    f.store.accept(request("a", "2", "alias"), { text: "second", attachments: [] }, 3);
    f.reopen();
    const { service, provider } = setup();
    await service.start();
    await service.waitForIdle();
    expect(provider.sendCalls).toEqual(["z", "a"]);
    expect(provider.inspections).toEqual([]);
    expect(f.requests.get("z")?.state).toBe("completed");
    expect(f.requests.get("a")?.state).toBe("completed");
    await service.shutdown();
    f.reopen();
    const next = setup();
    await next.service.start();
    await next.service.waitForIdle();
    expect(next.provider.sendCalls).toEqual([]);
    expect(
      next.service.accept(request("duplicate"), { text: "changed", attachments: [] }).kind,
    ).toBe("duplicate");
    await next.service.shutdown();
  });

  test.each(["uploading", "sending", "running", "cancel_requested", "unknown"] as const)(
    "AC-F03/F04/F05 interrupted %s without reliable evidence stays blocked, never replayed",
    async (state) => {
      interrupted(state);
      f.store.accept(request("next", "2", "alias"), { text: "later", attachments: [] }, 3);
      f.store.accept(request("independent", "3", "other"), { text: "other", attachments: [] }, 3);
      f.reopen();
      const { service, provider } = setup();
      const recovery = await service.start();
      await service.waitForIdle();
      expect(recovery.blocked).toContainEqual({
        requestId: "r1",
        providerConversationId: "remote",
        reason: "reconciliation_required",
      });
      expect(f.requests.get("r1")?.state).toBe("unknown");
      expect(f.requests.get("r1")?.submittedAt).toBe(
        ["running", "cancel_requested"].includes(state) ? later : undefined,
      );
      expect(f.requests.get("next")?.state).toBe("queued");
      expect(provider.sendCalls).toEqual(["independent"]);
      expect(provider.inspections).toEqual(state === "unknown" ? [] : ["r1"]);
      expect(f.requests.listAttachments("r1")).toEqual([]);
      expect(f.database.query("SELECT * FROM request_inputs WHERE request_id='r1'").all()).toEqual(
        [],
      );
      expect(f.updates.get("1")?.requestId).toBe("r1");
      await service.shutdown();
      f.reopen();
      const next = setup();
      await next.service.start();
      await next.service.waitForIdle();
      expect(next.provider.sendCalls).toEqual([]);
      expect(next.provider.inspections).toEqual([]);
      await next.service.shutdown();
    },
  );

  test.each(["uploading", "sending", "running", "cancel_requested"] as const)(
    "reliably correlated completion reconciles %s without a second send",
    async (state) => {
      interrupted(state);
      const provider = new FakeChatProvider();
      await provider.send({
        conversationId: "remote",
        clientRequestId: "r1",
        text: "synthetic remote",
        attachments: [],
      });
      provider.complete("r1", "final recovered");
      f.store.accept(request("next", "2"), { text: "next", attachments: [] }, 3);
      f.reopen();
      const { service, results } = setup(provider);
      await service.start();
      await service.waitForIdle();
      expect(f.requests.get("r1")).toMatchObject({
        state: "completed",
        providerRequestId: "fake-r1",
        submittedAt: later,
      });
      expect(results[0].message?.text).toBe("final recovered");
      expect(provider.sendCalls).toEqual(["r1", "next"]);
      expect(f.requests.get("next")?.state).toBe("completed");
      await service.shutdown();
    },
  );

  test.each(["cancelled", "failed", "timeout"] as const)(
    "terminal %s observation proves ended generation on restart",
    async (state) => {
      interrupted("running");
      class Observed extends FakeChatProvider {
        override async inspectRequest(
          reference: ProviderRequestReference,
        ): Promise<ProviderObservation> {
          return state === "failed"
            ? { ...reference, state, code: "GENERATION_FAILED" }
            : { ...reference, state };
        }
      }
      f.reopen();
      const { service, provider } = setup(new Observed());
      await service.start();
      expect(f.requests.get("r1")?.state).toBe(state);
      expect(provider.sendCalls).toEqual([]);
      expect(f.requests.listAttachments("r1")).toEqual([]);
      await service.shutdown();
    },
  );

  test.each(["uploading", "sending", "running", "cancel_requested"] as const)(
    "not-submitted proof at %s never contradicts saved submission or retries the original",
    async (state) => {
      interrupted(state);
      class NotSubmitted extends FakeChatProvider {
        override async inspectRequest(
          reference: ProviderRequestReference,
        ): Promise<ProviderObservation> {
          return {
            conversationId: reference.conversationId,
            clientRequestId: reference.clientRequestId,
            state: "not_submitted",
            code: "SEND_FAILED_PRE_SUBMIT",
          };
        }
      }
      f.reopen();
      const { service, provider } = setup(new NotSubmitted());
      await service.start();
      await service.waitForIdle();
      expect(f.requests.get("r1")?.state).toBe(
        ["uploading", "sending"].includes(state) ? "failed" : "unknown",
      );
      expect(provider.sendCalls).toEqual([]);
      await service.shutdown();
    },
  );

  test.each(["running", "foreign", "throw"])(
    "%s restart observation is insufficient to settle the generation",
    async (mode) => {
      interrupted("running");
      class Uncertain extends FakeChatProvider {
        override async inspectRequest(
          reference: ProviderRequestReference,
        ): Promise<ProviderObservation> {
          if (mode === "throw") throw new Error("private observation details");
          if (mode === "running") return { ...reference, state: "running", partialText: "partial" };
          return {
            ...reference,
            providerRequestId: "foreign",
            state: "completed",
            message: { text: "foreign response" },
          };
        }
      }
      f.reopen();
      const { service, provider, results } = setup(new Uncertain());
      await service.start();
      expect(f.requests.get("r1")?.state).toBe("unknown");
      expect(results[0].message).toBeUndefined();
      expect(provider.sendCalls).toEqual([]);
      expect(JSON.stringify(service.status())).not.toContain("private");
      await service.shutdown();
    },
  );

  test.each(["input", "acceptance", "dedup"])(
    "incomplete queued %s evidence remains blocked without fabrication",
    async (missing) => {
      f.store.accept(request(), { text: "synthetic", attachments: [] }, 3);
      const table =
        missing === "input"
          ? "request_inputs"
          : missing === "acceptance"
            ? "request_acceptances"
            : "processed_updates";
      f.database.exec(`DELETE FROM ${table}`);
      f.reopen();
      const { service, provider } = setup();
      const recovery = await service.start();
      await service.waitForIdle();
      expect(recovery.blocked).toEqual([
        { requestId: "r1", providerConversationId: "remote", reason: "input_unavailable" },
      ]);
      expect(provider.sendCalls).toEqual([]);
      expect(provider.inspections).toEqual([]);
      expect(f.requests.get("r1")?.state).toBe("queued");
      await service.shutdown();
    },
  );

  test("failed reconciliation cleanup rolls back lifecycle and keeps admission closed", async () => {
    interrupted("sending");
    f.database.exec(
      "CREATE TRIGGER fail_cleanup BEFORE DELETE ON request_inputs BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
    );
    f.reopen();
    const { service, provider } = setup();
    await expect(service.start()).rejects.toThrow("DATABASE_ERROR");
    expect(f.requests.get("r1")?.state).toBe("sending");
    expect(f.requests.listAttachments("r1")).toHaveLength(1);
    expect(f.database.query("SELECT * FROM request_inputs").all()).toHaveLength(1);
    expect(provider.sendCalls).toEqual([]);
    expect(service.accept(request("next", "2"), { text: "next", attachments: [] })).toEqual({
      kind: "rejected",
      code: "QUEUE_NOT_RUNNING",
    });
    await expect(service.shutdown()).rejects.toThrow("DATABASE_ERROR");
  });

  test.each(["sending", "running"])(
    "SIGKILL in actual RequestService %s never resubmits during startup",
    async (mode) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          resolve(import.meta.dir, "../fixtures/provider-crash.ts"),
          f.path,
          mode,
        ],
        { env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      try {
        const reader = child.stdout.getReader();
        const chunk = await reader.read();
        expect(new TextDecoder().decode(chunk.value)).toBe("submitted:r1\n");
        child.kill("SIGKILL");
        await child.exited;
        reader.releaseLock();
        expect(await new Response(child.stderr).text()).toBe("");
        f.reopen();
        expect(f.requests.get("r1")?.state).toBe(mode);
        const { service, provider } = setup();
        await service.start();
        await service.waitForIdle();
        expect(provider.sendCalls).toEqual([]);
        expect(f.requests.get("r1")?.state).toBe("unknown");
        expect(f.requests.get("next")?.state).toBe("queued");
        expect(f.updates.get("1")?.requestId).toBe("r1");
        await service.shutdown();
      } finally {
        child.kill();
        await child.exited;
      }
    },
  );
});
