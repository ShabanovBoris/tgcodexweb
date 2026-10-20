import { afterEach, beforeEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { RequestService } from "../../src/application/RequestService";
import { acquireGatewayLease } from "../../src/persistence/sqlite/GatewayLease";
import { SqliteRequestResultRepository } from "../../src/persistence/sqlite/SqliteRequestResultRepository";
import { FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
import { TelegramResultDelivery } from "../../src/transports/telegram/TelegramResultDelivery";
import { QueueFixture, later } from "../fixtures/queue";
import { FakeTelegramApi } from "../fixtures/telegram";

let f: QueueFixture;
beforeEach(() => {
  f = new QueueFixture();
});
afterEach(() => f.close());

test.each(["settled", "telegram_accepted"] as const)(
  "SIGKILL after %s resumes only Telegram delivery and never the provider prompt",
  async (mode) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "../fixtures/delivery-crash.ts"),
        f.path,
        mode,
      ],
      { env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(`${mode}:1\n`);
      child.kill("SIGKILL");
      await child.exited;
      reader.releaseLock();
      expect(await new Response(child.stderr).text()).toBe("");
      f.reopen();
      const release = acquireGatewayLease(f.path);
      try {
        const original = f.requests.get("r1");
        expect(original?.state).toBe("completed");
        const results = new SqliteRequestResultRepository(f.database);
        expect(results.diagnostics()[0]).toMatchObject({
          state: "pending",
          attempts: mode === "settled" ? 0 : 1,
          nextChunk: 0,
        });
        const provider = new FakeChatProvider();
        const service = new RequestService({
          queueRepository: f.store,
          requests: f.requests,
          results,
          provider,
          options: { maxPendingPerConversation: 3, generationTimeoutMs: 600000 },
          now: () => later,
          onResult: () => {
            throw new Error("no core replay");
          },
        });
        await service.start();
        await service.waitForIdle();
        const api = new FakeTelegramApi();
        const delivery = new TelegramResultDelivery({
          repository: results,
          api,
          destination: () => ({ chatId: "123", replyTo: "101" }),
          now: () => later,
        });
        expect(await delivery.deliver("r1")).toBe(true);
        expect(api.sent).toHaveLength(1);
        expect(api.sent[0].text).toBe("private durable answer");
        expect(provider.sendCalls).toEqual([]);
        expect(provider.inspections).toEqual([]);
        expect(f.requests.get("r1")).toEqual(original);
        expect(f.updates.get("1")?.requestId).toBe("r1");
        expect(results.diagnostics()).toEqual([]);
        expect(
          f.database.query("SELECT result_payload,plan FROM request_deliveries").get(),
        ).toEqual({ result_payload: null, plan: null });
        await service.shutdown();
      } finally {
        release();
      }
    } finally {
      child.kill();
      await child.exited;
    }
  },
);
