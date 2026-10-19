import { expect, test } from "bun:test";
import { FakeBarrier } from "../../src/providers/fake/FakeChatProvider";
import { createLogger } from "../../src/logging/logger";
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

test("invalid token never starts application or polls; unclassified transport errors are fatal", async () => {
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

function reconnectFixture(replies: readonly (ReturnType<typeof update>[] | Error)[]) {
  const api = new FakeTelegramApi();
  const controller = new AbortController();
  const observed = {
    offsets: [] as (number | undefined)[],
    delays: [] as number[],
    handled: [] as number[],
    readyAtPoll: [] as boolean[],
    initializations: 0,
    shutdowns: 0,
    identities: 0,
    logs: [] as string[],
  };
  api.getMe = async () => {
    observed.identities++;
    return { id: 777, username: "r4_bot" };
  };
  api.getUpdates = async (offset) => {
    observed.offsets.push(offset);
    observed.readyAtPoll.push(runner.ready());
    const next = replies[observed.offsets.length - 1];
    if (!next) {
      controller.abort();
      throw controller.signal.reason;
    }
    if (next instanceof Error) throw next;
    return next;
  };
  const runner = new TelegramPolling({
    api,
    initialize: async () => {
      observed.initializations++;
    },
    handle: async (input) => {
      observed.handled.push(input.update_id);
    },
    shutdown: async () => {
      observed.shutdowns++;
    },
    wait: async (ms, signal) => {
      expect(runner.ready()).toBe(false);
      expect(signal).toBe(controller.signal);
      observed.delays.push(ms);
    },
    log: createLogger({ sink: (line) => observed.logs.push(line) }),
  });
  return { runner, api, controller, observed };
}

test("R7 reconnect keeps the handled offset, restores readiness and initializes only once", async () => {
  const f = reconnectFixture([
    [update(7, "synthetic")],
    new TelegramError("TELEGRAM_UNAVAILABLE", 0),
    [update(8, "synthetic")],
  ]);
  await f.runner.run(f.controller.signal);
  expect(f.observed.offsets).toEqual([undefined, 8, 8, 9]);
  expect(f.observed.readyAtPoll).toEqual([false, true, false, true]);
  expect(f.observed.handled).toEqual([7, 8]);
  expect(f.observed.delays).toEqual([1000]);
  expect(f.observed.initializations).toBe(1);
  expect(f.observed.identities).toBe(1);
  expect(f.observed.shutdowns).toBe(1);
  expect(f.observed.logs.map((line) => JSON.parse(line).operation)).toEqual([
    "telegram.poll_retry",
    "telegram.poll_recovered",
  ]);
  expect(f.runner.ready()).toBe(false);
  await expect(f.runner.run(f.controller.signal)).rejects.toThrow("TELEGRAM_ALREADY_STARTED");
});

test.each([true, false])(
  "R7 startup stays non-ready until the first poll succeeds (empty=%s)",
  async (empty) => {
    const api = new FakeTelegramApi();
    const controller = new AbortController();
    const firstEntered = new FakeBarrier(),
      firstResponse = new FakeBarrier(),
      secondEntered = new FakeBarrier();
    const handled: number[] = [];
    let polls = 0,
      shutdowns = 0;
    api.getUpdates = async (_offset, signal) => {
      if (++polls === 1) {
        firstEntered.release();
        await firstResponse.promise;
        return empty ? [] : [update(7, "synthetic")];
      }
      secondEntered.release();
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    };
    const runner = new TelegramPolling({
      api,
      initialize: async () => {},
      handle: async (input) => {
        expect(runner.ready()).toBe(true);
        handled.push(input.update_id);
      },
      shutdown: async () => {
        shutdowns++;
      },
    });
    const running = runner.run(controller.signal);
    await firstEntered.promise;
    const readyBeforeResponse = runner.ready();
    firstResponse.release();
    await secondEntered.promise;
    const readyAfterResponse = runner.ready();
    controller.abort();
    await running;
    expect(readyBeforeResponse).toBe(false);
    expect(readyAfterResponse).toBe(true);
    expect(runner.ready()).toBe(false);
    expect(handled).toEqual(empty ? [] : [7]);
    expect({ polls, shutdowns }).toEqual({ polls: 2, shutdowns: 1 });
  },
);

test("R7 five retries are bounded and the sixth consecutive failure shuts down once", async () => {
  const error = new TelegramError("TELEGRAM_UNAVAILABLE", 0);
  const f = reconnectFixture(Array(6).fill(error));
  await expect(f.runner.run(f.controller.signal)).rejects.toBe(error);
  expect(f.observed.delays).toEqual([1000, 2000, 4000, 8000, 16000]);
  expect(f.observed.offsets).toEqual(Array(6).fill(undefined));
  expect(f.observed.shutdowns).toBe(1);
  expect(JSON.parse(f.observed.logs.at(-1) ?? "{}")).toMatchObject({
    operation: "telegram.poll_failed",
    reason: "retry_exhausted",
  });
});

test("R7 a successful empty poll resets the full consecutive failure budget", async () => {
  const errors = Array(5).fill(new TelegramError("TELEGRAM_UNAVAILABLE", 0));
  const f = reconnectFixture([...errors, [], ...errors, []]);
  await f.runner.run(f.controller.signal);
  expect(f.observed.delays).toEqual([1000, 2000, 4000, 8000, 16000, 1000, 2000, 4000, 8000, 16000]);
  expect(f.observed.initializations).toBe(1);
});

test("R7 retry_after is a minimum, capped at 60 seconds without retrying early", async () => {
  const f = reconnectFixture([
    new TelegramError("TELEGRAM_UNAVAILABLE", 3000),
    new TelegramError("TELEGRAM_UNAVAILABLE", 0),
    new TelegramError("TELEGRAM_UNAVAILABLE", 60000),
    [],
  ]);
  await f.runner.run(f.controller.signal);
  expect(f.observed.delays).toEqual([3000, 2000, 60000]);
  for (const delay of [60001, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    const failure = new TelegramError("TELEGRAM_UNAVAILABLE", delay);
    const fatal = reconnectFixture([failure]);
    await expect(fatal.runner.run(fatal.controller.signal)).rejects.toBe(failure);
    expect(fatal.observed.delays).toEqual([]);
    expect(fatal.observed.offsets).toEqual([undefined]);
  }
});

test("R7 fatal errors and a handler failure carrying a retry hint never replay effects", async () => {
  for (const error of [
    new TelegramError("TELEGRAM_TOKEN_INVALID", 0),
    new TelegramError("TELEGRAM_CONFLICT", 0),
    new TelegramError("TELEGRAM_DELIVERY_FAILED", 0),
    new TelegramError("TELEGRAM_UNAVAILABLE"),
    new Error("unclassified"),
  ]) {
    const f = reconnectFixture([error]);
    await expect(f.runner.run(f.controller.signal)).rejects.toBe(error);
    expect(f.observed.delays).toEqual([]);
    expect(f.observed.offsets).toEqual([undefined]);
  }
  const f = reconnectFixture([[update(7, "synthetic"), update(8, "later")]]);
  f.api.sendMessage = async () => {
    throw new TelegramError("TELEGRAM_UNAVAILABLE", 0);
  };
  let effects = 0;
  const runner = new TelegramPolling({
    api: f.api,
    initialize: async () => {},
    shutdown: async () => {},
    handle: async () => {
      effects++;
      await f.api.sendMessage({ chatId: "123", text: "synthetic" });
    },
  });
  await expect(runner.run(f.controller.signal)).rejects.toThrow("TELEGRAM_UNAVAILABLE");
  expect(effects).toBe(1);
  expect(f.observed.offsets).toEqual([undefined]);
});

test("R7 abort during the real backoff or active poll exits promptly without a second poll", async () => {
  for (const during of ["backoff", "poll"] as const) {
    const api = new FakeTelegramApi();
    const controller = new AbortController();
    const entered = new FakeBarrier();
    let polls = 0,
      shutdowns = 0;
    api.getUpdates = async (_offset, signal) => {
      polls++;
      if (during === "backoff") throw new TelegramError("TELEGRAM_UNAVAILABLE", 60000);
      entered.release();
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    };
    const runner = new TelegramPolling({
      api,
      initialize: async () => {},
      handle: async () => {},
      shutdown: async () => {
        shutdowns++;
      },
      log: createLogger({ sink: () => entered.release() }),
    });
    const running = runner.run(controller.signal);
    await entered.promise;
    controller.abort(new Error("fixture stop"));
    await running;
    expect({ polls, shutdowns }).toEqual({ polls: 1, shutdowns: 1 });
    expect(runner.ready()).toBe(false);
  }
});

test("R7 retry hints cannot repeat getMe or application initialization", async () => {
  for (const failAt of ["getMe", "initialize"] as const) {
    const f = reconnectFixture([]);
    let attempts = 0;
    const failure = new TelegramError("TELEGRAM_UNAVAILABLE", 0);
    if (failAt === "getMe")
      f.api.getMe = async () => {
        attempts++;
        throw failure;
      };
    const runner = new TelegramPolling({
      api: f.api,
      initialize: async () => {
        attempts++;
        throw failure;
      },
      handle: async () => {},
      shutdown: async () => {},
      wait: async () => {
        throw new Error("must not retry startup");
      },
    });
    await expect(runner.run(f.controller.signal)).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(f.observed.offsets).toEqual([]);
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
