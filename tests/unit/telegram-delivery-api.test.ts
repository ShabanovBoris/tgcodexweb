import { expect, test } from "bun:test";
import { HttpTelegramApi, TelegramError } from "../../src/transports/telegram/TelegramApi";

const token = "123456789:DELIVERY_SYNTHETIC_TOKEN";
function unreadable(status: number): Response {
  const response = new Response("", { status });
  response.json = async () => {
    throw new TypeError(`private ${token}`);
  };
  return response;
}
async function failure(api: HttpTelegramApi) {
  try {
    await api.sendMessage({ chatId: "123", text: "private answer" });
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(TelegramError);
    return error as TelegramError;
  }
}

test.each([500, 503, 599])(
  "send HTTP %s has a delivery-only hint even if reading its body fails",
  async (status) => {
    const api = new HttpTelegramApi(token, async () => unreadable(status));
    const error = await failure(api);
    expect(error.code).toBe("TELEGRAM_DELIVERY_FAILED");
    expect(error.deliveryRetryAfterMs).toBe(0);
    expect(error.pollingRetryAfterMs).toBeUndefined();
    expect(String(error)).not.toContain(token);
  },
);

test("ambiguous native send errors and missing Message receipt are retryable without exposing content", async () => {
  for (const fetcher of [
    async () => {
      throw new Error(`private ${token}`);
    },
    async () => Response.json({ ok: true, result: {} }),
  ]) {
    const error = await failure(new HttpTelegramApi(token, fetcher));
    expect(error.deliveryRetryAfterMs).toBe(0);
    expect(error.pollingRetryAfterMs).toBeUndefined();
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("private");
  }
});

test.each([0, 2, 60, 61])(
  "delivery flood control preserves retry_after=%s seconds for the caller's bounded policy",
  async (seconds) => {
    const error = await failure(
      new HttpTelegramApi(token, async () =>
        Response.json(
          { ok: false, error_code: 429, parameters: { retry_after: seconds } },
          { status: 429 },
        ),
      ),
    );
    expect(error.deliveryRetryAfterMs).toBe(seconds * 1000);
    expect(error.pollingRetryAfterMs).toBeUndefined();
  },
);

test.each([undefined, -1, 1.5, "2", Number.MAX_SAFE_INTEGER])(
  "invalid flood delay %s never permits guessing an early send retry",
  async (seconds) => {
    const error = await failure(
      new HttpTelegramApi(token, async () =>
        Response.json(
          { ok: false, error_code: 429, parameters: { retry_after: seconds } },
          { status: 429 },
        ),
      ),
    );
    expect(error.deliveryRetryAfterMs).toBeUndefined();
  },
);

test.each([400, 401, 403, 409, 429])(
  "unreadable HTTP %s remains fatal and never gains a native-error retry hint",
  async (status) => {
    const error = await failure(new HttpTelegramApi(token, async () => unreadable(status)));
    expect(error.deliveryRetryAfterMs).toBeUndefined();
  },
);

test("send cancellation reaches fetch and preserves the exact AbortSignal reason", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const api = new HttpTelegramApi(token, async (_url, input) => {
    entered.resolve();
    await new Promise((_, reject) =>
      input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true }),
    );
    throw new Error("unreachable");
  });
  const operation = api.sendMessage({ chatId: "123", text: "private answer" }, controller.signal);
  await entered.promise;
  controller.abort(new Error("operator stopped"));
  await expect(operation).rejects.toBe(controller.signal.reason);
});
