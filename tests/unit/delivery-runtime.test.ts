import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/Config";
import { createLogger } from "../../src/logging/logger";
import { privateChatPolicy } from "../../src/main";
import { openDatabase } from "../../src/persistence/sqlite/Database";
import { acquireGatewayLease } from "../../src/persistence/sqlite/GatewayLease";
import { SqliteRequestResultRepository } from "../../src/persistence/sqlite/SqliteRequestResultRepository";
import { FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
import { runGateway } from "../../src/runtime/GatewayRuntime";
import { QueueFixture, request } from "../fixtures/queue";
import { FakeTelegramApi, update } from "../fixtures/telegram";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tgwebgpt-r7-delivery-runtime-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function config(path = join(root, "gateway.sqlite")) {
  return loadConfig({
    TELEGRAM_BOT_TOKEN: "123456789:DELIVERY_FIXTURE_TOKEN",
    TELEGRAM_ALLOWED_USER_IDS: "123",
    DATABASE_PATH: path,
    BROWSER_PROFILE_DIR: join(root, "profile"),
    ATTACHMENT_TEMP_DIR: join(root, "files"),
  });
}
function polling(api: FakeTelegramApi) {
  let polls = 0;
  api.getUpdates = async (_offset, signal) => {
    if (++polls === 1)
      return [
        update(1, "/add coding remote"),
        update(2, "private prompt"),
        update(2, "private prompt"),
      ];
    return new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
}

test("runtime owns bounded delivery retries across polling without another provider submission", async () => {
  const api = new FakeTelegramApi(),
    provider = new FakeChatProvider();
  const controller = new AbortController();
  const logs: string[] = [];
  polling(api);
  let attempts = 0;
  api.sendFailure = (message) => {
    if (message.parseMode) {
      if (++attempts === 1) return new Error("private lost acknowledgement");
      controller.abort();
    }
  };
  await runGateway({
    config: config(),
    api,
    provider,
    providerLabel: "Fake",
    chatPolicy: privateChatPolicy,
    signal: controller.signal,
    log: createLogger({ sink: (line) => logs.push(line) }),
  });
  expect(attempts).toBe(2);
  expect(provider.submissions).toHaveLength(1);
  const database = openDatabase(config().database.path);
  try {
    expect(database.query("SELECT state FROM requests").all()).toEqual([{ state: "completed" }]);
    expect(
      database.query("SELECT state,attempts,result_payload,plan FROM request_deliveries").get(),
    ).toEqual({ state: "delivered", attempts: 2, result_payload: null, plan: null });
  } finally {
    database.close(true);
  }
  expect(logs.join("")).not.toContain("private");
  expect(logs.join("")).not.toContain("DELIVERY_FIXTURE_TOKEN");
  const records = logs.map((line) => JSON.parse(line));
  const requestId = records.find((row) => row.operation === "telegram.accepted").requestId;
  for (const operation of [
    "provider.send",
    "provider.submitted",
    "request.settled",
    "telegram.delivered",
  ])
    expect(
      records.some(
        (row) =>
          row.operation === operation &&
          row.requestId === requestId &&
          row.telegramUpdateId === "2",
      ),
    ).toBe(true);
}, 10000);

test("signal shutdown retains the process lease until an owned delivery attempt settles, then closes the provider", async () => {
  const api = new FakeTelegramApi();
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const events: string[] = [];
  const provider = Object.assign(new FakeChatProvider(), {
    close: async () => {
      events.push("provider.closed");
    },
  });
  polling(api);
  const send = api.sendMessage.bind(api);
  let attempts = 0;
  api.sendMessage = async (message) => {
    await send(message);
    if (message.parseMode) {
      if (++attempts === 1) throw new Error("lost");
      entered.resolve();
      await finish.promise;
      events.push("delivery.settled");
    }
  };
  const running = runGateway({
    config: config(),
    api,
    provider,
    providerLabel: "Fake",
    chatPolicy: privateChatPolicy,
    signal: controller.signal,
    log: createLogger({ sink: () => {} }),
  });
  await entered.promise;
  controller.abort();
  await Promise.resolve();
  expect(() => acquireGatewayLease(config().database.path)).toThrow("DATABASE_ERROR");
  expect(events).toEqual([]);
  finish.resolve();
  await running;
  expect(events).toEqual(["delivery.settled", "provider.closed"]);
  const release = acquireGatewayLease(config().database.path);
  release();
}, 10000);

test("startup purges expired output and status reports its durable delivery error without replay", async () => {
  const f = new QueueFixture();
  try {
    const at = new Date(Date.now() - 25 * 3600000).toISOString();
    f.store.accept({ ...request(), createdAt: at }, { text: "private prompt", attachments: [] }, 3);
    f.store.claim("r1", at);
    f.requests.transition("r1", { state: "running", at, providerRequestId: "old-provider-r1" });
    new SqliteRequestResultRepository(f.database).settle(
      "r1",
      { state: "completed", at },
      { message: { text: "private answer" } },
    );
    const api = new FakeTelegramApi(),
      provider = new FakeChatProvider();
    const controller = new AbortController();
    api.getUpdates = async () => [update(3, "/status")];
    api.sendFailure = () => {
      controller.abort();
    };
    await runGateway({
      config: config(f.path),
      api,
      provider,
      providerLabel: "Fake",
      chatPolicy: privateChatPolicy,
      signal: controller.signal,
      log: createLogger({ sink: () => {} }),
    });
    expect(api.sent.map((message) => message.text).join("\n")).toContain(
      "TELEGRAM_DELIVERY_EXPIRED",
    );
    expect(api.sent.filter((message) => message.parseMode)).toHaveLength(0);
    expect(provider.sendCalls).toHaveLength(0);
    f.reopen();
    expect(
      f.database.query("SELECT state,result_payload,plan FROM request_deliveries").get(),
    ).toEqual({ state: "expired", result_payload: null, plan: null });
    expect(f.requests.get("r1")?.state).toBe("completed");
  } finally {
    f.close();
  }
});
