import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { QueueWork } from "../../src/ports/RequestQueueRepository";
import { RequestQueue } from "../../src/queue/RequestQueue";
import { at, attachment, later, QueueFixture, request } from "../fixtures/queue";

let f: QueueFixture;
beforeEach(() => {
  f = new QueueFixture();
});
afterEach(() => f.close());

// Manual barriers give deterministic observations without timers or a real ChatProvider.
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// This test executor models only the critical section; R3 will own provider semantics and failures.
class Probe {
  readonly order: string[] = [];
  readonly works: QueueWork[] = [];
  readonly maximum = new Map<string, number>();
  private readonly active = new Map<string, number>();
  private readonly signals = new Map<string, ReturnType<typeof barrier>>();
  private readonly gates = new Map<string, ReturnType<typeof barrier>>();
  // Each request has an independent completion gate and start observation.
  private signal(map: Map<string, ReturnType<typeof barrier>>, id: string) {
    let signal = map.get(id);
    if (!signal) {
      signal = barrier();
      map.set(id, signal);
    }
    return signal;
  }
  // Tests wait on actual starts rather than guessing how many event-loop turns are needed.
  started(id: string): Promise<void> {
    return this.signal(this.signals, id).promise;
  }
  // A gate may be released before startup, making later queue draining deterministic too.
  release(id: string): void {
    this.signal(this.gates, id).release();
  }
  // Inputs and durable start are captured before the first suspension.
  async execute(work: QueueWork): Promise<void> {
    const id = work.request.id,
      key = work.providerConversationId;
    expect(f.requests.get(id)?.state).toBe(work.input.attachments.length ? "uploading" : "sending");
    this.order.push(id);
    this.works.push(work);
    const active = (this.active.get(key) ?? 0) + 1;
    this.active.set(key, active);
    this.maximum.set(key, Math.max(active, this.maximum.get(key) ?? 0));
    this.signal(this.signals, id).release();
    await this.signal(this.gates, id).promise;
    f.complete(id);
    this.active.set(key, active - 1);
  }
}

// Every queue receives explicit concurrency and clock, so tests never infer browser capability.
function queue(execute: (work: QueueWork) => Promise<void>, concurrent = 2, pending = 3) {
  return new RequestQueue(
    f.store,
    { maxConcurrentConversations: concurrent, maxPendingPerConversation: pending },
    execute,
    () => later,
  );
}

