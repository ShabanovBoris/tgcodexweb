import { expect, test } from "bun:test";
import { HttpTelegramApi, TelegramError } from "../../src/transports/telegram/TelegramApi";

const token = "123456789:R4_SYNTHETIC_TOKEN";
function mockApi(replies: readonly Readonly<{ status?: number; body: unknown }>[]) {
  const calls: { url: string; input: RequestInit }[] = [];
  const api = new HttpTelegramApi(token, async (url, input) => {
    calls.push({ url: String(url), input: input ?? {} });
    const reply = replies[calls.length - 1];
    if (!reply) throw new Error(`private fetch error ${token}`);
    return Response.json(reply.body, { status: reply.status ?? 200 });
  });
  return { api, calls };
}

test("AC-A02 getMe validates actual bot identity and normalizes token failure without secrets", async () => {
  const { api, calls } = mockApi([
    {
      body: {
        ok: true,
        result: { id: 777, is_bot: true, username: "r4_bot", first_name: "fixture" },
      },
    },
  ]);
  expect(await api.getMe()).toEqual({ id: 777, username: "r4_bot" });
  expect(calls[0].input.method).toBe("POST");
  expect(calls[0].input.redirect).toBe("error");
  expect(calls[0].url).toBe(`https://api.telegram.org/bot${token}/getMe`);
  for (const status of [401, 404]) {
    const failed = mockApi([
      { status, body: { ok: false, error_code: status, description: token } },
    ]);
    try {
      await failed.api.getMe();
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TelegramError);
      expect((error as TelegramError).code).toBe("TELEGRAM_TOKEN_INVALID");
      expect(String(error)).not.toContain(token);
      expect(error).not.toHaveProperty("cause");
    }
  }
  expect(() => new HttpTelegramApi("bad/token?other-host")).toThrow("TELEGRAM_TOKEN_INVALID");
});

test("poll requests only messages with explicit offset, preserves stable safe numeric IDs", async () => {
  const input = {
    update_id: 2147483600,
    message: {
      message_id: 99,
      from: { id: 4503599627370000, is_bot: false },
      chat: { id: 4503599627370000, type: "private" },
      text: "synthetic",
      reply_to_message: { text: "unrelated" },
    },
  };
  const { api, calls } = mockApi([
    {
      body: { ok: true, result: [input, { update_id: 2147483601, edited_message: input.message }] },
    },
  ]);
  const updates = await api.getUpdates(123, new AbortController().signal);
  expect(updates[0].message?.from?.id).toBe(4503599627370000);
  expect(updates[0].message).not.toHaveProperty("reply_to_message");
  expect(updates[1]).toEqual({ update_id: 2147483601 });
  expect(JSON.parse(String(calls[0].input.body))).toEqual({
    offset: 123,
    timeout: 25,
    allowed_updates: ["message"],
  });
});

test("sendMessage uses reply_parameters and plain mode omits parse_mode", async () => {
  const { api, calls } = mockApi([
    { body: { ok: true, result: { message_id: 1 } } },
    { body: { ok: true, result: { message_id: 2 } } },
  ]);
  await api.sendMessage({
    chatId: "123",
    replyTo: "45",
    text: "<pre>&lt;</pre>",
    parseMode: "HTML",
  });
  await api.sendMessage({ chatId: "123", text: "<&>" });
  expect(JSON.parse(String(calls[0].input.body))).toEqual({
    chat_id: "123",
    text: "<pre>&lt;</pre>",
    parse_mode: "HTML",
    reply_parameters: { message_id: 45, allow_sending_without_reply: true },
    link_preview_options: { is_disabled: true },
  });
  expect(JSON.parse(String(calls[1].input.body))).not.toHaveProperty("parse_mode");
});

test("only explicit 400 parser rejection permits fallback; delivery/429/500 are never retried", async () => {
  for (const [status, description, code] of [
    [400, "Bad Request: can't parse entities: fixture", "TELEGRAM_PARSE_ERROR"],
    [400, "Bad Request: chat not found", "TELEGRAM_DELIVERY_FAILED"],
    [429, "retry later", "TELEGRAM_DELIVERY_FAILED"],
    [500, "Bad Request: can't parse entities: fixture", "TELEGRAM_DELIVERY_FAILED"],
  ] as const) {
    const { api, calls } = mockApi([
      { status, body: { ok: false, error_code: status, description } },
    ]);
    await expect(
      api.sendMessage({ chatId: "123", text: "answer", parseMode: "HTML" }),
    ).rejects.toThrow(code);
    expect(calls).toHaveLength(1);
  }
});

test("contradictory success or HTTP failure cannot prove an unsent parser rejection", async () => {
  for (const [status, ok] of [
    [400, true],
    [500, false],
  ] as const) {
    const { api, calls } = mockApi([
      {
        status,
        body: {
          ok,
          result: { message_id: 1 },
          error_code: 400,
          description: "Bad Request: can't parse entities: fixture",
        },
      },
    ]);
    await expect(
      api.sendMessage({ chatId: "123", text: "answer", parseMode: "HTML" }),
    ).rejects.toThrow("TELEGRAM_DELIVERY_FAILED");
    expect(calls).toHaveLength(1);
  }
});

test("malformed envelopes, unsafe IDs and raw fetch exceptions remain non-ready/safe", async () => {
  for (const body of [
    { ok: true, result: { id: 1, is_bot: false, username: "r4_bot" } },
    { ok: true, result: { id: Number.MAX_SAFE_INTEGER + 1, is_bot: true, username: "r4_bot" } },
    "unexpected",
  ]) {
    await expect(mockApi([{ body }]).api.getMe()).rejects.toThrow("TELEGRAM_UNAVAILABLE");
  }
  const { api } = mockApi([]);
  await expect(api.getMe()).rejects.toThrow("TELEGRAM_UNAVAILABLE");
  await expect(api.sendMessage({ chatId: "123", text: "synthetic" })).rejects.toThrow(
    "TELEGRAM_DELIVERY_FAILED",
  );
  await expect(
    mockApi([{ body: { ok: true, result: [{ update_id: "1" }] } }]).api.getUpdates(
      undefined,
      new AbortController().signal,
    ),
  ).rejects.toThrow("TELEGRAM_UNAVAILABLE");
});

test("caller cancellation is propagated without normalizing it as a transport failure", async () => {
  const controller = new AbortController();
  const reason = new Error("fixture abort");
  const api = new HttpTelegramApi(token, async () => {
    controller.abort(reason);
    throw new Error("raw");
  });
  await expect(api.getUpdates(undefined, controller.signal)).rejects.toBe(reason);
});
