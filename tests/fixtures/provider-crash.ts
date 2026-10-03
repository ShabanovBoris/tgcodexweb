import { RequestService } from "../../src/application/RequestService";
import { openDatabase } from "../../src/persistence/sqlite/Database";
import { SqliteRequestQueueRepository } from "../../src/persistence/sqlite/SqliteRequestQueueRepository";
import { SqliteRequestRepository } from "../../src/persistence/sqlite/SqliteRequestRepository";
import type {
  ProviderOutcome,
  ProviderSendInput,
  ProviderSubmission,
} from "../../src/ports/ChatProvider";
import { FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
import { later, request } from "./queue";

const [path, mode] = process.argv.slice(2);
const database = openDatabase(path);
// An open stdin keeps this process alive for the parent's SIGKILL, without timer sleeps.
async function interrupted(): Promise<never> {
  process.stdout.write("submitted:r1\n");
  await new Response(Bun.stdin.stream()).text();
  throw new Error("Unexpected crash-fixture continuation");
}
class CrashProvider extends FakeChatProvider {
  override async send(input: ProviderSendInput) {
    const result = await super.send(input);
    if (mode === "sending") return interrupted();
    return result;
  }
  override async awaitCompletion(
    _input: Readonly<{ submission: ProviderSubmission; signal: AbortSignal }>,
  ): Promise<ProviderOutcome> {
    return interrupted();
  }
}
const service = new RequestService({
  queueRepository: new SqliteRequestQueueRepository(database),
  requests: new SqliteRequestRepository(database),
  provider: new CrashProvider(),
  options: { maxPendingPerConversation: 3, generationTimeoutMs: 600000 },
  now: () => later,
  onResult: () => {},
});
await service.start();
service.accept(request(), { text: "synthetic crash input", attachments: [] });
service.accept(request("next", "2"), { text: "queued successor", attachments: [] });
await service.waitForIdle();
