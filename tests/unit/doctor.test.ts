import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireGatewayLease } from "../../src/persistence/sqlite/GatewayLease";
import { FakeBarrier, FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
import { doctor } from "../../src/runtime/Doctor";
import { TelegramError } from "../../src/transports/telegram/TelegramApi";
import { QueueFixture, later, request } from "../fixtures/queue";
import { FakeTelegramApi } from "../fixtures/telegram";

let f: QueueFixture;
beforeEach(() => {
  f = new QueueFixture();
});
afterEach(() => f.close());
function env() {
  return {
    TELEGRAM_BOT_TOKEN: "123456789:PRIVATE_TEST_TOKEN",
    TELEGRAM_ALLOWED_USER_IDS: "123",
    DATABASE_PATH: f.path,
    BROWSER_PROFILE_DIR: join(f.root, "profile"),
    ATTACHMENT_TEMP_DIR: join(f.root, "files"),
  };
}
function initializedProfile() {
  const profile = env().BROWSER_PROFILE_DIR;
  mkdirSync(profile);
  writeFileSync(
    join(profile, "gateway-profile.json"),
    JSON.stringify({ owner: "tg-webgpt-gateway", version: 1 }),
  );
}

test("invalid configuration has a structured safe report before any network or profile effects", async () => {
  let calls = 0;
  const before = readdirSync(f.root);
  const result = await doctor(
    { ...env(), TELEGRAM_ALLOWED_USER_IDS: "private invalid value" },
    f.root,
    {
      api: {
        getMe: async () => {
          calls++;
          throw new Error();
        },
      },
      provider: () => {
        calls++;
        throw new Error();
      },
    },
  );
  expect(result.readyToStart).toBe(false);
  expect(result.checks.config).toMatchObject({ state: "unavailable", errorCode: "CONFIG_ERROR" });
  expect(result.checks.database.state).toBe("not_checked");
  expect(calls).toBe(0);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_TEST_TOKEN");
  expect(JSON.stringify(result)).not.toContain("private invalid value");
  expect(readdirSync(f.root)).toEqual(before);
});

test("AC-J04 stopped-gateway doctor only probes getMe and provider health, preserves DB, then releases its lease", async () => {
  initializedProfile();
  const api = new FakeTelegramApi();
  const provider = new FakeChatProvider();
  let health = 0,
    closed = 0,
    getMe = 0;
  api.getMe = async () => {
    getMe++;
    return { id: 777, username: "test_bot" };
  };
  provider.health = async () => {
    health++;
    return { state: "ready", observedAt: later };
  };
  const before = f.database.serialize();
  const marker = readFileSync(join(env().BROWSER_PROFILE_DIR, "gateway-profile.json"));
  const result = await doctor(env(), f.root, {
    api,
    provider: () =>
      Object.assign(provider, {
        close: async () => {
          closed++;
        },
      }),
  });
  expect(result.readyToStart).toBe(true);
  expect(result.checks.runtime.state).toBe("stopped");
  expect(result.checks.provider.state).toBe("ready");
  expect({ health, closed, getMe }).toEqual({ health: 1, closed: 1, getMe: 1 });
  expect(provider.sendCalls).toHaveLength(0);
  expect(provider.inspections).toHaveLength(0);
  expect(provider.cancelCalls).toHaveLength(0);
  expect(api.sent).toHaveLength(0);
  expect(f.database.serialize()).toEqual(before);
  expect(readFileSync(join(env().BROWSER_PROFILE_DIR, "gateway-profile.json"))).toEqual(marker);
  const release = acquireGatewayLease(f.path);
  release();
});

test("a running gateway blocks CLI provider probing without taking or deleting its lease", async () => {
  initializedProfile();
  const release = acquireGatewayLease(f.path);
  let calls = 0;
  try {
    const result = await doctor(env(), f.root, {
      api: new FakeTelegramApi(),
      provider: () => {
        calls++;
        return new FakeChatProvider();
      },
    });
    expect(result.readyToStart).toBe(false);
    expect(result.checks.runtime.state).toBe("busy");
    expect(result.checks.provider.state).toBe("not_checked");
    expect(calls).toBe(0);
    expect(() => acquireGatewayLease(f.path)).toThrow("DATABASE_ERROR");
    expect(existsSync(`${f.path}-gateway-lock`)).toBe(true);
  } finally {
    release();
  }
});

test("doctor holds the process lease until provider disposal finishes", async () => {
  initializedProfile();
  const closing = new FakeBarrier(),
    finish = new FakeBarrier();
  const running = doctor(env(), f.root, {
    api: new FakeTelegramApi(),
    provider: () => ({
      health: async () => ({ state: "ready", observedAt: later }),
      close: async () => {
        closing.release();
        await finish.promise;
      },
    }),
  });
  await closing.promise;
  expect(() => acquireGatewayLease(f.path)).toThrow("DATABASE_ERROR");
  finish.release();
  expect((await running).readyToStart).toBe(true);
  const release = acquireGatewayLease(f.path);
  release();
});

test("a provider factory failure releases the lease and returns fixed diagnostics", async () => {
  initializedProfile();
  const result = await doctor(env(), f.root, {
    api: new FakeTelegramApi(),
    provider: () => {
      throw new Error("private constructor details");
    },
  });
  expect(result.readyToStart).toBe(false);
  expect(result.checks.provider).toEqual({
    state: "unavailable",
    errorCode: "PROVIDER_UNAVAILABLE",
  });
  expect(JSON.stringify(result)).not.toContain("private");
  const release = acquireGatewayLease(f.path);
  release();
});

test.each(["auth_required", "throw", "malformed", "close_failure"] as const)(
  "provider %s never yields ready or raw native data",
  async (mode) => {
    initializedProfile();
    let closed = 0;
    const result = await doctor(env(), f.root, {
      api: new FakeTelegramApi(),
      provider: () => ({
        health: async () => {
          if (mode === "throw") throw new Error("private native URL/cookie");
          return {
            state:
              mode === "auth_required"
                ? "auth_required"
                : mode === "malformed"
                  ? "private native cookie"
                  : "ready",
            observedAt: later,
          } as Awaited<ReturnType<FakeChatProvider["health"]>>;
        },
        close: async () => {
          closed++;
          if (mode === "close_failure") throw new Error("private close details");
        },
      }),
    });
    expect(result.readyToStart).toBe(false);
    expect(result.checks.provider.state).toBe(
      mode === "auth_required" ? "auth_required" : "unavailable",
    );
    expect(closed).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private");
    const release = acquireGatewayLease(f.path);
    release();
  },
);

test.each(["invalid_token", "network"] as const)(
  "Telegram %s is distinguishable without polling, sending or leaking the token",
  async (mode) => {
    initializedProfile();
    const result = await doctor(env(), f.root, {
      api: {
        getMe: async () => {
          throw mode === "invalid_token"
            ? new TelegramError("TELEGRAM_TOKEN_INVALID")
            : new Error("https://private/bot123456789:PRIVATE_TEST_TOKEN/getMe");
        },
      },
      provider: () => new FakeChatProvider(),
    });
    expect(result.readyToStart).toBe(false);
    expect(result.checks.telegram).toEqual({
      state: "unavailable",
      errorCode: mode === "invalid_token" ? "TELEGRAM_TOKEN_INVALID" : "TELEGRAM_UNAVAILABLE",
    });
    expect(result.checks.provider.state).toBe("ready");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_TEST_TOKEN");
    expect(JSON.stringify(result)).not.toContain("private");
  },
);

test("missing profile and database are reported without initializing either", async () => {
  let calls = 0;
  const dependencies = {
    api: new FakeTelegramApi(),
    provider: () => {
      calls++;
      return new FakeChatProvider();
    },
  };
  const profile = await doctor(env(), f.root, dependencies);
  expect(profile.checks.provider).toEqual({
    state: "not_checked",
    reason: "profile_not_initialized",
  });
  expect(existsSync(env().BROWSER_PROFILE_DIR)).toBe(false);
  const missing = await doctor(
    { ...env(), DATABASE_PATH: join(f.root, "missing", "gateway.sqlite") },
    f.root,
    dependencies,
  );
  expect(missing.checks.database.state).toBe("missing");
  expect(existsSync(join(f.root, "missing"))).toBe(false);
  expect(calls).toBe(0);
});

test("an unresolved UNKNOWN makes the preflight non-ready while preserving independent queued work", async () => {
  initializedProfile();
  f.store.accept(request("blocked"), { text: "private original", attachments: [] }, 3);
  f.store.claim("blocked", later);
  f.requests.transition("blocked", { state: "unknown", at: later });
  f.store.accept(request("next", "2", "other"), { text: "private successor", attachments: [] }, 3);
  const result = await doctor(env(), f.root, {
    api: new FakeTelegramApi(),
    provider: () => new FakeChatProvider(),
  });
  expect(result.readyToStart).toBe(false);
  expect(result.checks.database).toMatchObject({
    state: "ready",
    blockedRequests: 1,
    queuedRequests: 1,
  });
  expect(f.store.snapshot().queued[0].request.id).toBe("next");
  expect(f.requests.get("blocked")?.state).toBe("unknown");
  expect(JSON.stringify(result)).not.toContain("private");
});
