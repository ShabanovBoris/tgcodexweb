import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, readdirSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/Config";
import { createLogger } from "../../src/logging/logger";
import { startFakeGateway } from "../../src/main";
import { openDatabase } from "../../src/persistence/sqlite/Database";
import { acquireGatewayLease } from "../../src/persistence/sqlite/GatewayLease";
import { SqliteConversationRepository } from "../../src/persistence/sqlite/SqliteConversationRepository";
import { SqliteRequestRepository } from "../../src/persistence/sqlite/SqliteRequestRepository";
import { FakeBarrier, FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
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
    ATTACHMENT_TEMP_DIR: join(root, "files"),
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

test("transient getMe recovery precedes database effects and initializes one provider for one prompt", async () => {
  const api = new FakeTelegramApi(),
    provider = new FakeChatProvider();
  const controller = new AbortController();
  const logs: string[] = [];
  let identities = 0,
    factories = 0,
    polls = 0;
  api.getMe = async () => {
    expect(existsSync(config().database.path)).toBe(false);
    expect(factories).toBe(0);
    if (++identities === 1)
      throw new TelegramError("TELEGRAM_UNAVAILABLE", undefined, undefined, 0);
    return { id: 777, username: "test_bot" };
  };
  api.getUpdates = async (_offset, signal) => {
    if (++polls === 1) return [update(1, "/add coding remote"), update(2, "private prompt")];
    return new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  api.sendFailure = (message) => {
    if (message.parseMode) controller.abort();
  };
  await runGateway({
    config: config(),
    api,
    provider: () => {
      factories++;
      return provider;
    },
    providerLabel: "Fake",
    chatPolicy: privatePolicy,
    signal: controller.signal,
    log: createLogger({ sink: (line) => logs.push(line) }),
  });
  expect({ identities, factories }).toEqual({ identities: 2, factories: 1 });
  expect(provider.submissions).toHaveLength(1);
  expect(logs.map((line) => JSON.parse(line).operation)).toContain("telegram.identity_recovered");
  expect(logs.join("")).not.toContain("private prompt");
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

test("runtime excludes maintenance and another runtime until provider disposal finishes", async () => {
  const controller = new AbortController();
  const polling = new FakeBarrier(),
    closing = new FakeBarrier(),
    finishClose = new FakeBarrier();
  let closes = 0,
    factories = 0;
  const provider = Object.assign(new FakeChatProvider(), {
    close: async () => {
      closes++;
      closing.release();
      await finishClose.promise;
    },
  });
  const api = new FakeTelegramApi();
  api.getUpdates = async (_offset, signal) => {
    polling.release();
    return new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const running = runGateway({
    config: config(),
    api,
    provider,
    providerLabel: "Fake",
    chatPolicy: privatePolicy,
    signal: controller.signal,
    log: createLogger({ sink: () => {} }),
  });
  try {
    await polling.promise;
    expect(() => acquireGatewayLease(config().database.path)).toThrow("DATABASE_ERROR");
    await expect(
      runGateway({
        config: config(),
        api: new FakeTelegramApi(),
        provider: () => {
          factories++;
          return new FakeChatProvider();
        },
        providerLabel: "Fake",
        chatPolicy: privatePolicy,
        signal: new AbortController().signal,
        log: createLogger({ sink: () => {} }),
      }),
    ).rejects.toThrow("DATABASE_ERROR");
    expect(factories).toBe(0);
    controller.abort();
    await closing.promise;
    expect(() => acquireGatewayLease(config().database.path)).toThrow("DATABASE_ERROR");
    finishClose.release();
    await running;
    expect(closes).toBe(1);
    acquireGatewayLease(config().database.path)();
  } finally {
    controller.abort();
    finishClose.release();
    await running;
  }
});

test.each(["completed", "unknown", "delivery_failed"] as const)(
  "R7 reconnect/redelivery preserves one durable request and provider prompt: %s",
  async (outcome) => {
    const api = new FakeTelegramApi();
    const provider = new FakeChatProvider();
    const controller = new AbortController();
    const entered = new FakeBarrier(),
      delivered = new FakeBarrier();
    const logs: string[] = [];
    const offsets: (number | undefined)[] = [];
    let factories = 0,
      identities = 0,
      deliveries = 0,
      activePolls = 0,
      maximumPolls = 0;
    let requestId = "";
    const send = provider.send.bind(provider),
      completion = provider.awaitCompletion.bind(provider);
    provider.send = async (input) => {
      requestId = input.clientRequestId;
      provider.plan(requestId, { kind: outcome === "unknown" ? "ambiguous_submit" : "slow" });
      return send(input);
    };
    provider.awaitCompletion = async (input) => {
      entered.release();
      return completion(input);
    };
    api.getMe = async () => {
      identities++;
      return { id: 777, username: "r4_bot" };
    };
    api.sendFailure = (message) => {
      if (message.parseMode) {
        deliveries++;
        if (outcome === "unknown") entered.release();
        delivered.release();
        if (outcome === "delivery_failed") return new TelegramError("TELEGRAM_DELIVERY_FAILED");
      }
      return undefined;
    };
    api.getUpdates = async (offset, signal) => {
      offsets.push(offset);
      maximumPolls = Math.max(maximumPolls, ++activePolls);
      try {
        if (offsets.length === 1)
          return [update(1, "/add coding remote"), update(2, "R7 private prompt")];
        if (offsets.length === 2) {
          await entered.promise;
          const failure = new TelegramError("TELEGRAM_UNAVAILABLE", 0);
          failure.message =
            "private network details https://api.telegram.org/bot123:R7_SYNTHETIC/getUpdates";
          throw failure;
        }
        if (offsets.length === 3) {
          const database = openDatabase(config().database.path);
          try {
            expect(new SqliteRequestRepository(database).findByUpdate("2")?.state).toBe(
              outcome === "unknown" ? "unknown" : "running",
            );
          } finally {
            database.close(true);
          }
          expect(factories).toBe(1);
          expect(provider.sendCalls).toHaveLength(1);
          return [update(2, "R7 private prompt")];
        }
        if (outcome !== "unknown") provider.complete(requestId, "R7 synthetic answer");
        await delivered.promise;
        controller.abort();
        throw signal.reason;
      } finally {
        activePolls--;
      }
    };
    await runGateway({
      config: config(),
      api,
      provider: () => {
        factories++;
        return provider;
      },
      providerLabel: "Fake",
      chatPolicy: privatePolicy,
      signal: controller.signal,
      log: createLogger({ sink: (line) => logs.push(line) }),
    });
    expect(offsets).toEqual([undefined, 3, 3, 3]);
    expect({ factories, identities, maximumPolls, deliveries }).toEqual({
      factories: 1,
      identities: 1,
      maximumPolls: 1,
      deliveries: 1,
    });
    expect(provider.sendCalls).toHaveLength(1);
    expect(provider.submissions).toHaveLength(1);
    expect(provider.inspections).toEqual([]);
    const database = openDatabase(config().database.path);
    try {
      expect(database.query("SELECT state FROM requests").all()).toEqual([
        { state: outcome === "unknown" ? "unknown" : "completed" },
      ]);
      expect(
        database
          .query("SELECT request_id FROM processed_updates WHERE telegram_update_id = '2'")
          .get(),
      ).toEqual({ request_id: requestId });
      expect(database.query("SELECT * FROM request_inputs").all()).toEqual([]);
    } finally {
      database.close(true);
    }
    expect(logs.some((line) => JSON.parse(line).operation === "telegram.poll_recovered")).toBe(
      true,
    );
    expect(logs.some((line) => JSON.parse(line).operation === "telegram.delivery_failed")).toBe(
      outcome === "delivery_failed",
    );
    for (const privateValue of [
      "R7 private prompt",
      "R7 synthetic answer",
      "R7_SYNTHETIC",
      "api.telegram.org",
      "private network details",
    ])
      expect(logs.join("")).not.toContain(privateValue);
  },
);

test("R5 runtime passes actual files to the fake adapter and joins cleanup before closing SQLite", async () => {
  const api = new FakeTelegramApi();
  const controller = new AbortController();
  let polls = 0;
  const file = update(2, "");
  if (file.message) {
    delete file.message.text;
    file.message.document = { file_id: "source", file_name: "source.ts", mime_type: "text/plain" };
    file.message.caption = "review";
  }
  api.downloadFile = async function* () {
    yield new TextEncoder().encode("const x = 1;");
  };
  api.getUpdates = async (_offset, signal) => {
    if (++polls === 1) return [update(1, "/add coding remote"), file];
    return new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  api.sendFailure = (message) => {
    if (message.parseMode) controller.abort();
    return undefined;
  };
  let provider: FakeChatProvider | undefined;
  await runGateway({
    config: config(),
    api,
    provider: (_mappings, attachmentStore) => {
      provider = new FakeChatProvider({ attachmentStore });
      return provider;
    },
    providerLabel: "Fake",
    chatPolicy: privatePolicy,
    signal: controller.signal,
    log: createLogger({ sink: () => {} }),
  });
  expect(provider?.uploadedAttachments[0]).toMatchObject({
    sizeBytes: 12,
    sha256: new Bun.CryptoHasher("sha256").update("const x = 1;").digest("hex"),
  });
  expect(provider?.submissions).toHaveLength(1);
  expect(readdirSync(config().attachments.tempDir)).toEqual([]);
});

test("R5 startup rejects a symlink attachment root before polling/provider startup", async () => {
  const configured = config();
  const target = join(root, "outside");
  mkdirSync(target);
  symlinkSync(target, configured.attachments.tempDir);
  let polls = 0,
    health = 0;
  const api = new FakeTelegramApi();
  api.getUpdates = async () => {
    polls++;
    return [];
  };
  const provider = new FakeChatProvider();
  provider.health = async () => {
    health++;
    throw new Error("must not run");
  };
  await expect(
    runGateway({
      config: configured,
      api,
      provider,
      providerLabel: "Fake",
      chatPolicy: privatePolicy,
      signal: new AbortController().signal,
      log: createLogger({ sink: () => {} }),
    }),
  ).rejects.toThrow("ATTACHMENT_STORAGE_FAILED");
  expect({ polls, health }).toEqual({ polls: 0, health: 0 });
  expect(readdirSync(target)).toEqual([]);
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