describe("R2 keyed queue acceptance", () => {
  test.each(["queued", "sending"])(
    "SIGKILL after %s commit reconstructs only proven safe work in a new runtime",
    async (mode) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          resolve(import.meta.dir, "../fixtures/queue-crash.ts"),
          f.path,
          mode,
        ],
        {
          env: {},
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      try {
        const reader = child.stdout.getReader();
        const chunk = await reader.read();
        expect(new TextDecoder().decode(chunk.value)).toBe("committed\n");
        child.kill("SIGKILL");
        await child.exited;
        reader.releaseLock();
        expect(await new Response(child.stderr).text()).toBe("");
        f.reopen();
        const order: string[] = [],
          q = queue(async (work) => {
            order.push(work.request.id);
            f.complete(work.request.id);
          });
        const recovery = q.start();
        if (mode === "queued") {
          expect(
            recovery.queued
              .filter((work) => work.providerConversationId === "remote")
              .map((work) => work.request.id),
          ).toEqual(["z", "a", "m"]);
          expect(recovery.queued[0].input.attachments.map((file) => file.id)).toEqual(["z", "a"]);
        } else expect(recovery.blocked[0].requestId).toBe("z");
        await q.waitForIdle();
        await q.shutdown();
        expect(order.filter((id) => id !== "independent")).toEqual(
          mode === "queued" ? ["z", "a", "m"] : [],
        );
        expect(order).toContain("independent");
        expect(f.requests.get("z")?.state).toBe(mode === "queued" ? "completed" : "sending");
        expect(f.updates.get("1")?.requestId).toBe("z");
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
    },
  );

  test("AC-E01 duplicate before/during/after execution has one prompt and original input", async () => {
    const probe = new Probe(),
      q = queue((work) => probe.execute(work));
    q.start();
    q.accept(request(), { text: "synthetic", attachments: [attachment()] });
    expect(q.accept(request("other-id"), { text: "changed", attachments: [] }).kind).toBe(
      "duplicate",
    );
    await probe.started("r1");
    expect(q.accept(request("third-id"), { text: "changed", attachments: [] }).kind).toBe(
      "duplicate",
    );
    probe.release("r1");
    await q.waitForIdle();
    expect(q.accept(request("fourth-id"), { text: "changed", attachments: [] }).kind).toBe(
      "duplicate",
    );
    expect(probe.order).toEqual(["r1"]);
    expect(probe.works[0].input.text).toBe("synthetic");
    expect(f.requests.get("r1")?.state).toBe("completed");
    await q.shutdown();
  });

  test("AC-E02/E03/E05 FIFO spans aliases; one active remote mutation at every barrier", async () => {
    const probe = new Probe(),
      q = queue((work) => probe.execute(work));
    q.start();
    q.accept(request("z", "1"), { text: "first", attachments: [] });
    q.accept(request("a", "2", "alias"), { text: "second", attachments: [] });
    q.accept(request("m", "3"), { text: "third", attachments: [] });
    await probe.started("z");
    expect(probe.order).toEqual(["z"]);
    expect(q.status().activeRequestIds).toEqual(["z"]);
    probe.release("z");
    await probe.started("a");
    expect(probe.order).toEqual(["z", "a"]);
    expect(q.status().activeRequestIds).toEqual(["a"]);
    probe.release("a");
    await probe.started("m");
    expect(probe.order).toEqual(["z", "a", "m"]);
    expect(probe.maximum.get("remote")).toBe(1);
    probe.release("m");
    await q.waitForIdle();
    await q.shutdown();
  });

  test("AC-E04 exact opaque different keys execute in parallel", async () => {
    const probe = new Probe(),
      q = queue((work) => probe.execute(work));
    q.start();
    q.accept(request(), { text: "long", attachments: [] });
    q.accept(request("r2", "2", "other"), { text: "independent", attachments: [] });
    await Promise.all([probe.started("r1"), probe.started("r2")]);
    expect(q.status().activeRequestIds).toHaveLength(2);
    expect(probe.works.map((work) => work.providerConversationId)).toEqual(["remote", "Remote"]);
    probe.release("r2");
    await Promise.resolve();
    expect(f.requests.get("r1")?.state).toBe("sending");
    probe.release("r1");
    await q.waitForIdle();
    await q.shutdown();
  });

  test("global concurrency 1 respects a lower execution capability without alias keys", async () => {
    const probe = new Probe(),
      q = queue((work) => probe.execute(work), 1);
    q.start();
    q.accept(request(), { text: "x", attachments: [] });
    q.accept(request("r2", "2", "other"), { text: "y", attachments: [] });
    await probe.started("r1");
    expect(probe.order).toEqual(["r1"]);
    probe.release("r1");
    await probe.started("r2");
    expect(probe.order).toEqual(["r1", "r2"]);
    probe.release("r2");
    await q.waitForIdle();
    await q.shutdown();
  });

  test("graceful shutdown rejects new admission, waits active, and retains queued input for restart FIFO", async () => {
    const probe = new Probe(),
      q = queue((work) => probe.execute(work));
    expect(q.accept(request(), { text: "x", attachments: [] })).toEqual({
      kind: "rejected",
      code: "QUEUE_NOT_RUNNING",
    });
    q.start();
    q.accept(request("first", "1"), { text: "first", attachments: [] });
    q.accept(request("z", "2", "alias"), { text: "second", attachments: [attachment("z", "z")] });
    q.accept(request("a", "3"), { text: "third", attachments: [] });
    await probe.started("first");
    let stopped = false;
    const stopping = q.shutdown().then(() => {
      stopped = true;
    });
    expect(q.accept(request("new", "4"), { text: "x", attachments: [] }).kind).toBe("rejected");
    await Promise.resolve();
    expect(stopped).toBe(false);
    probe.release("first");
    await stopping;
    expect(probe.order).toEqual(["first"]);
    expect(q.status().phase).toBe("stopped");
    expect(f.requests.get("z")?.state).toBe("queued");
    expect(f.requests.get("new")).toBeNull();
    f.reopen();
    const nextProbe = new Probe(),
      next = queue((work) => nextProbe.execute(work));
    next.start();
    await nextProbe.started("z");
    expect(nextProbe.works[0].input.attachments[0].sourceFileId).toBe("source-z");
    nextProbe.release("z");
    await nextProbe.started("a");
    nextProbe.release("a");
    await next.waitForIdle();
    await next.shutdown();
    expect(nextProbe.order).toEqual(["z", "a"]);
    await q.shutdown();
  });

  test("queue capacity is bounded per remote key while different keys retain admission", async () => {
    const probe = new Probe(),
      q = queue((work) => probe.execute(work), 2, 1);
    q.start();
    q.accept(request(), { text: "x", attachments: [] });
    q.accept(request("next", "2", "alias"), { text: "x", attachments: [] });
    expect(q.accept(request("full", "3"), { text: "x", attachments: [] })).toEqual({
      kind: "rejected",
      code: "QUEUE_FULL",
    });
    q.accept(request("other", "4", "other"), { text: "x", attachments: [] });
    await Promise.all([probe.started("r1"), probe.started("other")]);
    probe.release("r1");
    probe.release("next");
    probe.release("other");
    await q.waitForIdle();
    await q.shutdown();
    expect(f.updates.get("3")).toBeNull();
  });

  test("restart surfaces uncertain old work and blocks same-key successors while other keys run", async () => {
    f.store.accept(request(), { text: "x", attachments: [] }, 3);
    f.store.claim("r1", later);
    f.store.accept(request("next", "2", "alias"), { text: "y", attachments: [] }, 3);
    f.store.accept(request("other", "3", "other"), { text: "z", attachments: [] }, 3);
    f.reopen();
    const order: string[] = [],
      q = queue(async (work) => {
        order.push(work.request.id);
        f.complete(work.request.id);
      });
    const recovery = q.start();
    expect(recovery.blocked[0].requestId).toBe("r1");
    await q.waitForIdle();
    await q.shutdown();
    expect(order).toEqual(["other"]);
    expect(f.requests.get("next")?.state).toBe("queued");
    expect(f.requests.get("r1")?.state).toBe("sending");
  });

  test.each(["throw", "unsettled"])(
    "executor %s never releases a key into a potentially overlapping next mutation",
    async (failure) => {
      const order: string[] = [];
      const q = queue(async (work) => {
        order.push(work.request.id);
        if (work.request.id === "r1") {
          if (failure === "throw") throw new Error("synthetic private error");
          return;
        }
        f.complete(work.request.id);
      });
      q.start();
      q.accept(request(), { text: "x", attachments: [] });
      q.accept(request("next", "2", "alias"), { text: "y", attachments: [] });
      q.accept(request("other", "3", "other"), { text: "z", attachments: [] });
      await q.waitForIdle();
      expect(order).toEqual(["r1", "other"]);
      expect(q.status().executionFailures).toEqual(["r1"]);
      expect(JSON.stringify(q.status())).not.toContain("private");
      expect(f.requests.get("r1")?.state).toBe("sending");
      await q.shutdown();
    },
  );

  test("primary durable completion survives an auxiliary executor rejection", async () => {
    const order: string[] = [],
      q = queue(async (work) => {
        order.push(work.request.id);
        f.complete(work.request.id);
        throw new Error("synthetic delivery");
      });
    q.start();
    q.accept(request(), { text: "x", attachments: [] });
    q.accept(request("next", "2"), { text: "y", attachments: [] });
    await q.waitForIdle();
    await q.shutdown();
    expect(order).toEqual(["r1", "next"]);
    expect(f.requests.get("r1")?.state).toBe("completed");
  });

  test("UNKNOWN outcome blocks following work even though its payload is deleted", async () => {
    const order: string[] = [],
      q = queue(async (work) => {
        order.push(work.request.id);
        f.requests.transition(work.request.id, { state: "unknown", at: later });
      });
    q.start();
    q.accept(request(), { text: "x", attachments: [] });
    q.accept(request("next", "2"), { text: "y", attachments: [] });
    await q.waitForIdle();
    await q.shutdown();
    expect(order).toEqual(["r1"]);
    expect(f.store.snapshot().blocked[0].reason).toBe("reconciliation_required");
    expect(f.database.query("SELECT request_id FROM request_inputs").all()).toEqual([
      { request_id: "next" },
    ]);
  });

  test("storage error after acceptance preserves successful ingress without an unhandled background rejection", async () => {
    const original = f.store.snapshot.bind(f.store);
    let unavailable = false;
    f.store.snapshot = () => {
      if (unavailable) throw new Error("synthetic storage");
      return original();
    };
    const q = queue(async () => {});
    q.start();
    unavailable = true;
    expect(q.accept(request(), { text: "x", attachments: [] }).kind).toBe("accepted");
    expect(q.status().phase).toBe("error");
    expect(q.status().errorCode).toBe("QUEUE_STORAGE_FAILED");
    expect(f.requests.get("r1")?.state).toBe("queued");
    unavailable = false;
    await q.shutdown();
  });

  test("executor inputs are immutable and exact timestamps come from the captured clock", async () => {
    const q = queue(async (work) => {
      expect(Object.isFrozen(work.request)).toBe(true);
      expect(Object.isFrozen(work.input)).toBe(true);
      expect(Object.isFrozen(work.input.attachments)).toBe(true);
      expect(work.request.startedAt).toBe(later);
      expect(work.request.createdAt).toBe(at);
      f.complete(work.request.id);
    });
    q.start();
    q.accept(request(), { text: "x", attachments: [] });
    await q.waitForIdle();
    await q.shutdown();
  });
});
