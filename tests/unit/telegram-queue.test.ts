import { afterEach, beforeEach, expect, test } from "bun:test";
import { QueueFixture, later, request } from "../fixtures/queue";
import { setupTelegram, update } from "../fixtures/telegram";
import { FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";

let f: QueueFixture;
beforeEach(() => {
  f = new QueueFixture();
});
afterEach(() => f.close());

test("queue commands clear the selected mapping or all owned pending work without provider effects", async () => {
  f.store.accept(request("block", "10"), { text: "block", attachments: [] }, 10);
  f.store.claim("block", later);
  f.requests.transition("block", { state: "unknown", at: later });
  f.store.accept(request("wait", "11"), { text: "secret prompt", attachments: [] }, 10);
  f.store.accept(
    request("other-wait", "12", "other"),
    { text: "other secret", attachments: [] },
    10,
  );
  const s = setupTelegram(
    f,
    new FakeChatProvider({
      capabilities: { maxConcurrentConversations: 1, fileUpload: true, cancellation: false },
    }),
  );
  await s.requests.start();
  f.conversations.select("123", "c1");
  await s.bot.handle(update(20, "/queue"));
  expect(s.api.sent.at(-1)?.text).toContain("[wait]");
  expect(s.api.sent.at(-1)?.text).toContain("other-wait");
  expect(s.api.sent.at(-1)?.text).not.toContain("secret");
  await s.bot.handle(update(21, "/clearqueue"));
  expect(s.api.sent.at(-1)?.text).toContain("1");
  expect(f.requests.get("wait")?.failureCode).toBe("QUEUE_CLEARED");
  expect(f.requests.get("other-wait")?.state).toBe("queued");
  await s.bot.handle(update(22, "/clearqueue everyone"));
  expect(s.api.sent.at(-1)?.text).toContain("INVALID_COMMAND");
  await s.bot.handle(update(23, "/clearqueue all", 999));
  expect(f.requests.get("other-wait")?.state).toBe("queued");
  await s.bot.handle(update(24, "/clearqueue all"));
  expect(f.requests.get("other-wait")?.failureCode).toBe("QUEUE_CLEARED");
  f.store.accept(request("new-wait", "13"), { text: "new", attachments: [] }, 10);
  await s.bot.handle(update(24, "/clearqueue all"));
  expect(f.requests.get("new-wait")?.state).toBe("queued");
  expect(f.requests.get("block")?.state).toBe("unknown");
  expect(s.provider.sendCalls).toEqual([]);
  await s.requests.shutdown();
});
