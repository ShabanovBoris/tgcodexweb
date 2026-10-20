import { afterEach, beforeEach, expect, test } from "bun:test";
import { SqliteUnknownRecoveryRepository } from "../../src/persistence/sqlite/SqliteUnknownRecoveryRepository";
import { FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
import { QueueFixture, later } from "../fixtures/queue";
import { setupTelegram, update } from "../fixtures/telegram";

let f: QueueFixture;
beforeEach(() => {
  f = new QueueFixture();
});
afterEach(() => f.close());

test("AC-J04 /doctor reports component readiness and capabilities without provider mutations", async () => {
  const { bot, requests, provider, api } = setupTelegram(f);
  await requests.start();
  provider.createConversation = async () => {
    throw new Error("doctor must not create");
  };
  provider.inspectConversation = async () => {
    throw new Error("doctor must not inspect conversations");
  };
  await bot.handle(update(1, "/doctor"));
  expect(api.sent.at(-1)?.text).toContain("Fake · READY");
  expect(api.sent.at(-1)?.text).toContain("БД: ready");
  expect(api.sent.at(-1)?.text).toContain("Telegram: ready");
  expect(api.sent.at(-1)?.text).toContain("Очередь: running");
  expect(api.sent.at(-1)?.text).toContain("Параллельных чатов: 2");
  expect(provider.sendCalls).toHaveLength(0);
  expect(provider.cancelCalls).toHaveLength(0);
  expect(provider.inspections).toHaveLength(0);
  expect(f.requests.listUnfinished()).toHaveLength(0);
  await bot.handle(update(2, "/doctor extra"));
  expect(api.sent.at(-1)?.text).toContain("INVALID_COMMAND");
  await requests.shutdown();
});

test("UNKNOWN guidance survives restart; exact operator release removes the diagnostic block without replay", async () => {
  const first = setupTelegram(f);
  first.provider.plan("r1", { kind: "ambiguous_submit" });
  await first.requests.start();
  f.conversations.select("123", "c1");
  await first.bot.handle(update(1, "private prompt"));
  await first.requests.waitForIdle();
  expect(first.api.sent.at(-1)?.text).toContain("recover:unknown");
  expect(first.api.sent.at(-1)?.text).toContain("--confirm-completed");
  await first.requests.shutdown();
  f.reopen();
  const restarted = setupTelegram(f, first.provider);
  await restarted.requests.start();
  await restarted.bot.handle(update(2, "/doctor"));
  expect(restarted.api.sent.at(-1)?.text).toContain("DEGRADED");
  expect(restarted.api.sent.at(-1)?.text).toContain("[r1] unknown");
  expect(restarted.api.sent.at(-1)?.text).toContain("reconciliation_required");
  expect(restarted.api.sent.at(-1)?.text).toContain("проверьте завершение именно этого запроса");
  expect(restarted.api.sent.at(-1)?.text).not.toContain("private prompt");
  await restarted.requests.shutdown();
  new SqliteUnknownRecoveryRepository(f.database).confirmCompleted("r1", later);
  const recovered = setupTelegram(f, first.provider);
  await recovered.requests.start();
  await recovered.bot.handle(update(3, "/doctor"));
  expect(recovered.api.sent.at(-1)?.text).toContain("Fake · READY");
  expect(recovered.api.sent.at(-1)?.text).not.toContain("[r1]");
  expect(first.provider.sendCalls).toHaveLength(1);
  expect(f.requests.get("r1")?.state).toBe("unknown");
  await recovered.requests.shutdown();
});

test("diagnostics contain only the caller's request IDs even when another user's UNKNOWN reserves capacity", async () => {
  f.conversations.putUser({ telegramUserId: "456", enabled: true, createdAt: later });
  f.conversations.create({
    id: "foreign",
    alias: "private-alias",
    providerConversationId: "remote",
    telegramUserId: "456",
    status: "ready",
    archived: false,
    createdAt: later,
    updatedAt: later,
  });
  f.requests.create({
    id: "foreign-request",
    conversationId: "foreign",
    telegramUpdateId: "50",
    state: "created",
    createdAt: later,
  });
  f.requests.transition("foreign-request", { state: "queued", at: later });
  f.requests.transition("foreign-request", { state: "sending", at: later });
  f.requests.transition("foreign-request", { state: "unknown", at: later });
  const { bot, requests, api } = setupTelegram(f);
  await requests.start();
  await bot.handle(update(1, "/doctor"));
  expect(api.sent.at(-1)?.text).toContain("DEGRADED");
  expect(api.sent.at(-1)?.text).not.toContain("foreign-request");
  expect(api.sent.at(-1)?.text).not.toContain("private-alias");
  expect(api.sent.at(-1)?.text).not.toContain("recover:unknown");
  await requests.shutdown();
});

test("database read failures produce explicit ERROR diagnostics without killing ingress or exposing raw details", async () => {
  const { bot, requests, api } = setupTelegram(f);
  await requests.start();
  const snapshot = f.store.snapshot;
  f.store.snapshot = () => {
    throw new Error("private SQL /path/token details");
  };
  await expect(bot.handle(update(1, "/doctor"))).resolves.toBeUndefined();
  expect(api.sent.at(-1)?.text).toContain("ERROR");
  expect(api.sent.at(-1)?.text).toContain("DATABASE_ERROR");
  expect(api.sent.at(-1)?.text).not.toContain("private");
  f.store.snapshot = snapshot;
  await bot.handle(update(2, "/status"));
  expect(api.sent.at(-1)?.text).toContain("Fake · READY");
  await requests.shutdown();
});

test("doctor is authorization guarded before provider health, including a foreign bot mention", async () => {
  const { bot, requests, api, provider } = setupTelegram(f);
  await requests.start();
  let health = 0;
  provider.health = async () => {
    health++;
    return { state: "ready", observedAt: later };
  };
  await bot.handle(update(1, "/doctor", 999));
  await bot.handle(update(2, "/doctor@other_bot"));
  expect(health).toBe(0);
  expect(api.sent).toHaveLength(0);
  await requests.shutdown();
});

test("AUTH_REQUIRED remains distinguishable during a transport outage", async () => {
  const { bot, requests, provider, api, setReady } = setupTelegram(f, new FakeChatProvider());
  await requests.start();
  provider.setHealth("auth_required");
  setReady(false);
  await bot.handle(update(1, "/status"));
  expect(api.sent.at(-1)?.text).toContain("AUTH_REQUIRED");
  expect(api.sent.at(-1)?.text).toContain("Telegram: unavailable");
  await requests.shutdown();
});
