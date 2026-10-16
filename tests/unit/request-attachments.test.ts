import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import {
  AttachmentService,
  supportedAttachmentExtensions,
  supportedAttachmentMimeTypes,
} from "../../src/application/AttachmentService";
import { RequestService } from "../../src/application/RequestService";
import { SqliteAttachmentBatchRepository } from "../../src/persistence/sqlite/SqliteAttachmentBatchRepository";
import { FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
import { LocalAttachmentStore } from "../../src/storage/LocalAttachmentStore";
import { at, later, QueueFixture, request } from "../fixtures/queue";

let f: QueueFixture;
beforeEach(() => {
  f = new QueueFixture();
});
afterEach(() => f.close());
function setup(provider = new FakeChatProvider()) {
  const batches = new SqliteAttachmentBatchRepository(f.database);
  const store = new LocalAttachmentStore(join(f.root, "files"));
  const attachments = new AttachmentService(
    store,
    {
      maxFilesPerRequest: 2,
      maxFileSizeBytes: 64,
      allowedExtensions: supportedAttachmentExtensions,
      allowedMimeTypes: supportedAttachmentMimeTypes,
    },
    () => batches.retainedStorageKeys(),
  );
  const service = new RequestService({
    queueRepository: f.store,
    requests: f.requests,
    provider,
    attachments,
    now: () => later,
    options: { maxPendingPerConversation: 3, generationTimeoutMs: 60000 },
    onResult: () => {},
  });
  return { store, batches, attachments, service, provider };
}

test.each(["complete", "no_input", "no_acceptance", "neither"])(
  "interrupted upload %s respects ownership proof, UNKNOWN retention and never replays",
  async (mode) => {
    let t = setup();
    const prepared = await t.attachments.prepare(
      "r1",
      [{ sourceFileId: "source", filename: "a.ts" }],
      async function* () {
        yield new TextEncoder().encode("text");
      },
      at,
    );
    f.store.accept(request(), { attachments: prepared.attachments }, 3);
    prepared.release();
    f.store.claim("r1", later);
    const key = prepared.attachments[0].temporaryStorageKey as string;
    await utimes(join(f.root, "files", key), 1, 1);
    if (["no_input", "neither"].includes(mode)) f.database.run("DELETE FROM request_inputs");
    if (["no_acceptance", "neither"].includes(mode))
      f.database.run("DELETE FROM request_acceptances");
    f.reopen();
    t = setup();
    await t.service.start();
    await t.service.waitForIdle();
    expect(f.requests.get("r1")?.state).toBe("unknown");
    expect(t.provider.sendCalls).toEqual([]);
    await t.store.sweep(() => t.batches.retainedStorageKeys(), Date.now());
    expect(await readdir(join(f.root, "files"))).toEqual(mode === "neither" ? [key] : []);
    expect(f.updates.get("1")?.requestId).toBe("r1");
    await t.service.shutdown();
  },
);

test("ambiguous send removes R2 working bytes but keeps UNKNOWN and blocks successors, without another provider submission", async () => {
  const t = setup();
  const prepared = await t.attachments.prepare(
    "r1",
    [{ sourceFileId: "source", filename: "a.ts" }],
    async function* () {
      yield new TextEncoder().encode("text");
    },
    at,
  );
  t.provider.plan("r1", { kind: "ambiguous_submit" });
  await t.service.start();
  t.service.accept(request(), { attachments: prepared.attachments });
  prepared.release();
  t.service.accept(request("r2", "2"), { text: "next", attachments: [] });
  await t.service.waitForIdle();
  expect(f.requests.get("r1")?.state).toBe("unknown");
  expect(f.requests.get("r2")?.state).toBe("queued");
  expect(t.provider.submissions).toHaveLength(1);
  expect(await readdir(join(f.root, "files"))).toEqual([]);
  await t.service.shutdown();
});
