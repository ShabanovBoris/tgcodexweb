import { extname } from "node:path";
import { z } from "zod";
import type { Attachment } from "../domain/Attachment";
import { AttachmentError, type AttachmentStore } from "../ports/AttachmentStore";

const textExtensions =
  "txt md markdown csv tsv json jsonl yaml yml xml html css js jsx mjs cjs ts tsx py java kt kts c h cpp hpp cs go rs rb php sh bash sql swift scala r toml ini cfg log".split(
    " ",
  );
const mimeByExtension: Readonly<Record<string, string>> = {
  ...Object.fromEntries(textExtensions.map((extension) => [extension, "text/plain"])),
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
export const supportedAttachmentExtensions = Object.keys(mimeByExtension);
export const supportedAttachmentMimeTypes = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "text/javascript",
  "application/javascript",
  "application/json",
  "application/xml",
  "text/xml",
  "text/html",
  "text/css",
  "application/x-yaml",
  "application/yaml",
  "text/yaml",
  "application/x-sh",
  "text/x-python",
  "text/x-java-source",
  "text/x-c",
  "text/x-c++src",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];
export type IncomingAttachment = Readonly<{
  sourceFileId: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
}>;
export type AttachmentOptions = Readonly<{
  maxFilesPerRequest: number;
  maxFileSizeBytes: number;
  allowedExtensions: readonly string[];
  allowedMimeTypes: readonly string[];
}>;
export type PreparedAttachments = Readonly<{
  attachments: readonly Attachment[];
  release: () => void;
}>;

export class AttachmentService {
  constructor(
    readonly store: AttachmentStore,
    readonly options: AttachmentOptions,
    private readonly retained?: () => ReadonlySet<string>,
  ) {
    const limit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
    limit.parse(options.maxFilesPerRequest);
    limit.parse(options.maxFileSizeBytes);
  }

  validateMetadata(files: readonly IncomingAttachment[]): void {
    if (files.length > this.options.maxFilesPerRequest)
      throw new AttachmentError("TOO_MANY_ATTACHMENTS");
    for (const file of files) {
      this.mimeType(file);
      if (
        !file.sourceFileId ||
        !file.filename ||
        (file.sizeBytes !== undefined &&
          (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0))
      )
        throw new AttachmentError("ATTACHMENT_REJECTED");
      if (file.sizeBytes !== undefined && file.sizeBytes > this.options.maxFileSizeBytes)
        throw new AttachmentError("ATTACHMENT_TOO_LARGE");
    }
  }

  private mimeType(file: Pick<IncomingAttachment, "filename" | "mimeType">): string {
    const extension = extname(file.filename).slice(1).toLowerCase();
    const inferred = mimeByExtension[extension];
    if (!inferred || !this.options.allowedExtensions.includes(extension))
      throw new AttachmentError("ATTACHMENT_REJECTED");
    const mime = file.mimeType?.toLowerCase() || inferred;
    const normalized = mime === "application/octet-stream" ? inferred : mime;
    const text = inferred === "text/plain";
    if (
      !this.options.allowedMimeTypes.includes(normalized) ||
      (text
        ? !(
            normalized.startsWith("text/") ||
            [
              "application/javascript",
              "application/json",
              "application/xml",
              "application/x-yaml",
              "application/yaml",
              "application/x-sh",
            ].includes(normalized)
          )
        : normalized !== inferred)
    )
      throw new AttachmentError("ATTACHMENT_REJECTED");
    return normalized;
  }

  async prepare(
    requestId: string,
    files: readonly IncomingAttachment[],
    download: (file: IncomingAttachment) => AsyncIterable<Uint8Array>,
    at: string,
  ): Promise<PreparedAttachments> {
    this.validateMetadata(files);
    const attachments: Attachment[] = [];
    const leases: (() => void)[] = [];
    try {
      for (const file of files) {
        const stored = await this.store.put(download(file), this.options.maxFileSizeBytes);
        leases.push(stored.release);
        const attachment: Attachment = {
          ...file,
          id: crypto.randomUUID(),
          requestId,
          mimeType: this.mimeType(file),
          sizeBytes: stored.sizeBytes,
          temporaryStorageKey: stored.key,
          createdAt: at,
        };
        attachments.push(attachment);
        if (file.sizeBytes !== undefined && file.sizeBytes !== stored.sizeBytes)
          throw new AttachmentError("ATTACHMENT_REJECTED");
        await this.validateForSend([attachment]);
      }
      return {
        attachments,
        release: () => {
          for (const release of leases) release();
        },
      };
    } catch (error) {
      await this.cleanup(attachments);
      for (const release of leases) release();
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError("ATTACHMENT_UNAVAILABLE");
    }
  }

  async validateForSend(files: readonly Attachment[]): Promise<void> {
    this.validateMetadata(files);
    for (const file of files) {
      if (!file.temporaryStorageKey) throw new AttachmentError("ATTACHMENT_UNAVAILABLE");
      const mime = this.mimeType(file);
      const binary = mime === "application/pdf" || mime.startsWith("image/");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let total = 0;
      let prefix = new Uint8Array(0);
      try {
        for await (const chunk of this.store.read(file.temporaryStorageKey)) {
          total += chunk.byteLength;
          if (total > this.options.maxFileSizeBytes)
            throw new AttachmentError("ATTACHMENT_TOO_LARGE");
          if (prefix.length < 16)
            prefix = new Uint8Array([...prefix, ...chunk.subarray(0, 16 - prefix.length)]);
          if (!binary && decoder.decode(chunk, { stream: true }).includes("\0"))
            throw new AttachmentError("ATTACHMENT_REJECTED");
        }
        if (!binary) decoder.decode();
      } catch (error) {
        if (error instanceof AttachmentError) throw error;
        throw new AttachmentError("ATTACHMENT_REJECTED");
      }
      if (total !== file.sizeBytes) throw new AttachmentError("ATTACHMENT_REJECTED");
      const ascii = new TextDecoder("latin1").decode(prefix);
      const valid =
        mime === "application/pdf"
          ? ascii.startsWith("%PDF-")
          : mime === "image/png"
            ? prefix
                .subarray(0, 8)
                .every((byte, i) => byte === [137, 80, 78, 71, 13, 10, 26, 10][i]) &&
              prefix.length >= 8
            : mime === "image/jpeg"
              ? prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255
              : mime === "image/gif"
                ? /^GIF8[79]a/.test(ascii)
                : mime === "image/webp"
                  ? ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP"
                  : true;
      if (!valid) throw new AttachmentError("ATTACHMENT_REJECTED");
    }
  }

  async cleanup(files: readonly Attachment[]): Promise<boolean> {
    let success = true;
    for (const file of files)
      if (file.temporaryStorageKey) {
        try {
          if (this.retained?.().has(file.temporaryStorageKey)) continue;
          await this.store.remove(file.temporaryStorageKey);
        } catch {
          success = false;
        }
      }
    return success;
  }
}
