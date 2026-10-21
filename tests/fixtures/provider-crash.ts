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
import { attachment, later, request } from "./queue";

const [path, mode] = process.argv.slice(2);
const database = openDatabase(path);
const requests = new SqliteRequestRepository(database);
// An open stdin keeps this process alive for the parent's SIGKILL, without timer sleeps.
async function interrupted(): Promise<never> {
  process.stdout.write(
    `${JSON.stringify({
      state: requests.get("r1")?.state,
      sendCalls: provider.sendCalls.length,
      submissions: provider.submissions.length,
    })}\n`,
  );
  await new Response(Bun.stdin.stream()).text();
  throw new Error("Unexpected crash-fixture continuation");
}
class CrashProvider extends FakeChatProvider {
  override async health() {
    // Execution checks health after the durable upload claim, before any provider mutation.
    if (mode === "uploading" && requests.get("r1")?.state === "uploading") return interrupted();
    return super.health();
  }
  override async send(input: ProviderSendInput) {
    if (mode === "pre_submit") return interrupted();
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
const provider = new CrashProvider();
const service = new RequestService({
  queueRepository: new SqliteRequestQueueRepository(database),
  requests,
  provider,
  options: { maxPendingPerConversation: 3, generationTimeoutMs: 600000 },
  now: () => later,
  onResult: () => {},
});
await service.start();
service.accept(request(), {
  text: "synthetic crash input",
  attachments: mode === "uploading" ? [attachment()] : [],
});
service.accept(request("next", "2"), { text: "queued successor", attachments: [] });
await service.waitForIdle();
