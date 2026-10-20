import { RequestService } from "../../src/application/RequestService";
import { openDatabase } from "../../src/persistence/sqlite/Database";
import { acquireGatewayLease } from "../../src/persistence/sqlite/GatewayLease";
import { SqliteRequestQueueRepository } from "../../src/persistence/sqlite/SqliteRequestQueueRepository";
import { SqliteRequestRepository } from "../../src/persistence/sqlite/SqliteRequestRepository";
import { SqliteRequestResultRepository } from "../../src/persistence/sqlite/SqliteRequestResultRepository";
import { FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
import { TelegramResultDelivery } from "../../src/transports/telegram/TelegramResultDelivery";
import { later, request } from "./queue";

const [path, mode] = process.argv.slice(2);
const release = acquireGatewayLease(path);
const database = openDatabase(path);
const results = new SqliteRequestResultRepository(database);
const provider = new FakeChatProvider();
provider.plan("r1", { kind: "success", text: "private durable answer" });
async function hold(stage: string): Promise<never> {
  process.stdout.write(`${stage}:${provider.submissions.length}\n`);
  await new Response(Bun.stdin.stream()).text();
  throw new Error("Unexpected fixture continuation");
}
const delivery = new TelegramResultDelivery({
  repository: results,
  api: { sendMessage: async () => hold("telegram_accepted") },
  destination: () => ({ chatId: "123" }),
  now: () => later,
});
const service = new RequestService({
  queueRepository: new SqliteRequestQueueRepository(database),
  requests: new SqliteRequestRepository(database),
  results,
  provider,
  options: { maxPendingPerConversation: 3, generationTimeoutMs: 600000 },
  now: () => later,
  onResult: async (result) => {
    if (mode === "settled") await hold("settled");
    else await delivery.deliver(result.request.id);
  },
});
try {
  await service.start();
  service.accept(request(), { text: "private prompt", attachments: [] });
  await service.waitForIdle();
} finally {
  await service.shutdown();
  database.close(true);
  release();
}
