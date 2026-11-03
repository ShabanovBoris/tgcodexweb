import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runManagedGateway } from "../../scripts/macos-service";
import { runCli } from "../../src/cli/index";
import { openDatabase } from "../../src/persistence/sqlite/Database";
import { migrateDatabase } from "../../src/persistence/sqlite/migrations";
import { SqliteConversationRepository } from "../../src/persistence/sqlite/SqliteConversationRepository";
import { SqliteRequestQueueRepository } from "../../src/persistence/sqlite/SqliteRequestQueueRepository";
import { SqliteRequestRepository } from "../../src/persistence/sqlite/SqliteRequestRepository";
import { TelegramError } from "../../src/transports/telegram/TelegramApi";
import { TelegramPolling } from "../../src/transports/telegram/TelegramPolling";
import { at, later, request } from "./queue";

const [directory, requestedMode] = process.argv.slice(2);
let mode = requestedMode;
if (mode === "launchd") {
  const marker = join(directory, "starts");
  const starts = existsSync(marker) ? Number(readFileSync(marker, "utf8")) : 0;
  writeFileSync(marker, String(starts + 1), { mode: 0o600 });
  mode = starts === 0 ? "temporary" : "running";
}
const env = {
  TELEGRAM_BOT_TOKEN: "123456789:SERVICE_SYNTHETIC_PRIVATE",
  TELEGRAM_ALLOWED_USER_IDS: "123",
};
if (mode === "temporary") {
  TelegramPolling.prototype.run = async () => {
    throw new TelegramError("TELEGRAM_UNAVAILABLE", 0);
  };
} else {
  globalThis.fetch = (async (url: string | URL | Request, input?: RequestInit) => {
    if (mode === "fatal") return Response.json({ ok: false, error_code: 401 }, { status: 401 });
    if (String(url).endsWith("/getMe"))
      return Response.json({ ok: true, result: { id: 777, is_bot: true, username: "fixture" } });
    if (!String(url).endsWith("/getUpdates")) throw new Error("unexpected fixture method");
    process.stdout.write("polling\n");
    return new Promise<Response>((_resolve, reject) => {
      const signal = input?.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
}
process.exitCode = await runManagedGateway(directory, env, (onFailure) => {
  if (mode === "running") {
    const database = openDatabase(join(directory, "data/fake-gateway.sqlite"));
    try {
      migrateDatabase(database);
      const requests = new SqliteRequestRepository(database);
      if (!requests.get("ambiguous")) {
        const mappings = new SqliteConversationRepository(database);
        mappings.putUser({ telegramUserId: "123", enabled: true, createdAt: at });
        mappings.create({
          id: "c1",
          alias: "fixture",
          providerConversationId: "remote",
          telegramUserId: "123",
          status: "ready",
          archived: false,
          createdAt: at,
          updatedAt: at,
        });
        mappings.select("123", "c1");
        const queue = new SqliteRequestQueueRepository(database);
        queue.accept(
          request("ambiguous", "1"),
          { text: "synthetic interrupted input", attachments: [] },
          5,
        );
        requests.transition("ambiguous", { state: "sending", at: later });
        requests.transition("ambiguous", { state: "unknown", at: later });
        queue.accept(
          request("successor", "2"),
          { text: "synthetic queued input", attachments: [] },
          5,
        );
      }
    } finally {
      database.close(true);
    }
  }
  return runCli(["start:fake", "--private"], env, directory, onFailure);
});
