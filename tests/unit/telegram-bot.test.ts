import { afterEach, beforeEach, expect, test } from "bun:test";
import { FakeBarrier, FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
import { TelegramError } from "../../src/transports/telegram/TelegramApi";
import { QueueFixture } from "../fixtures/queue";
import { setupTelegram, update } from "../fixtures/telegram";

let f: QueueFixture;
beforeEach(() => {
  f = new QueueFixture();
});
afterEach(() => f.close());

test("AC-B01 /start responds with readiness and all required commands", async () => {
  const { bot, requests, api } = setupTelegram(f);
  await requests.start();
  await bot.handle(update(1, "/start"));
  expect(api.sent[0].text).toContain("Fake · READY");
  expect(api.sent[0].text).toContain("/add");
  expect(api.sent[0].text).toContain("/stop");
  expect(f.updates.get("1")?.requestId).toBeUndefined();
  expect(f.requests.findByUpdate("1")).toBeNull();
  await requests.shutdown();
});

test("AC-B02/B03 denied text/commands/attachments and ambiguous senders have zero privileged effects", async () => {
  const { bot, provider, api } = setupTelegram(f);
  let health = 0,
    creations = 0,
    inspections = 0;
  provider.health = async () => {
    health++;
    throw new Error("must not run");
  };
  provider.createConversation = async () => {
    creations++;
    throw new Error("must not run");
  };
  provider.inspectConversation = async () => {
    inspections++;
    throw new Error("must not run");
  };
  for (const text of ["/start", "/help", "/new", "/add alias remote", "/stop", "/status", "prompt"])
    await bot.handle(update(1, text, 999));
  const attachment = update(2, "caption", 999);
  if (attachment.message)
    attachment.message.document = { file_id: "not-downloaded", file_size: 9999999 };
  await bot.handle(attachment);
  const group = update(3, "/new");
  if (group.message) group.message.chat = { id: -123, type: "group" };
  await bot.handle(group);
  const mismatched = update(4, "/new");
  if (mismatched.message) mismatched.message.chat.id = 456;
  await bot.handle(mismatched);
  const anonymous = update(5, "/new");
  if (anonymous.message) anonymous.message.sender_chat = { id: 123 };
  await bot.handle(anonymous);
  const robot = update(6, "/new");
  if (robot.message?.from) robot.message.from.is_bot = true;
  await bot.handle(robot);
  expect({ health, creations, inspections }).toEqual({ health: 0, creations: 0, inspections: 0 });
  expect(provider.submissions).toEqual([]);
  expect(api.sent).toEqual([]);
  expect(f.database.query("SELECT * FROM processed_updates").all()).toEqual([]);
  expect(f.conversations.getUser("999")).toBeNull();
});

test("AC-C01..09 command routing, duplicate commands, ownership and archive/reuse", async () => {
  const { bot, requests, provider, api } = setupTelegram(f);
  await requests.start();
  await Promise.all([bot.handle(update(1, "/new coding")), bot.handle(update(1, "/new coding"))]);
  expect(f.conversations.getActive("123")?.alias).toBe("coding");
  expect(f.conversations.list("123").filter((chat) => chat.alias === "coding")).toHaveLength(1);
  await bot.handle(update(2, "/new coding"));
  expect(api.sent.at(-1)?.text).toBe("ALIAS_EXISTS");
  await bot.handle(update(3, "/new"));
  expect(f.conversations.getActive("123")?.alias).toBe("chat-1");
  await bot.handle(update(4, "/add research remote"));
  await bot.handle(update(5, "/add denied unavailable"));
  expect(f.conversations.findByAlias("123", "denied")).toBeNull();
  const old = f.conversations.getActive("123");
  await bot.handle(update(6, "/rename research renamed"));
  await bot.handle(update(7, "/current"));
  expect(api.sent.at(-1)?.text).toBe("renamed · ready");
  expect(f.conversations.getActive("123")?.providerConversationId).toBe("remote");
  await bot.handle(update(8, "/chats"));
  expect(api.sent.at(-1)?.text.match(/renamed/g)).toHaveLength(1);
  expect(api.sent.at(-1)?.text).toContain("→ renamed");
  await bot.handle(update(9, "/add foreign Remote", 456));
  for (const [id, text] of [
    [10, "/use foreign"],
    [11, "/rename foreign stolen"],
    [12, "/remove foreign"],
  ] as const) {
    await bot.handle(update(id, text));
    expect(api.sent.at(-1)?.text).toBe("CHAT_NOT_FOUND");
  }
  expect(f.conversations.getActive("456")?.alias).toBe("foreign");
  await bot.handle(update(13, "/remove renamed"));
  await bot.handle(update(14, "/add renamed Remote"));
  expect(f.conversations.getActive("123")?.id).not.toBe(old?.id);
  expect(f.conversations.get(old?.id ?? "")).toMatchObject({
    archived: true,
    providerConversationId: "remote",
  });
  expect(provider.submissions).toEqual([]);
  await requests.shutdown();
});

test("AC-D01/D02/E01 exact ordinary text and replies target selection once with ordered progress", async () => {
  const { bot, requests, provider, api, logs } = setupTelegram(f);
  provider.plan("r1", { kind: "success", text: "4" });
  await requests.start();
  await bot.handle(update(1, "/use c1"));
  const prompt = update(2, "  2+2?\n");
  await Promise.all([bot.handle(prompt), bot.handle(prompt)]);
  await requests.waitForIdle();
  expect(provider.submissions).toEqual([
    { conversationId: "remote", clientRequestId: "r1", text: "  2+2?\n", attachments: [] },
  ]);
  expect(api.sent.slice(1).map((message) => message.text)).toEqual([
    "В очереди [r1] · c1",
    "Генерация… [r1]",
    "4",
  ]);
  expect(api.sent.at(-1)).toMatchObject({ chatId: "123", replyTo: "102" });
  await bot.handle(update(3, "/use other"));
  // The HTTP projection removes reply_to_message; the provider receives only the selected next prompt.
  await bot.handle(update(4, "reply prompt"));
  await requests.waitForIdle();
  expect(provider.submissions[1].conversationId).toBe("Remote");
  expect(logs.join("")).not.toContain("2+2?");
  expect(
    logs
      .map((line) => JSON.parse(line))
      .some(
        (record) =>
          record.operation === "telegram.delivered" &&
          record.requestId === "r1" &&
          record.telegramUpdateId === "2",
      ),
  ).toBe(true);
  await requests.shutdown();
});

test("missing selection, invalid commands, foreign bot commands and media never submit", async () => {
  const { bot, requests, provider, api } = setupTelegram(f);
  await requests.start();
  await bot.handle(update(1, "ordinary"));
  expect(api.sent.at(-1)?.text).toContain("NO_ACTIVE_CHAT");
  await bot.handle(update(2, "/new extra args"));
  expect(api.sent.at(-1)?.text).toContain("INVALID_COMMAND");
  await bot.handle(update(3, "/new@foreign_bot alias"));
  expect(f.updates.get("3")).toBeNull();
  const media = update(4, "/new caption");
  if (media.message) media.message.document = { file_id: "fixture" };
  await bot.handle(media);
  expect(api.sent.at(-1)?.text).toContain("ATTACHMENT_REJECTED");
  expect(f.conversations.list("123")).toHaveLength(3);
  expect(provider.sendCalls).toEqual([]);
  await requests.shutdown();
});

test("AC-I01/I02/I03 rich parse fallback retries only rejected chunk and never resubmits provider", async () => {
  const { bot, requests, provider, api } = setupTelegram(f);
  const answer = `\`\`\`ts\n${"x < 5 && 😀\n".repeat(1500)}\`\`\``;
  provider.plan("r1", { kind: "success", text: answer });
  let rejected = false;
  api.sendFailure = (message) => {
    if (message.parseMode === "HTML" && !rejected) {
      rejected = true;
      return new TelegramError("TELEGRAM_PARSE_ERROR");
    }
    return undefined;
  };
  await requests.start();
  await bot.handle(update(1, "/use c1"));
  await bot.handle(update(2, "synthetic"));
  await requests.waitForIdle();
  const delivered = api.sent.slice(3).filter((_, index) => index !== 0);
  const decode = (text: string) =>
    text
      .replace(/<\/?pre>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  expect(
    delivered.map((message) => (message.parseMode ? decode(message.text) : message.text)).join(""),
  ).toBe(answer);
  expect(provider.submissions).toHaveLength(1);
  expect(requests.status().deliveryFailures).toEqual([]);
  await requests.shutdown();
});

test("AC-D04 delivery/progress failures preserve durable completion and dedup without prompt retry", async () => {
  const { bot, requests, provider, api } = setupTelegram(f);
  api.sendFailure = () => new Error("private transport exception");
  await requests.start();
  f.conversations.select("123", "c1");
  await bot.handle(update(2, "synthetic"));
  await requests.waitForIdle();
  expect(f.requests.get("r1")?.state).toBe("completed");
  expect(requests.status().deliveryFailures).toEqual(["r1"]);
  await bot.handle(update(2, "synthetic"));
  expect(provider.submissions).toHaveLength(1);
  api.sendFailure = undefined;
  await bot.handle(update(3, "/status"));
  expect(api.sent.at(-1)?.text).toContain("TELEGRAM_DELIVERY_FAILED: r1");
  await requests.shutdown();
});

test("AC-J02/J03 /status health is read-only and distinguishes auth/provider/transport failure", async () => {
  const { bot, requests, provider, api, setReady } = setupTelegram(f);
  await requests.start();
  provider.setHealth("auth_required");
  await bot.handle(update(1, "/status"));
  expect(api.sent.at(-1)?.text).toContain("AUTH_REQUIRED");
  provider.setHealth("unavailable");
  await bot.handle(update(2, "/status"));
  expect(api.sent.at(-1)?.text).toContain("PROVIDER_UNAVAILABLE");
  provider.setHealth("ready");
  setReady(false);
  await bot.handle(update(3, "/status"));
  expect(api.sent.at(-1)?.text).toContain("DEGRADED");
  expect(provider.sendCalls).toEqual([]);
  expect(provider.inspections).toEqual([]);
  await requests.shutdown();
});

test("command marker precedes remote create and is durable even if the operation fails ambiguously", async () => {
  class ThrowingProvider extends FakeChatProvider {
    calls = 0;
    override async createConversation(): Promise<never> {
      this.calls++;
      throw new Error("private upstream exception");
    }
  }
  const provider = new ThrowingProvider();
  const { bot, requests, api } = setupTelegram(f, provider);
  await requests.start();
  await bot.handle(update(1, "/new"));
  expect(api.sent.at(-1)?.text).toBe("PROVIDER_UNAVAILABLE");
  await requests.shutdown();
  f.reopen();
  const restarted = setupTelegram(f, provider);
  await restarted.requests.start();
  await restarted.bot.handle(update(1, "/new"));
  expect(provider.calls).toBe(1);
  expect(restarted.api.sent).toEqual([]);
  await restarted.requests.shutdown();
});

test("AC-E02..05 transport preserves FIFO, alias convergence and independent parallel conversations", async () => {
  const { bot, requests, provider } = setupTelegram(f);
  provider.plan("r1", { kind: "slow" });
  await requests.start();
  await bot.handle(update(1, "/use c1"));
  await bot.handle(update(2, "first"));
  await provider.waiting("r1");
  await bot.handle(update(3, "/use alias"));
  await bot.handle(update(4, "second"));
  await bot.handle(update(5, "third"));
  await bot.handle(update(6, "/use other"));
  await bot.handle(update(7, "independent"));
  await provider.waiting("r4");
  expect(provider.submissions.map((input) => input.clientRequestId)).toEqual(["r1", "r4"]);
  expect(f.requests.get("r2")?.state).toBe("queued");
  provider.complete("r1", "finished");
  await requests.waitForIdle();
  expect(provider.submissions.map((input) => input.clientRequestId)).toEqual([
    "r1",
    "r4",
    "r2",
    "r3",
  ]);
  expect(provider.maximumActive.get("remote")).toBe(1);
  await requests.shutdown();
});

test("AC-H01..03 /stop targets selected canonical alias, dedups stop and preserves successors", async () => {
  const { bot, requests, provider, api } = setupTelegram(f);
  const gate = new FakeBarrier();
  provider.plan("r1", { kind: "cancellation_success", cancelGate: gate });
  await requests.start();
  await bot.handle(update(1, "/use c1"));
  await bot.handle(update(2, "/stop"));
  expect(api.sent.at(-1)?.text).toBe("Нет активной генерации.");
  await bot.handle(update(3, "first"));
  await provider.waiting("r1");
  await bot.handle(update(4, "successor"));
  await bot.handle(update(5, "/use alias"));
  await bot.handle(update(6, "/stop"));
  expect(api.sent.at(-1)?.text).toBe("Остановка запрошена.");
  await bot.handle(update(6, "/stop"));
  await bot.handle(update(7, "/stop"));
  expect(api.sent.at(-1)?.text).toBe("Остановка уже запрошена.");
  expect(provider.cancelCalls).toEqual(["r1"]);
  expect(f.requests.get("r2")?.state).toBe("queued");
  gate.release();
  await requests.waitForIdle();
  expect(f.requests.get("r1")?.state).toBe("cancelled");
  expect(f.requests.get("r2")?.state).toBe("completed");
  await requests.shutdown();
});

test("UNKNOWN is visible after restart and duplicate text remains suppressed", async () => {
  const { bot, requests, provider } = setupTelegram(f);
  provider.plan("r1", { kind: "ambiguous_submit" });
  await requests.start();
  f.conversations.select("123", "c1");
  await bot.handle(update(1, "synthetic"));
  await requests.waitForIdle();
  await requests.shutdown();
  f.reopen();
  const restarted = setupTelegram(f, provider);
  await restarted.requests.start();
  await restarted.bot.handle(update(2, "/status"));
  expect(restarted.api.sent.at(-1)?.text).toContain("DEGRADED");
  expect(restarted.api.sent.at(-1)?.text).toContain("[r1] unknown");
  await restarted.bot.handle(update(1, "synthetic"));
  expect(provider.sendCalls).toHaveLength(1);
  await restarted.requests.shutdown();
});

test("safe queued input recovers to the original user/message after reopen, independent of current selection", async () => {
  f.conversations.select("123", "other");
  f.store.accept(
    {
      id: "recovered",
      conversationId: "c1",
      telegramUpdateId: "50",
      telegramMessageId: "150",
      state: "created",
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    { text: "synthetic queued", attachments: [] },
    3,
  );
  f.reopen();
  const { bot, requests, provider, api } = setupTelegram(f);
  await requests.start();
  await requests.waitForIdle();
  expect(provider.submissions).toMatchObject([
    { conversationId: "remote", clientRequestId: "recovered", text: "synthetic queued" },
  ]);
  expect(api.sent.at(-1)).toMatchObject({ chatId: "123", replyTo: "150", parseMode: "HTML" });
  await bot.handle(update(50, "synthetic queued"));
  expect(provider.submissions).toHaveLength(1);
  expect(f.conversations.getActive("123")?.alias).toBe("other");
  await requests.shutdown();
});

test("queue full leaves the rejected update unmarked and cannot disturb accepted FIFO", async () => {
  const { bot, requests, provider, api } = setupTelegram(f);
  provider.plan("r1", { kind: "slow" });
  await requests.start();
  f.conversations.select("123", "c1");
  await bot.handle(update(1, "active"));
  await provider.waiting("r1");
  for (const id of [2, 3, 4]) await bot.handle(update(id, "queued"));
  await bot.handle(update(5, "rejected"));
  expect(api.sent.at(-1)?.text).toBe("QUEUE_FULL");
  expect(f.updates.get("5")).toBeNull();
  expect(f.requests.findByUpdate("5")).toBeNull();
  provider.complete("r1", "done");
  await requests.waitForIdle();
  expect(provider.submissions).toHaveLength(4);
  await requests.shutdown();
});
