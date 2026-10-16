import { expect, test } from "bun:test";
import { FakeBarrier } from "../../src/providers/fake/FakeChatProvider";
import { TelegramError } from "../../src/transports/telegram/TelegramApi";
import { TelegramPolling } from "../../src/transports/telegram/TelegramPolling";
import { FakeTelegramApi, update } from "../fixtures/telegram";

test("token validation precedes startup; polling acknowledges handled updates without waiting for generation", async () => {
  const api = new FakeTelegramApi();
  const events: string[] = [];
  const offsets: (number | undefined)[] = [];
  const controller = new AbortController();
  api.getMe = async () => {
    events.push("getMe");
    return { id: 777, username: "r4_bot" };
  };
  api.getUpdates = async (offset) => {
    offsets.push(offset);
    if (offsets.length === 1) return [update(1, "first"), update(2, "/stop")];
    controller.abort();
    throw controller.signal.reason;
  };
  const runner = new TelegramPolling({
    api,
    initialize: async (identity) => {
      expect(identity.username).toBe("r4_bot");
      expect(runner.ready()).toBe(false);
      events.push("initialize");
    },
    handle: async (input) => {
      expect(runner.ready()).toBe(true);
      events.push(`handle:${input.update_id}`);
    },
    shutdown: async () => {
      events.push("shutdown");
    },
  });
  await runner.run(controller.signal);
  expect(offsets).toEqual([undefined, 3]);
  expect(events).toEqual(["getMe", "initialize", "handle:1", "handle:2", "shutdown"]);
  expect(runner.ready()).toBe(false);
});

test("failed handler stops polling without acknowledging later updates or retrying effects", async () => {
  const api = new FakeTelegramApi();
  let polls = 0,
    shutdowns = 0;
  const handled: number[] = [];
  api.getUpdates = async () => {
    polls++;
    return [update(1, "first"), update(2, "second")];
  };
  const runner = new TelegramPolling({
    api,
    initialize: async () => {},
    handle: async (input) => {
      handled.push(input.update_id);
      throw new Error("fixture storage failure");
    },
    shutdown: async () => {
      shutdowns++;
    },
  });
  await expect(runner.run(new AbortController().signal)).rejects.toThrow("fixture storage failure");
  expect(handled).toEqual([1]);
  expect({ polls, shutdowns }).toEqual({ polls: 1, shutdowns: 1 });
  expect(runner.ready()).toBe(false);
});

test("invalid token never starts application or polls; transport errors are fatal without retries", async () => {
  for (const failAt of ["getMe", "getUpdates"] as const) {
    const api = new FakeTelegramApi();
    let initializations = 0,
      polls = 0,
      shutdowns = 0;
    api.getMe = async () => {
      if (failAt === "getMe") throw new TelegramError("TELEGRAM_TOKEN_INVALID");
      return { id: 777, username: "r4_bot" };
    };
    api.getUpdates = async () => {
      polls++;
      throw new TelegramError("TELEGRAM_UNAVAILABLE");
    };
    const runner = new TelegramPolling({
      api,
      initialize: async () => {
        initializations++;
      },
      handle: async () => {},
      shutdown: async () => {
        shutdowns++;
      },
    });
    await expect(runner.run(new AbortController().signal)).rejects.toThrow(
      failAt === "getMe" ? "TELEGRAM_TOKEN_INVALID" : "TELEGRAM_UNAVAILABLE",
    );
    expect(initializations).toBe(failAt === "getMe" ? 0 : 1);
    expect(polls).toBe(failAt === "getMe" ? 0 : 1);
    expect(shutdowns).toBe(1);
    expect(runner.ready()).toBe(false);
  }
});

test("shutdown during initialization joins cleanup and never opens polling after an abort", async () => {
  const api = new FakeTelegramApi();
  const entered = new FakeBarrier(),
    release = new FakeBarrier();
  let polls = 0,
    shutdowns = 0;
  api.getUpdates = async () => {
    polls++;
    return [];
  };
  const controller = new AbortController();
  const runner = new TelegramPolling({
    api,
    initialize: async () => {
      entered.release();
      await release.promise;
    },
    handle: async () => {},
    shutdown: async () => {
      shutdowns++;
      release.release();
    },
  });
  const running = runner.run(controller.signal);
  await entered.promise;
  controller.abort();
  await running;
  expect({ polls, shutdowns }).toEqual({ polls: 0, shutdowns: 1 });
  expect(runner.ready()).toBe(false);
});

test("abort stops a batch before later handling, and a pre-aborted runner performs no API calls", async () => {
  const api = new FakeTelegramApi();
  const controller = new AbortController();
  const handled: number[] = [];
  api.getUpdates = async () => [update(1, "first"), update(2, "later")];
  const runner = new TelegramPolling({
    api,
    initialize: async () => {},
    handle: async (input) => {
      handled.push(input.update_id);
      controller.abort();
    },
    shutdown: async () => {},
  });
  await runner.run(controller.signal);
  expect(handled).toEqual([1]);
  api.getMe = async () => {
    throw new Error("must not call");
  };
  await new TelegramPolling({
    api,
    initialize: async () => {},
    handle: async () => {},
    shutdown: async () => {},
  }).run(controller.signal);
});
