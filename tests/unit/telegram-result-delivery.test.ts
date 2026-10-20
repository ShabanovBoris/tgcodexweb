import { afterEach, beforeEach, expect, test } from "bun:test";
import { SqliteRequestResultRepository } from "../../src/persistence/sqlite/SqliteRequestResultRepository";
import { TelegramError, type TelegramSend } from "../../src/transports/telegram/TelegramApi";
import { TelegramResultDelivery } from "../../src/transports/telegram/TelegramResultDelivery";
import { renderTelegram } from "../../src/transports/telegram/TelegramRenderer";
import { QueueFixture, later, request } from "../fixtures/queue";

let f: QueueFixture;
beforeEach(() => {
  f = new QueueFixture();
});
afterEach(() => f.close());
function setup(text = "answer") {
  f.store.accept(request(), { text: "private prompt", attachments: [] }, 3);
  f.store.claim("r1", later);
  f.requests.transition("r1", { state: "running", at: later, providerRequestId: "provider-r1" });
  let repository = new SqliteRequestResultRepository(f.database);
  repository.settle("r1", { state: "completed", at: later }, { message: { text } });
  let clock = Date.parse(later),
    allowed = true;
  const sent: TelegramSend[] = [];
  let send: (message: TelegramSend, signal?: AbortSignal) => Promise<void> = async (message) => {
    sent.push(message);
  };
  const make = (signal?: AbortSignal) =>
    new TelegramResultDelivery({
      repository,
      api: { sendMessage: (message, signal) => send(message, signal) },
      destination: () => (allowed ? { chatId: "123", replyTo: "101" } : null),
      now: () => new Date(clock).toISOString(),
      signal,
    });
  return {
    sent,
    make,
    get repository() {
      return repository;
    },
    now: () => new Date(clock).toISOString(),
    advance: (ms: number) => {
      clock += ms;
    },
    setSend: (value: typeof send) => {
      send = value;
    },
    deny: () => {
      allowed = false;
    },
    reopen: () => {
      f.reopen();
      repository = new SqliteRequestResultRepository(f.database);
    },
  };
}

test("delivery retries only the ambiguous part after restart and purges output on success", async () => {
  const text = "x".repeat(9000);
  const s = setup(text);
  const chunks = renderTelegram(text);
  let calls = 0;
  s.setSend(async (message) => {
    s.sent.push(message);
    if (++calls === 2) throw new Error("private lost acknowledgement");
  });
  await expect(s.make().deliver("r1")).rejects.toThrow("TELEGRAM_DELIVERY_FAILED");
  expect(s.repository.diagnostics()[0]).toMatchObject({
    nextChunk: 1,
    attempts: 1,
    nextAttemptAt: new Date(Date.parse(later) + 1000).toISOString(),
  });
  s.reopen();
  expect(await s.make().deliver("r1")).toBe(false);
  s.advance(1000);
  s.setSend(async (message) => {
    s.sent.push(message);
  });
  expect(await s.make().deliver("r1")).toBe(true);
  expect(s.sent.map((message) => message.text)).toEqual([
    chunks[0].html,
    chunks[1].html,
    ...chunks.slice(1).map((chunk) => chunk.html),
  ]);
  expect(f.requests.get("r1")?.state).toBe("completed");
  expect(f.database.query("SELECT result_payload,plan FROM request_deliveries").get()).toEqual({
    result_payload: null,
    plan: null,
  });
});

test("bounded backoff persists across attempts and exhaustion cannot resubmit a provider prompt", async () => {
  const s = setup();
  s.setSend(async (message) => {
    s.sent.push(message);
    throw new Error("private network error");
  });
  for (const wait of [1000, 2000, 4000, 8000, 16000, undefined]) {
    await expect(s.make().deliver("r1")).rejects.toThrow("TELEGRAM_DELIVERY_FAILED");
    if (wait) {
      expect(await s.make().deliver("r1")).toBe(false);
      s.advance(wait);
      s.reopen();
    }
  }
  expect(s.sent).toHaveLength(6);
  expect(s.repository.diagnostics()[0]).toMatchObject({ state: "failed", attempts: 6 });
  expect(await s.make().deliver("r1")).toBe(false);
  expect(f.requests.get("r1")?.state).toBe("completed");
});

