import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { lstat, mkdtemp, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttachmentService,
  supportedAttachmentExtensions,
  supportedAttachmentMimeTypes,
} from "../../src/application/AttachmentService";
import { LocalAttachmentStore } from "../../src/storage/LocalAttachmentStore";

let root: string;
let store: LocalAttachmentStore;
let service: AttachmentService;
const options = {
  maxFilesPerRequest: 2,
  maxFileSizeBytes: 64,
  allowedExtensions: supportedAttachmentExtensions,
  allowedMimeTypes: supportedAttachmentMimeTypes,
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tgcodexweb-r5-files-"));
  store = new LocalAttachmentStore(join(root, "files"));
  service = new AttachmentService(store, options);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function* bytes(...parts: (string | Uint8Array)[]) {
  for (const part of parts) yield typeof part === "string" ? new TextEncoder().encode(part) : part;
}
const metadata = (filename = "source.ts", mimeType = "text/plain") => ({
  sourceFileId: "synthetic",
  filename,
  mimeType,
});
const at = "2026-10-16T00:00:00.000Z";

test("AC-G01..03 actual source/PDF/image bytes are validated, stored privately and readable by generated key", async () => {
  for (const [filename, mime, content] of [
    ["main.ts", "text/plain", "export const x = 1;"],
    ["paper.pdf", "application/pdf", "%PDF-1.7\nfixture"],
    ["image.gif", "image/gif", "GIF89afixture"],
  ]) {
    const result = await service.prepare(
      "r1",
      [metadata(filename, mime)],
      () => bytes(content),
      at,
    );
    const file = result.attachments[0];
    expect(file.filename).toBe(filename);
    expect(file.temporaryStorageKey).toMatch(/^att_[a-f0-9]{32}$/);
    expect(
      (await lstat(join(root, "files", file.temporaryStorageKey as string))).mode & 0o777,
    ).toBe(0o600);
    await service.validateForSend(result.attachments);
    result.release();
    expect(await service.cleanup(result.attachments)).toBe(true);
  }
  expect(await readdir(join(root, "files"))).toEqual([]);
});

test("AC-G04/G05 declared and streamed size/count limits reject before send and cancel oversized streams", async () => {
  let downloads = 0;
  const download = () => {
    downloads++;
    return bytes("x");
  };
  await expect(
    service.prepare("r", [{ ...metadata(), sizeBytes: 65 }], download, at),
  ).rejects.toThrow("ATTACHMENT_TOO_LARGE");
  await expect(
    service.prepare("r", [metadata(), metadata(), metadata()], download, at),
  ).rejects.toThrow("TOO_MANY_ATTACHMENTS");
  expect(downloads).toBe(0);
  let ended = false;
  async function* large() {
    try {
      yield new Uint8Array(65);
      throw new Error("must stop reading");
    } finally {
      ended = true;
    }
  }
  await expect(service.prepare("r", [metadata()], large, at)).rejects.toThrow(
    "ATTACHMENT_TOO_LARGE",
  );
  expect(ended).toBe(true);
  expect(await readdir(join(root, "files"))).toEqual([]);
});

test("AC-G06 traversal filename is display metadata; unsafe storage keys, root/file symlinks cannot read outside", async () => {
  const result = await service.prepare(
    "r",
    [metadata("../../outside.ts")],
    () => bytes("text"),
    at,
  );
  expect(result.attachments[0].filename).toBe("../../outside.ts");
  await expect(Array.fromAsync(store.read("../../outside"))).rejects.toThrow(
    "ATTACHMENT_UNAVAILABLE",
  );
  const outside = join(root, "outside");
  await writeFile(outside, "private");
  const key = `att_${"a".repeat(32)}`;
  await symlink(outside, join(root, "files", key));
  await expect(Array.fromAsync(store.read(key))).rejects.toThrow("ATTACHMENT_UNAVAILABLE");
  await symlink(join(root, "files"), join(root, "linked"));
  await expect(new LocalAttachmentStore(join(root, "linked")).put(bytes("x"), 64)).rejects.toThrow(
    "ATTACHMENT_STORAGE_FAILED",
  );
  result.release();
});

test("type policy rejects extension/MIME disagreement, ZIP without capability, binary disguised as source, false magic and truncation", async () => {
  for (const [filename, mime, content] of [
    ["a.zip", "application/zip", "PK"],
    ["a.ts", "image/png", "text"],
    ["a.ts", "text/plain", "text\0bad"],
    ["a.pdf", "application/pdf", "text"],
    ["a.png", "image/png", "short"],
  ])
    await expect(
      service.prepare("r", [metadata(filename, mime)], () => bytes(content), at),
    ).rejects.toThrow("ATTACHMENT_REJECTED");
  await expect(
    service.prepare("r", [metadata()], () => bytes(new Uint8Array([255])), at),
  ).rejects.toThrow("ATTACHMENT_REJECTED");
  await expect(
    service.prepare("r", [{ ...metadata(), sizeBytes: 5 }], () => bytes("1234"), at),
  ).rejects.toThrow("ATTACHMENT_REJECTED");
  expect(await readdir(join(root, "files"))).toEqual([]);
});

test("AC-G07 TTL protects leases/durable refs and removes only aged owned regular files", async () => {
  const result = await service.prepare("r", [metadata()], () => bytes("text"), at);
  const key = result.attachments[0].temporaryStorageKey as string;
  const path = join(root, "files", key);
  await utimes(path, 1, 1);
  await writeFile(join(root, "files", "unrelated"), "not ours");
  await store.sweep(() => new Set(), Date.now());
  expect((await readdir(join(root, "files"))).includes(key)).toBe(true);
  result.release();
  await store.sweep(() => new Set([key]), Date.now());
  expect((await readdir(join(root, "files"))).includes(key)).toBe(true);
  await store.sweep(() => new Set(), Date.now());
  expect(await readdir(join(root, "files"))).toEqual(["unrelated"]);
});

test("failed multi-file preparation removes earlier files without discarding the actual error", async () => {
  await expect(
    service.prepare(
      "r",
      [metadata(), metadata("bad.pdf", "application/pdf")],
      (file) => bytes(file.filename === "bad.pdf" ? "bad" : "good"),
      at,
    ),
  ).rejects.toThrow("ATTACHMENT_REJECTED");
  expect(await readdir(join(root, "files"))).toEqual([]);
});
