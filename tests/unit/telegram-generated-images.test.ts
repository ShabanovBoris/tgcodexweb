import { afterEach, beforeEach, expect, test } from "bun:test";
import { SqliteRequestResultRepository } from "../../src/persistence/sqlite/SqliteRequestResultRepository";
import { HttpTelegramApi, TelegramError } from "../../src/transports/telegram/TelegramApi";
import { TelegramResultDelivery } from "../../src/transports/telegram/TelegramResultDelivery";
import { QueueFixture, later, request } from "../fixtures/queue";
import { pngImage } from "../fixtures/generated-image";
import { setupTelegram, update } from "../fixtures/telegram";
import { FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
import { requestResultPlan } from "../../src/transports/telegram/TelegramResultDelivery";

let f: QueueFixture;
beforeEach(() => {
  f = new QueueFixture();
});
afterEach(() => f.close());

test.each(["photo", "document"] as const)(
  "%s upload uses multipart bytes and the original destination",
  async (kind) => {
    let calls = 0;
    const api = new HttpTelegramApi("123:synthetic", async (url, input) => {
      calls++;
      expect(url.endsWith(kind === "photo" ? "/sendPhoto" : "/sendDocument")).toBe(true);
      expect(input.headers).toBeUndefined();
      const form = input.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect(form.get("chat_id")).toBe("123");
      expect(JSON.parse(form.get("reply_parameters") as string).message_id).toBe(101);
      const file = form.get(kind) as File;
      expect(file.type).toBe("image/png");
      expect(Buffer.from(await file.arrayBuffer()).toString("base64")).toBe(pngImage.base64);
      return Response.json({ ok: true, result: { message_id: 10 } });
    });
    await api.sendImage({
      chatId: "123",
      replyTo: "101",
      image: pngImage,
      kind,
      filename: "original-1.png",
    });
    expect(calls).toBe(1);
  },
);

test("cancelling an image upload joins HTTP and preserves the exact cancellation reason", async () => {
  const entered = Promise.withResolvers<void>();
  const controller = new AbortController();
  const api = new HttpTelegramApi("123:synthetic", async (_url, input) => {
    entered.resolve();
    await new Promise((_, reject) =>
      input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true }),
    );
    throw new Error("unreachable");
  });
  const sending = api.sendImage(
    { chatId: "123", image: pngImage, kind: "document", filename: "original.png" },
    controller.signal,
  );
  await entered.promise;
  controller.abort(new Error("operator stopped"));
  await expect(sending).rejects.toBe(controller.signal.reason);
});

test("image and original delivery survive reopen, checkpoint each part and purge all bytes after success", async () => {
  f.store.accept(request(), { text: "private prompt", attachments: [] }, 3);
  f.store.claim("r1", later);
  f.requests.transition("r1", { state: "running", at: later, providerRequestId: "provider-r1" });
  let results = new SqliteRequestResultRepository(f.database);
  results.settle(
    "r1",
    { state: "completed", at: later },
    { message: { text: "", images: [pngImage] } },
  );
  let clock = Date.parse(later),
    failed = false;
  const sent: string[] = [];
  const make = () =>
    new TelegramResultDelivery({
      repository: results,
      destination: () => ({ chatId: "123", replyTo: "101" }),
      now: () => new Date(clock).toISOString(),
      api: {
        sendMessage: async () => {
          throw new Error("image-only response must not become empty-text notice");
        },
        sendImage: async (input) => {
          sent.push(input.kind);
          expect(input.image.base64).toBe(pngImage.base64);
          if (input.kind === "document" && !failed) {
            failed = true;
            throw new TelegramError("TELEGRAM_DELIVERY_FAILED", undefined, 0);
          }
        },
      },
    });
  await expect(make().deliver("r1")).rejects.toThrow("TELEGRAM_DELIVERY_FAILED");
  expect(results.diagnostics()[0].nextChunk).toBe(1);
  f.reopen();
  results = new SqliteRequestResultRepository(f.database);
  clock += 1000;
  expect(await make().deliver("r1")).toBe(true);
  expect(sent).toEqual(["photo", "document", "document"]);
  expect(f.requests.get("r1")?.state).toBe("completed");
  expect(f.updates.get("1")?.requestId).toBe("r1");
  expect(f.database.query("SELECT result_payload,plan FROM request_deliveries").get()).toEqual({
    result_payload: null,
    plan: null,
  });
});

test("provider image result traverses core settlement and Telegram delivery once without logging content", async () => {
  const provider = new FakeChatProvider();
  const completion = provider.awaitCompletion.bind(provider);
  provider.awaitCompletion = async (input) => {
    const result = await completion(input);
    return result.state === "completed"
      ? { ...result, message: { text: "", images: [pngImage] } }
      : result;
  };
  const results = new SqliteRequestResultRepository(f.database);
  const s = setupTelegram(f, provider, ["123"], undefined, { results });
  await s.requests.start();
  f.conversations.select("123", "c1");
  const message = update(1, "private image prompt");
  await s.bot.handle(message);
  await s.requests.waitForIdle();
  await s.bot.handle(message);
  expect(provider.submissions).toHaveLength(1);
  expect(s.api.images.map((image) => image.kind)).toEqual(["photo", "document"]);
  expect(s.api.images.map((image) => image.image.base64)).toEqual([
    pngImage.base64,
    pngImage.base64,
  ]);
  expect(s.api.images[1]).toMatchObject({
    chatId: "123",
    replyTo: "101",
    filename: "original-1.png",
  });
  expect(f.requests.get("r1")?.state).toBe("completed");
  expect(s.logs.join("")).not.toContain(pngImage.base64);
  expect(s.logs.join("")).not.toContain("private image prompt");
  expect(results.diagnostics()).toEqual([]);
  await s.requests.shutdown();
});