test.each([undefined, -1, 60001, Number.NaN, Number.POSITIVE_INFINITY])(
  "invalid/unsupported flood minimum %s never causes an early retry",
  async (minimum) => {
    const s = setup();
    s.setSend(async () => {
      throw new TelegramError("TELEGRAM_DELIVERY_FAILED", undefined, minimum);
    });
    await expect(s.make().deliver("r1")).rejects.toThrow("TELEGRAM_DELIVERY_FAILED");
    expect(s.repository.diagnostics()[0].state).toBe("failed");
  },
);

test("valid retry_after is a minimum and confirmed chunks still avoid replay", async () => {
  const s = setup();
  s.setSend(async () => {
    throw new TelegramError("TELEGRAM_DELIVERY_FAILED", undefined, 15000);
  });
  await expect(s.make().deliver("r1")).rejects.toThrow("TELEGRAM_DELIVERY_FAILED");
  s.advance(14999);
  expect(await s.make().deliver("r1")).toBe(false);
  s.advance(1);
  s.setSend(async (message) => {
    s.sent.push(message);
  });
  expect(await s.make().deliver("r1")).toBe(true);
  expect(s.sent).toHaveLength(1);
});

test("explicit parser failure falls back only for that part and keeps stable persisted chunks", async () => {
  const s = setup("**answer**");
  s.setSend(async (message) => {
    s.sent.push(message);
    if (message.parseMode) throw new TelegramError("TELEGRAM_PARSE_ERROR");
  });
  expect(await s.make().deliver("r1")).toBe(true);
  expect(s.sent.map((message) => message.parseMode)).toEqual(["HTML", undefined]);
  expect(s.sent[1].text).toBe("**answer**");
});

test.each(["expiry", "revocation", "cancellation"])(
  "plain fallback rechecks %s after the rich-parser rejection",
  async (change) => {
    const s = setup();
    const controller = new AbortController();
    s.setSend(async (message) => {
      s.sent.push(message);
      if (!message.parseMode) return;
      if (change === "expiry") s.advance(86400000);
      if (change === "revocation") s.deny();
      if (change === "cancellation") controller.abort(new Error("operator abort"));
      throw new TelegramError("TELEGRAM_PARSE_ERROR");
    });
    const delivery = s.make(controller.signal).deliver("r1");
    if (change === "cancellation") await expect(delivery).rejects.toBe(controller.signal.reason);
    else await expect(delivery).rejects.toThrow("TELEGRAM_DELIVERY_FAILED");
    expect(s.sent).toHaveLength(1);
    expect(s.repository.diagnostics()[0]).toMatchObject({
      state: change === "expiry" ? "expired" : change === "cancellation" ? "pending" : "failed",
      nextChunk: 0,
    });
    expect(f.requests.get("r1")?.state).toBe("completed");
  },
);

test("revoked authorization prevents resumed delivery without changing completion", async () => {
  const s = setup();
  s.deny();
  await expect(s.make().deliver("r1")).rejects.toThrow("TELEGRAM_DELIVERY_FAILED");
  expect(s.sent).toHaveLength(0);
  expect(s.repository.diagnostics()[0].state).toBe("failed");
  expect(f.requests.get("r1")?.state).toBe("completed");
});

test("expiry removes content and exposes a durable delivery error; no late HTTP attempt occurs", async () => {
  const s = setup("private answer");
  s.advance(86400000);
  expect(await s.make().deliver("r1")).toBe(false);
  expect(s.sent).toHaveLength(0);
  expect(s.repository.diagnostics()[0]).toMatchObject({
    state: "expired",
    failureCode: "TELEGRAM_DELIVERY_EXPIRED",
  });
  expect(f.database.query("SELECT result_payload,plan FROM request_deliveries").get()).toEqual({
    result_payload: null,
    plan: null,
  });
});

test("cancellation propagates, joins the HTTP operation and leaves durable pending output", async () => {
  const s = setup();
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  s.setSend(async (_message, signal) => {
    entered.resolve();
    await new Promise((_, reject) =>
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  });
  const operation = s.make(controller.signal).deliver("r1");
  await entered.promise;
  controller.abort(new Error("operator abort"));
  await expect(operation).rejects.toBe(controller.signal.reason);
  expect(s.repository.diagnostics()[0].state).toBe("pending");
  expect(f.requests.get("r1")?.state).toBe("completed");
});
