import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdir, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AttachmentService,
  supportedAttachmentExtensions,
  supportedAttachmentMimeTypes,
} from "../../src/application/AttachmentService";
import { SqliteAttachmentBatchRepository } from "../../src/persistence/sqlite/SqliteAttachmentBatchRepository";
import { FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
import { LocalAttachmentStore } from "../../src/storage/LocalAttachmentStore";
import type { TelegramUpdate } from "../../src/transports/telegram/TelegramApi";
import { TelegramPolling } from "../../src/transports/telegram/TelegramPolling";
import { later, QueueFixture } from "../fixtures/queue";
import { setupTelegram, update } from "../fixtures/telegram";

let f: QueueFixture;
beforeEach(() => {
  f = new QueueFixture();
  f.conversations.select("123", "c1");
});
afterEach(() => f.close());
const options = {
  maxFilesPerRequest: 2,
  maxFileSizeBytes: 64,
  allowedExtensions: supportedAttachmentExtensions,
  allowedMimeTypes: supportedAttachmentMimeTypes,
};
function setup(provider?: FakeChatProvider) {
  const batches = new SqliteAttachmentBatchRepository(f.database);
  const store = new LocalAttachmentStore(join(f.root, "files"));
  const attachments = new AttachmentService(store, options, () => batches.retainedStorageKeys());
  const result = setupTelegram(
    f,
    provider ?? new FakeChatProvider({ attachmentStore: store }),
    ["123"],
    attachments,
  );
  const downloads: string[] = [];
  const contents = new Map<string, Uint8Array>();
  result.api.downloadFile = async function* (id) {
    downloads.push(id);
    yield contents.get(id) ?? new TextEncoder().encode("const x = 1;");
  };
  return { ...result, store, attachments, batches, downloads, contents };
}
function fileUpdate(id: number, group?: string, caption?: string) {
  const input = update(id, "");
  const message = input.message as NonNullable<TelegramUpdate["message"]> & {
    from: { id: number; is_bot: boolean };
  };
  delete message.text;
  message.document = {
    file_id: `file-${id}`,
    file_name: "../../source.ts",
    mime_type: "text/plain",
  };
  if (group) message.media_group_id = group;
  if (caption !== undefined) message.caption = caption;
  return { ...input, message };
}

test("AC-G01/B03 single source bytes enter one existing provider path; caption remains exact text even when it is a command", async () => {
  const t = setup();
  await t.requests.start();
  const input = fileUpdate(1, undefined, "/new should stay text\n");
  await Promise.all([t.bot.handle(input), t.bot.handle(input)]);
  await t.requests.waitForIdle();
  expect(t.provider.submissions).toHaveLength(1);
  expect(t.provider.submissions[0]).toMatchObject({
    text: "/new should stay text\n",
    conversationId: "remote",
    attachments: [{ filename: "../../source.ts", sizeBytes: 12 }],
  });
  expect(t.downloads).toEqual(["file-1"]);
  expect(t.provider.uploadedAttachments[0]).toMatchObject({
    sizeBytes: 12,
    sha256: new Bun.CryptoHasher("sha256").update("const x = 1;").digest("hex"),
  });
  expect(f.requests.findByUpdate("1")?.state).toBe("completed");
  expect(await readdir(join(f.root, "files"))).toEqual([]);
  const denied = fileUpdate(2);
  denied.message.from.id = 999;
  await t.bot.handle(denied);
  expect(t.downloads).toEqual(["file-1"]);
  expect(f.updates.get("2")).toBeNull();
  expect(f.conversations.getUser("999")).toBeNull();
  expect(t.logs.join("")).not.toContain("should stay text");
  await t.requests.shutdown();
});

test("AC-G02/G03 PDF, photo's largest size and PNG document preserve metadata and bytes", async () => {
  const t = setup();
  await t.requests.start();
  const pdf = fileUpdate(1);
  pdf.message.document = { file_id: "pdf", file_name: "paper.pdf", mime_type: "application/pdf" };
  t.contents.set("pdf", new TextEncoder().encode("%PDF-1.7\nfixture"));
  await t.bot.handle(pdf);
  const photo = fileUpdate(2);
  delete photo.message.document;
  photo.message.photo = [
    { file_id: "small", width: 2, height: 2 },
    { file_id: "large", width: 20, height: 20 },
    { file_id: "middle", width: 10, height: 10 },
  ];
  t.contents.set("large", new Uint8Array([255, 216, 255, 1]));
  await t.bot.handle(photo);
  const png = fileUpdate(3);
  png.message.document = { file_id: "png", file_name: "image.png", mime_type: "image/png" };
  t.contents.set("png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  await t.bot.handle(png);
  await t.requests.waitForIdle();
  expect(t.downloads).toEqual(["pdf", "large", "png"]);
  expect(t.provider.submissions.map((input) => input.attachments[0].mimeType)).toEqual([
    "application/pdf",
    "image/jpeg",
    "image/png",
  ]);
  expect(await readdir(join(f.root, "files"))).toEqual([]);
  await t.requests.shutdown();
});

test("album waits for explicit /send, binds first conversation and atomically preserves ordered captions/update identities across restart", async () => {
  let t = setup();
  await t.requests.start();
  await t.bot.handle(fileUpdate(2, "album", "second"));
  await t.bot.handle(update(3, "/use other"));
  await t.bot.handle(fileUpdate(1, "album", "/new first"));
  expect(t.provider.submissions).toEqual([]);
  expect(t.batches.getOpen("123")?.conversationId).toBe("c1");
  await t.requests.shutdown();
  f.reopen();
  t = setup();
  await t.requests.start();
  expect(t.batches.items("r1").map((item) => item.updateId)).toEqual(["1", "2"]);
  await t.bot.handle(update(4, "/send"));
  await t.requests.waitForIdle();
  await t.bot.handle(update(4, "/send"));
  await t.bot.handle(update(5, "/send"));
  await t.bot.handle(fileUpdate(6, "album", "late"));
  expect(t.downloads).toEqual([]);
  expect(t.provider.submissions).toHaveLength(1);
  expect(t.provider.submissions[0]).toMatchObject({
    clientRequestId: "r1",
    conversationId: "remote",
    text: "/new first\nsecond",
  });
  expect(t.provider.submissions[0].attachments.map((file) => file.storageKey)).toHaveLength(2);
  for (const id of ["1", "2", "4"]) expect(f.updates.get(id)?.requestId).toBe("r1");
  expect(t.batches.items("r1")).toEqual([]);
  expect(t.batches.getGroup("123", "123", "album")?.state).toBe("closed");
  expect(await readdir(join(f.root, "files"))).toEqual([]);
  await t.requests.shutdown();
});

test("AC-G04/G05 metadata and actual size rejection, per-album limit and another open album prevent extra downloads/submissions", async () => {
  const t = setup();
  await t.requests.start();
  const declared = fileUpdate(1);
  declared.message.document = { file_id: "large", file_name: "a.ts", file_size: 65 };
  await t.bot.handle(declared);
  t.contents.set("file-2", new Uint8Array(65));
  await t.bot.handle(fileUpdate(2));
  await t.bot.handle(fileUpdate(3, "a"));
  await t.bot.handle(fileUpdate(4, "a"));
  await t.bot.handle(fileUpdate(5, "a"));
  await t.bot.handle(fileUpdate(6, "b"));
  expect(t.downloads).toEqual(["file-2", "file-3", "file-4"]);
  expect(t.api.sent.map((entry) => entry.text).join("\n")).toContain("TOO_MANY_ATTACHMENTS");
  expect(t.provider.submissions).toEqual([]);
  expect(t.batches.items(t.batches.getOpen("123")?.id as string)).toHaveLength(2);
  await t.bot.handle(update(7, "/discard"));
  expect(t.batches.getOpen("123")).toBeNull();
  expect(await readdir(join(f.root, "files"))).toEqual([]);
  await t.requests.shutdown();
});

test("TTL expires unaccepted drafts and closed groups never restart; accepted queued files survive age and restart", async () => {
  let t = setup();
  await t.requests.start();
  await t.bot.handle(fileUpdate(1, "expired"));
  t.batches.expire("2026-10-03T00:00:00.000Z");
  await t.store.sweep(() => t.batches.retainedStorageKeys(), Date.now() + 10000);
  expect(await readdir(join(f.root, "files"))).toEqual([]);
  await t.bot.handle(fileUpdate(2, "expired"));
  expect(t.downloads).toHaveLength(1);
  await t.requests.shutdown();
  const prepared = await t.attachments.prepare(
    "queued",
    [{ sourceFileId: "queued", filename: "queued.ts" }],
    async function* () {
      yield new TextEncoder().encode("queued");
    },
    later,
  );
  f.store.accept(
    {
      id: "queued",
      conversationId: "c1",
      telegramUpdateId: "10",
      state: "created",
      createdAt: later,
    },
    { attachments: prepared.attachments },
    3,
  );
  prepared.release();
  const key = prepared.attachments[0].temporaryStorageKey as string;
  await utimes(join(f.root, "files", key), 1, 1);
  await t.store.sweep(() => t.batches.retainedStorageKeys(), Date.now());
  expect((await readdir(join(f.root, "files"))).includes(key)).toBe(true);
  f.reopen();
  t = setup();
  await t.requests.start();
  await t.requests.waitForIdle();
  expect(f.requests.get("queued")?.state).toBe("completed");
  expect(t.provider.submissions).toHaveLength(1);
  expect(await readdir(join(f.root, "files"))).toEqual([]);
  await t.requests.shutdown();
});

test("album expiry during an asynchronous next-file download is handled and polling continues", async () => {
  const t = setup();
  await t.requests.start();
  await t.bot.handle(fileUpdate(1, "expiring"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.api.downloadFile = async function* () {
    entered.resolve();
    await release.promise;
    yield new TextEncoder().encode("text");
  };
  const offsets: (number | undefined)[] = [];
  const controller = new AbortController();
  t.api.getUpdates = async (offset) => {
    offsets.push(offset);
    if (offsets.length === 1) return [fileUpdate(2, "expiring")];
    if (offsets.length === 2) return [update(3, "next prompt")];
    await t.requests.waitForIdle();
    controller.abort();
    return [];
  };
  const polling = new TelegramPolling({
    api: t.api,
    initialize: async () => {},
    handle: (input) => t.bot.handle(input),
    shutdown: () => t.requests.shutdown(),
  });
  const operation = polling.run(controller.signal).then(
    () => ({ handled: true }),
    (error: unknown) => ({ handled: false, error }),
  );
  await entered.promise;
  t.batches.expire("2026-10-03T00:00:00.000Z");
  expect(t.provider.submissions).toEqual([]);
  expect(polling.ready()).toBe(true);
  release.resolve();
  expect(await operation).toEqual({ handled: true });
  expect(offsets).toEqual([undefined, 3, 4]);
  expect(t.batches.getOpen("123")).toBeNull();
  expect(t.batches.getGroup("123", "123", "expiring")?.state).toBe("closed");
  expect(f.updates.get("2")).not.toBeNull();
  expect(f.updates.get("2")?.requestId).toBeUndefined();
  expect(f.requests.findByUpdate("2")).toBeNull();
  expect(t.api.sent.map((message) => message.text).join("\n")).toContain("ATTACHMENT_REJECTED");
  expect((await readdir(join(f.root, "files"))).length).toBe(1);
  await t.store.sweep(() => t.batches.retainedStorageKeys(), Date.now() + 10000);
  expect(await readdir(join(f.root, "files"))).toEqual([]);
  expect(t.provider.submissions).toHaveLength(1);
  expect(t.provider.submissions[0].text).toBe("next prompt");
  expect(f.requests.findByUpdate("3")?.state).toBe("completed");
});

test("missing/tampered queued bytes fail before provider.send; cleanup/delivery failure never reclassify provider completion", async () => {
  const t = setup();
  for (const variant of ["missing", "tampered"]) {
    const prepared = await t.attachments.prepare(
      variant,
      [{ sourceFileId: variant, filename: "a.ts" }],
      async function* () {
        yield new TextEncoder().encode("text");
      },
      later,
    );
    f.store.accept(
      {
        id: variant,
        conversationId: "c1",
        telegramUpdateId: variant === "missing" ? "10" : "11",
        state: "created",
        createdAt: later,
      },
      { attachments: prepared.attachments },
      3,
    );
    prepared.release();
    const path = join(f.root, "files", prepared.attachments[0].temporaryStorageKey as string);
    if (variant === "missing") await unlink(path);
    else await writeFile(path, "text\0");
  }
  await t.requests.start();
  await t.requests.waitForIdle();
  expect(t.provider.sendCalls).toEqual([]);
  expect(f.requests.get("missing")?.state).toBe("failed");
  expect(f.requests.get("tampered")?.state).toBe("failed");
  t.store.remove = async () => {
    throw new Error("fixture cleanup failure");
  };
  t.api.sendFailure = (message) =>
    message.parseMode ? new Error("fixture delivery failure") : undefined;
  await t.bot.handle(fileUpdate(1));
  await t.requests.waitForIdle();
  expect(f.requests.findByUpdate("1")?.state).toBe("completed");
  expect(t.requests.status().cleanupFailures).toHaveLength(1);
  expect(t.requests.status().deliveryFailures).toHaveLength(1);
  expect(t.provider.submissions).toHaveLength(1);
  await t.requests.shutdown();
});