test("completed image failure delivers its notice once and releases the sole slot for an independent queued request", async () => {
  const provider = new FakeChatProvider({
    capabilities: { maxConcurrentConversations: 1, cancellation: false, fileUpload: true },
  });
  const completion = provider.awaitCompletion.bind(provider);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  provider.awaitCompletion = async (input) => {
    if (input.submission.clientRequestId === "r1") {
      entered.resolve();
      await finish.promise;
      const result = await completion(input);
      return result.state === "completed"
        ? { ...result, message: { text: "", imageError: "GENERATED_IMAGE_UNAVAILABLE" } }
        : result;
    }
    return completion(input);
  };
  provider.plan("r2", { kind: "success", text: "next answer" });
  const results = new SqliteRequestResultRepository(f.database);
  const s = setupTelegram(f, provider, ["123"], undefined, { results });
  const first = update(1, "private image prompt");
  const second = update(2, "independent next request");
  try {
    await s.requests.start();
    f.conversations.select("123", "c1");
    await s.bot.handle(first);
    await entered.promise;
    f.conversations.select("123", "other");
    await s.bot.handle(second);
    expect(f.requests.get("r2")?.state).toBe("queued");
    expect(provider.sendCalls).toEqual(["r1"]);
    finish.resolve();
    await s.requests.waitForIdle();
    await s.bot.handle(first);
    await s.bot.handle(second);
    expect(provider.sendCalls).toEqual(["r1", "r2"]);
    expect(provider.submissions.map((input) => input.conversationId)).toEqual(["remote", "Remote"]);
    expect(f.requests.get("r1")?.state).toBe("completed");
    expect(f.requests.get("r2")?.state).toBe("completed");
    const notices = s.api.sent.filter((message) =>
      message.text.includes("GENERATED_IMAGE_UNAVAILABLE"),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ chatId: "123", replyTo: "101" });
    expect(
      s.api.sent.some((message) => message.text === "next answer" && message.replyTo === "102"),
    ).toBe(true);
    expect(s.api.images).toEqual([]);
    expect(results.diagnostics()).toEqual([]);
    expect(s.logs.join("")).not.toContain("private image prompt");
  } finally {
    finish.resolve();
    await s.requests.shutdown();
  }
});

test.each(["expired", "revoked", "aborted"] as const)(
  "%s image output is not sent and retains provider completion",
  async (mode) => {
    f.store.accept(request(), { text: "prompt", attachments: [] }, 3);
    f.store.claim("r1", later);
    f.requests.transition("r1", { state: "running", at: later });
    const results = new SqliteRequestResultRepository(f.database);
    const result = results.settle(
      "r1",
      { state: "completed", at: later },
      { message: { text: "", images: [pngImage] } },
    );
    const plan = requestResultPlan(result);
    expect(plan).toEqual([
      { kind: "photo", image: 0 },
      { kind: "document", image: 0 },
    ]);
    let sent = 0;
    const controller = new AbortController();
    if (mode === "aborted") controller.abort(new Error("operator stopped"));
    const delivery = new TelegramResultDelivery({
      repository: results,
      api: {
        sendMessage: async () => {
          sent++;
        },
        sendImage: async () => {
          sent++;
        },
      },
      destination: () => (mode === "revoked" ? null : { chatId: "123" }),
      now: () =>
        mode === "expired" ? new Date(Date.parse(later) + 86400000).toISOString() : later,
      signal: controller.signal,
    });
    if (mode === "expired") {
      expect(await delivery.deliver("r1")).toBe(false);
      expect(f.database.query("SELECT result_payload,plan FROM request_deliveries").get()).toEqual({
        result_payload: null,
        plan: null,
      });
    } else await expect(delivery.deliver("r1")).rejects.toThrow();
    expect(sent).toBe(0);
    expect(f.requests.get("r1")?.state).toBe("completed");
  },
);

test.each(["photo", "document"] as const)(
  "%s failures retain delivery-only retry classification and hide URL/token errors",
  async (kind) => {
    for (const [status, minimum] of [
      [503, 0],
      [429, 2000],
      [403, undefined],
    ] as const) {
      const api = new HttpTelegramApi("123:synthetic", async () =>
        Response.json(
          { ok: false, error_code: status, parameters: { retry_after: 2 } },
          { status },
        ),
      );
      try {
        await api.sendImage({ chatId: "123", image: pngImage, kind, filename: "original.png" });
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(TelegramError);
        const failure = error as TelegramError;
        expect(failure.deliveryRetryAfterMs).toBe(minimum);
        expect(failure.pollingRetryAfterMs).toBeUndefined();
        expect(failure.identityRetryAfterMs).toBeUndefined();
      }
    }
    const api = new HttpTelegramApi("123:synthetic", async () => {
      throw new Error("https://api.telegram.org/bot123:synthetic/private");
    });
    try {
      await api.sendImage({ chatId: "123", image: pngImage, kind, filename: "original.png" });
    } catch (error) {
      expect(String(error)).not.toContain("synthetic");
      expect(error).not.toHaveProperty("cause");
    }
  },
);
