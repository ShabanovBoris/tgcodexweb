import { expect, test } from "bun:test";
import { createLogger } from "../../src/logging/logger";
import { HttpTelegramApi, TelegramError } from "../../src/transports/telegram/TelegramApi";
import { TelegramPolling } from "../../src/transports/telegram/TelegramPolling";
import { FakeTelegramApi } from "../fixtures/telegram";

test("startup identity retry is bounded, precedes all initialization and does not retry application effects", async () => {
  const api = new FakeTelegramApi(),
    controller = new AbortController();
  let identities = 0,
    initializations = 0,
    polls = 0,
    shutdowns = 0;
  const delays: number[] = [],
    logs: string[] = [];
  api.getMe = async () => {
    expect(initializations).toBe(0);
    expect(runner.ready()).toBe(false);
    if (++identities <= 2)
      throw new TelegramError("TELEGRAM_UNAVAILABLE", undefined, undefined, 15000);
    return { id: 777, username: "test_bot" };
  };
  api.getUpdates = async () => {
    if (++polls > 1) {
      controller.abort();
      throw controller.signal.reason;
    }
    return [];
  };
  const runner = new TelegramPolling({
    api,
    initialize: async () => {
      initializations++;
    },
    handle: async () => {
      throw new Error("no ingress expected");
    },
    shutdown: async () => {
      shutdowns++;
    },
    wait: async (ms) => {
      delays.push(ms);
    },
    log: createLogger({ sink: (line) => logs.push(line) }),
  });
  await runner.run(controller.signal);
  expect({ identities, initializations, polls, shutdowns }).toEqual({
    identities: 3,
    initializations: 1,
    polls: 2,
    shutdowns: 1,
  });
  expect(delays).toEqual([15000, 15000]);
  expect(logs.map((line) => JSON.parse(line).operation)).toEqual([
    "telegram.identity_retry",
    "telegram.identity_retry",
    "telegram.identity_recovered",
  ]);
});

test("identity retry budget exhausts without initializing a database/provider or polling", async () => {
  const api = new FakeTelegramApi();
  let identities = 0,
    effects = 0;
  const delays: number[] = [];
  api.getMe = async () => {
    identities++;
    throw new TelegramError("TELEGRAM_UNAVAILABLE", undefined, undefined, 0);
  };
  api.getUpdates = async () => {
    effects++;
    return [];
  };
  const runner = new TelegramPolling({
    api,
    initialize: async () => {
      effects++;
    },
    handle: async () => {},
    shutdown: async () => {},
    wait: async (ms) => {
      delays.push(ms);
    },
  });
  await expect(runner.run(new AbortController().signal)).rejects.toThrow("TELEGRAM_UNAVAILABLE");
  expect(identities).toBe(6);
  expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);
  expect(effects).toBe(0);
});

test.each([undefined, -1, 60001])(
  "an unusable identity minimum %s is fatal and cannot authorize an early retry",
  async (minimum) => {
    const api = new FakeTelegramApi();
    let calls = 0,
      waits = 0;
    api.getMe = async () => {
      calls++;
      throw new TelegramError("TELEGRAM_UNAVAILABLE", undefined, undefined, minimum);
    };
    const runner = new TelegramPolling({
      api,
      initialize: async () => {},
      handle: async () => {},
      shutdown: async () => {},
      wait: async () => {
        waits++;
      },
    });
    await expect(runner.run(new AbortController().signal)).rejects.toThrow("TELEGRAM_UNAVAILABLE");
    expect({ calls, waits }).toEqual({ calls: 1, waits: 0 });
  },
);

test("SIGTERM-style abort during identity backoff stops before application initialization", async () => {
  const api = new FakeTelegramApi(),
    controller = new AbortController();
  let calls = 0,
    effects = 0;
  api.getMe = async () => {
    calls++;
    throw new TelegramError("TELEGRAM_UNAVAILABLE", undefined, undefined, 0);
  };
  const runner = new TelegramPolling({
    api,
    initialize: async () => {
      effects++;
    },
    handle: async () => {},
    shutdown: async () => {},
    wait: async (_ms, signal) => {
      controller.abort(new Error("stopped"));
      signal.throwIfAborted();
    },
  });
  await expect(runner.run(controller.signal)).resolves.toBeUndefined();
  expect({ calls, effects }).toEqual({ calls: 1, effects: 0 });
});

test("getMe hints are independent of polling/delivery; token, TLS and malformed success remain fatal", async () => {
  const token = "123456789:IDENTITY_TEST_TOKEN";
  for (const mode of [
    "network",
    "tls",
    "server",
    "flood",
    "broken_flood",
    "token",
    "malformed",
  ] as const) {
    const api = new HttpTelegramApi(token, async () => {
      if (mode === "network" || mode === "tls")
        throw Object.assign(new Error(`private ${token}`), {
          code: mode === "network" ? "ECONNRESET" : "CERT_HAS_EXPIRED",
        });
      if (mode === "server" || mode === "token" || mode === "broken_flood") {
        const response = new Response("", {
          status: mode === "server" ? 503 : mode === "token" ? 401 : 429,
        });
        response.json = async () => {
          throw new TypeError("private body details");
        };
        return response;
      }
      return mode === "flood"
        ? Response.json(
            { ok: false, error_code: 429, parameters: { retry_after: 3 } },
            { status: 429 },
          )
        : Response.json({ ok: true, result: {} });
    });
    const error = (await api.getMe().catch((error) => error)) as TelegramError;
    expect(error.identityRetryAfterMs).toBe(
      mode === "network" || mode === "server" ? 0 : mode === "flood" ? 3000 : undefined,
    );
    expect(error.pollingRetryAfterMs).toBeUndefined();
    expect(error.deliveryRetryAfterMs).toBeUndefined();
    expect(String(error)).not.toContain("private");
    if (mode === "token") expect(error.code).toBe("TELEGRAM_TOKEN_INVALID");
  }
});

test("cancelling the active identity HTTP request propagates the exact reason", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const api = new HttpTelegramApi("123456789:IDENTITY_TEST_TOKEN", async (_url, input) => {
    entered.resolve();
    await new Promise((_, reject) =>
      input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true }),
    );
    throw new Error("unreachable");
  });
  const operation = api.getMe(controller.signal);
  await entered.promise;
  controller.abort(new Error("stopped"));
  await expect(operation).rejects.toBe(controller.signal.reason);
});
