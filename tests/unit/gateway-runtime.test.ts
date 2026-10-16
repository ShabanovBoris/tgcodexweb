import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/Config";
import { createLogger } from "../../src/logging/logger";
import { startFakeGateway } from "../../src/main";
import { openDatabase } from "../../src/persistence/sqlite/Database";
import { SqliteConversationRepository } from "../../src/persistence/sqlite/SqliteConversationRepository";
import { SqliteRequestRepository } from "../../src/persistence/sqlite/SqliteRequestRepository";
import { FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
import { runGateway, type TelegramChatPolicy } from "../../src/runtime/GatewayRuntime";
import { TelegramError } from "../../src/transports/telegram/TelegramApi";
import { QueueFixture } from "../fixtures/queue";
import { FakeTelegramApi, update } from "../fixtures/telegram";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tgcodexweb-r4-runtime-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const privatePolicy: TelegramChatPolicy = {
  acceptsMessage: (message) =>
    message.chat.type === "private" && message.chat.id === message.from?.id,
  destination: (request, mappings) => {
    const mapping = mappings.get(request.conversationId);
    return mapping ? { chatId: mapping.telegramUserId, replyTo: request.telegramMessageId } : null;
  },
};
function config(path = join(root, "gateway.sqlite")) {
  return loadConfig({
    TELEGRAM_BOT_TOKEN: "123456789:R4_SYNTHETIC_TOKEN",
    TELEGRAM_ALLOWED_USER_IDS: "123",
    DATABASE_PATH: path,
  });
}

test("composition validates bot token before database effects/provider startup", async () => {
  const api = new FakeTelegramApi();
  api.getMe = async () => {
    throw new TelegramError("TELEGRAM_TOKEN_INVALID");
  };
  const provider = new FakeChatProvider();
  let health = 0;
  provider.health = async () => {
    health++;
    throw new Error("must not call");
  };
  await expect(
    runGateway({
      config: config(),
      api,
      provider,
      providerLabel: "Fake",
      chatPolicy: privatePolicy,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("TELEGRAM_TOKEN_INVALID");
  expect(health).toBe(0);
  expect(existsSync(config().database.path)).toBe(false);
});

test("composition runs a Telegram round trip, closes gracefully, and persists mapping/request/dedup", async () => {
  const api = new FakeTelegramApi();
  const provider = new FakeChatProvider();
  const controller = new AbortController();
  const logs: string[] = [];
  let polls = 0;
  api.getUpdates = async (_offset, signal) => {
    if (++polls === 1) return [update(1, "/add coding remote"), update(2, "synthetic prompt")];
    return new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  api.sendFailure = (message) => {
    if (message.parseMode === "HTML") controller.abort();
    return undefined;
  };
  await runGateway({
    config: config(),
    api,
    provider,
    providerLabel: "Fake",
    chatPolicy: privatePolicy,
    signal: controller.signal,
    log: createLogger({ sink: (line) => logs.push(line) }),
  });
  expect(provider.submissions).toHaveLength(1);
  expect(provider.submissions[0]).toMatchObject({
    conversationId: "remote",
    text: "synthetic prompt",
  });
  const database = openDatabase(config().database.path);
  try {
    expect(new SqliteConversationRepository(database).getActive("123")?.alias).toBe("coding");
    expect(new SqliteRequestRepository(database).findByUpdate("2")?.state).toBe("completed");
    expect(
      database
        .query("SELECT telegram_update_id FROM processed_updates ORDER BY telegram_update_id")
        .all(),
    ).toEqual([{ telegram_update_id: "1" }, { telegram_update_id: "2" }]);
    expect(database.query("SELECT * FROM request_inputs").all()).toEqual([]);
  } finally {
    database.close(true);
  }
  expect(api.sent.map((message) => message.text).join("\n")).not.toContain("synthetic prompt");
  expect(logs.join("")).not.toContain("synthetic prompt");
  expect(logs.join("")).not.toContain("R4_SYNTHETIC_TOKEN");
});

test("recovery rechecks allowlist: revoked queued work cannot submit and uncertain work stays blocked without inspection", async () => {
  const f = new QueueFixture();
  try {
    f.store.accept(
      {
        id: "revoked-queued",
        conversationId: "other",
        telegramUpdateId: "50",
        state: "created",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      { text: "synthetic queued", attachments: [] },
      3,
    );
    f.store.accept(
      {
        id: "revoked-running",
        conversationId: "c1",
        telegramUpdateId: "51",
        state: "created",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      { text: "synthetic running", attachments: [] },
      3,
    );
    f.store.claim("revoked-running", "2026-10-01T00:00:01.000Z");
    f.requests.transition("revoked-running", {
      state: "running",
      at: "2026-10-01T00:00:02.000Z",
      providerRequestId: "saved-id",
    });
    f.reopen();
    const api = new FakeTelegramApi();
    const provider = new FakeChatProvider();
    const controller = new AbortController();
    api.getUpdates = async () => {
      controller.abort();
      throw controller.signal.reason;
    };
    const values = loadConfig({
      TELEGRAM_BOT_TOKEN: "123456789:R4_SYNTHETIC_TOKEN",
      TELEGRAM_ALLOWED_USER_IDS: "456",
      DATABASE_PATH: f.path,
    });
    await runGateway({
      config: values,
      api,
      provider,
      providerLabel: "Fake",
      chatPolicy: privatePolicy,
      signal: controller.signal,
      log: createLogger({ sink: () => {} }),
    });
    f.reopen();
    expect(provider.sendCalls).toEqual([]);
    expect(provider.inspections).toEqual([]);
    expect(api.sent).toEqual([]);
    expect(f.requests.get("revoked-running")?.state).toBe("running");
    expect(f.requests.get("revoked-queued")?.state).toBe("failed");
    expect(f.store.snapshot().blocked.map((block) => block.requestId)).toContain("revoked-running");
  } finally {
    f.close();
  }
});

test("explicit fake entry point uses separate metadata and preserves archive identity across restarts", async () => {
  const original = new QueueFixture();
  try {
    const env = {
      TELEGRAM_BOT_TOKEN: "123456789:R4_SYNTHETIC_TOKEN",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      DATABASE_PATH: original.path,
      LOG_LEVEL: "error",
    };
    const run = async (messages: ReturnType<typeof update>[]) => {
      const api = new FakeTelegramApi();
      const controller = new AbortController();
      let polls = 0;
      api.getUpdates = async () => {
        if (++polls === 1) return messages;
        controller.abort();
        throw controller.signal.reason;
      };
      await startFakeGateway(env, controller.signal, root, api);
      return api;
    };
    await run([update(1, "/new synthetic")]);
    const fakePath = join(original.root, "fake-gateway.sqlite");
    const database = openDatabase(fakePath);
    const mappings = new SqliteConversationRepository(database);
    const old = mappings.getActive("123");
    database.close(true);
    await run([update(2, "/remove synthetic"), update(3, "/new synthetic")]);
    const reopened = openDatabase(fakePath);
    try {
      const mappings = new SqliteConversationRepository(reopened);
      expect(mappings.getActive("123")?.providerConversationId).not.toBe(
        old?.providerConversationId,
      );
      expect(mappings.get(old?.id ?? "")).toMatchObject({
        archived: true,
        providerConversationId: old?.providerConversationId,
      });
    } finally {
      reopened.close(true);
    }
    original.reopen();
    expect(original.conversations.list("123").map((chat) => chat.alias)).toEqual([
      "alias",
      "c1",
      "other",
    ]);
    expect(original.updates.get("1")).toBeNull();
  } finally {
    original.close();
  }
});
