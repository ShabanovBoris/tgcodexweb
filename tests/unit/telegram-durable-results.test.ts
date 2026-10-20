import { afterEach, beforeEach, expect, test } from "bun:test";
import { SqliteRequestResultRepository } from "../../src/persistence/sqlite/SqliteRequestResultRepository";
import { FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
import { QueueFixture, later } from "../fixtures/queue";
import { setupTelegram, update } from "../fixtures/telegram";

let f: QueueFixture;
beforeEach(() => {
  f = new QueueFixture();
});
afterEach(() => f.close());
function setup(provider = new FakeChatProvider(), allowed = ["123", "456"]) {
  const results = new SqliteRequestResultRepository(f.database);
  let clock = Date.parse(later);
  return {
    ...setupTelegram(f, provider, allowed, undefined, {
      results,
      now: () => new Date(clock).toISOString(),
    }),
    results,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("a durable delivery retry clears status failure, preserves original reply target and submits one provider prompt", async () => {
  const s = setup();
  s.provider.plan("r1", { kind: "success", text: "private answer" });
  let failed = false;
  s.api.sendFailure = (message) => {
    if (message.parseMode && !failed) {
      failed = true;
      return new Error("private lost reply");
    }
  };
  await s.requests.start();
  await s.bot.handle(update(1, "/use c1"));
  await s.bot.handle(update(2, "private prompt"));
  await s.requests.waitForIdle();
  await s.bot.handle(update(3, "/status"));
  expect(s.api.sent.at(-1)?.text).toContain("TELEGRAM_DELIVERY_FAILED: r1");
  await s.bot.handle(update(4, "/use other"));
  s.advance(1000);
  await s.bot.retryResults();
  expect(s.api.sent.at(-1)).toMatchObject({
    chatId: "123",
    replyTo: "102",
    text: "private answer",
  });
  await s.bot.handle(update(5, "/status"));
  expect(s.api.sent.at(-1)?.text).not.toContain("TELEGRAM_DELIVERY_FAILED");
  expect(s.provider.submissions).toHaveLength(1);
  expect(s.results.diagnostics()).toEqual([]);
  expect(s.logs.join("")).not.toContain("private");
  await s.requests.shutdown();
});

test("initial result and retry worker share one owned HTTP attempt and preserve progress order", async () => {
  const s = setup();
  s.provider.plan("r1", { kind: "success", text: "ordered answer" });
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const send = s.api.sendMessage.bind(s.api);
  s.api.sendMessage = async (message) => {
    await send(message);
    if (message.parseMode) {
      entered.resolve();
      await finish.promise;
    }
  };
  await s.requests.start();
  f.conversations.select("123", "c1");
  await s.bot.handle(update(1, "prompt"));
  await entered.promise;
  const retry = s.bot.retryResults();
  await Promise.resolve();
  expect(s.api.sent.filter((message) => message.parseMode)).toHaveLength(1);
  finish.resolve();
  await Promise.all([retry, s.requests.waitForIdle()]);
  expect(s.api.sent.map((message) => message.text)).toEqual([
    "В очереди [r1] · c1",
    "Генерация… [r1]",
    "ordered answer",
  ]);
  expect(
    s.logs.map((line) => JSON.parse(line)).filter((row) => row.operation === "telegram.delivered"),
  ).toHaveLength(1);
  await s.requests.shutdown();
});

test("after reopen delivery rechecks the allowlist, never replays completion and hides another user's error", async () => {
  const s = setup();
  s.api.sendFailure = (message) => (message.parseMode ? new Error("lost") : undefined);
  await s.requests.start();
  f.conversations.select("123", "c1");
  await s.bot.handle(update(1, "private prompt"));
  await s.requests.waitForIdle();
  await s.requests.shutdown();
  f.reopen();
  const next = setup(new FakeChatProvider(), ["456"]);
  next.advance(1000);
  await next.requests.start();
  await next.bot.retryResults();
  expect(next.api.sent).toHaveLength(0);
  expect(next.provider.sendCalls).toHaveLength(0);
  expect(next.results.diagnostics()[0].state).toBe("failed");
  await next.bot.handle(update(2, "/doctor", 456));
  expect(next.api.sent.at(-1)?.text).not.toContain("r1");
  expect(f.requests.get("r1")?.state).toBe("completed");
  await next.requests.shutdown();
});

test("expired response is purged on resumed worker and its persistent error is visible in doctor", async () => {
  const s = setup();
  s.api.sendFailure = (message) => (message.parseMode ? new Error("lost") : undefined);
  await s.requests.start();
  f.conversations.select("123", "c1");
  await s.bot.handle(update(1, "private prompt"));
  await s.requests.waitForIdle();
  s.advance(86400000);
  await s.bot.retryResults();
  s.api.sendFailure = undefined;
  await s.bot.handle(update(2, "/doctor"));
  expect(s.api.sent.at(-1)?.text).toContain("TELEGRAM_DELIVERY_EXPIRED");
  expect(s.api.sent.at(-1)?.text).toContain("[r1] delivery:expired");
  expect(f.database.query("SELECT result_payload,plan FROM request_deliveries").get()).toEqual({
    result_payload: null,
    plan: null,
  });
  expect(s.provider.sendCalls).toHaveLength(1);
  await s.requests.shutdown();
});

test("failure to persist the output leaves a safe running blocker and never delivers an unrecorded completion", async () => {
  const s = setup();
  f.database.run(
    "CREATE TRIGGER reject_output BEFORE INSERT ON request_deliveries BEGIN SELECT RAISE(ABORT,'private failure'); END",
  );
  await s.requests.start();
  f.conversations.select("123", "c1");
  await s.bot.handle(update(1, "private prompt"));
  await s.requests.waitForIdle();
  expect(f.requests.get("r1")?.state).toBe("running");
  expect(s.api.sent.filter((message) => message.parseMode)).toHaveLength(0);
  expect(s.requests.status().executionFailures).toEqual(["r1"]);
  expect(f.store.snapshot().blocked[0].requestId).toBe("r1");
  expect(s.provider.submissions).toHaveLength(1);
  await s.requests.shutdown();
});
