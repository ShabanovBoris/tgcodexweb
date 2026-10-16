import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AttachmentError, type AttachmentStore } from "../ports/AttachmentStore";

const keyPattern = /^att_[0-9a-f]{32}$/;

export class LocalAttachmentStore implements AttachmentStore {
  private readonly writing = new Set<string>();
  private readonly root: string;
  private canonicalRoot: string | undefined;

  constructor(directory: string) {
    this.root = resolve(directory);
  }

  async initialize(): Promise<void> {
    try {
      await this.path(`att_${"0".repeat(32)}`);
    } catch {
      throw new AttachmentError("ATTACHMENT_STORAGE_FAILED");
    }
  }

  private async path(key: string): Promise<string> {
    if (!keyPattern.test(key)) throw new AttachmentError("ATTACHMENT_UNAVAILABLE");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    const canonical = await realpath(this.root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (this.canonicalRoot && canonical !== this.canonicalRoot)
    )
      throw new AttachmentError("ATTACHMENT_STORAGE_FAILED");
    this.canonicalRoot = canonical;
    return join(canonical, key);
  }

  async put(
    bytes: AsyncIterable<Uint8Array>,
    maxBytes: number,
  ): Promise<{ key: string; sizeBytes: number; release: () => void }> {
    const key = `att_${crypto.randomUUID().replaceAll("-", "")}`;
    this.writing.add(key);
    let path: string | undefined;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let saved = false;
    let owned = false;
    try {
      path = await this.path(key);
      file = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      owned = true;
      let sizeBytes = 0;
      for await (const chunk of bytes) {
        sizeBytes += chunk.byteLength;
        if (sizeBytes > maxBytes) throw new AttachmentError("ATTACHMENT_TOO_LARGE");
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await file.write(chunk, offset, chunk.byteLength - offset);
          if (!result.bytesWritten) throw new AttachmentError("ATTACHMENT_STORAGE_FAILED");
          offset += result.bytesWritten;
        }
      }
      await file.sync();
      const directory = await open(
        this.canonicalRoot as string,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      await file.close();
      file = undefined;
      saved = true;
      return { key, sizeBytes, release: () => this.writing.delete(key) };
    } catch (error) {
      if (path && owned) await unlink(path).catch(() => {});
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError("ATTACHMENT_STORAGE_FAILED");
    } finally {
      await file?.close().catch(() => {});
      if (!saved) this.writing.delete(key);
    }
  }

  async *read(key: string): AsyncIterable<Uint8Array> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(await this.path(key), constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!(await file.stat()).isFile()) throw new AttachmentError("ATTACHMENT_UNAVAILABLE");
      const buffer = new Uint8Array(65536);
      for (;;) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        yield buffer.slice(0, bytesRead);
      }
    } catch {
      throw new AttachmentError("ATTACHMENT_UNAVAILABLE");
    } finally {
      await file?.close().catch(() => {});
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await unlink(await this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new AttachmentError("ATTACHMENT_STORAGE_FAILED");
    }
  }

  async sweep(retained: () => ReadonlySet<string>, olderThan: number): Promise<void> {
    try {
      // Validate the root before enumerating; only this store's generated names are candidates.
      await this.path(`att_${"0".repeat(32)}`);
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.isFile() || !keyPattern.test(entry.name)) continue;
        const info = await lstat(join(this.root, entry.name));
        if (info.mtimeMs >= olderThan || this.writing.has(entry.name) || retained().has(entry.name))
          continue;
        await this.remove(entry.name);
      }
    } catch {
      throw new AttachmentError("ATTACHMENT_STORAGE_FAILED");
    }
  }
}
