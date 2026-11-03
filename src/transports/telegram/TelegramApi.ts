import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { AttachmentError } from "../../ports/AttachmentStore";
import {
  type GeneratedImage,
  generatedImageSchema,
  canSendImagePreview,
} from "../../domain/GeneratedImage";

const integer = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const sender = z.object({ id: integer.positive(), is_bot: z.boolean() });
const message = z.object({
  message_id: integer.nonnegative(),
  from: sender.optional(),
  sender_chat: z.unknown().optional(),
  chat: z.object({ id: integer, type: z.enum(["private", "group", "supergroup", "channel"]) }),
  text: z.string().optional(),
  caption: z.string().optional(),
  media_group_id: z.string().min(1).optional(),
  document: z.unknown().optional(),
  photo: z.unknown().optional(),
  audio: z.unknown().optional(),
  video: z.unknown().optional(),
  voice: z.unknown().optional(),
  animation: z.unknown().optional(),
  sticker: z.unknown().optional(),
  video_note: z.unknown().optional(),
});
export const telegramUpdateSchema = z.object({
  update_id: integer.nonnegative(),
  message: message.optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
export type TelegramSend = Readonly<{
  chatId: string;
  text: string;
  parseMode?: "HTML";
  replyTo?: string;
}>;
export type TelegramIdentity = Readonly<{ id: number; username: string }>;
export type TelegramImageSend = Readonly<{
  chatId: string;
  replyTo?: string;
  image: GeneratedImage;
  kind: "photo" | "document";
  filename: string;
}>;
export type TelegramFetch = (url: string, input: RequestInit) => Promise<Response>;
type TelegramMethod =
  | "getMe"
  | "getUpdates"
  | "sendMessage"
  | "getFile"
  | "sendPhoto"
  | "sendDocument";
const isDelivery = (method: TelegramMethod) =>
  method === "sendMessage" || method === "sendPhoto" || method === "sendDocument";

export interface TelegramApi {
  getMe(signal?: AbortSignal): Promise<TelegramIdentity>;
  getUpdates(offset: number | undefined, signal: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(input: TelegramSend, signal?: AbortSignal): Promise<void>;
  sendImage?(input: TelegramImageSend, signal?: AbortSignal): Promise<void>;
  downloadFile(fileId: string, maxBytes: number, signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

export class TelegramError extends Error {
  constructor(
    readonly code:
      | "TELEGRAM_TOKEN_INVALID"
      | "TELEGRAM_CONFLICT"
      | "TELEGRAM_UNAVAILABLE"
      | "TELEGRAM_PARSE_ERROR"
      | "TELEGRAM_DELIVERY_FAILED",
    // Only getUpdates may supply this hint. It never authorizes replay of a handled update.
    readonly pollingRetryAfterMs?: number,
    // Only sendMessage supplies this separately from polling. Delivery may duplicate an ambiguous part.
    readonly deliveryRetryAfterMs?: number,
    readonly identityRetryAfterMs?: number,
    readonly fileRetryAfterMs?: number,
  ) {
    super(code);
    this.name = "TelegramError";
  }
}

function retryError(
  method: TelegramMethod,
  code: TelegramError["code"],
  minimum?: number,
): TelegramError {
  return new TelegramError(
    code,
    method === "getUpdates" ? minimum : undefined,
    isDelivery(method) ? minimum : undefined,
    method === "getMe" ? minimum : undefined,
    method === "getFile" ? minimum : undefined,
  );
}

const envelope = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: integer.optional(),
  description: z.string().optional(),
  parameters: z.unknown().optional(),
});

const floodControl = z.object({
  retry_after: integer.nonnegative().max(Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
});
const transientNetworkCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "ConnectionClosed",
  "ConnectionRefused",
]);

function transientNetworkError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    transientNetworkCodes.has(error.code)
  );
}

class FileReadError extends Error {
  constructor(
    readonly reason: "download_metadata" | "download_body",
    readonly retryAfterMs?: number,
  ) {
    super("ATTACHMENT_UNAVAILABLE");
  }
}

export class HttpTelegramApi implements TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetcher: TelegramFetch = fetch,
    private readonly wait: (ms: number, signal: AbortSignal) => Promise<void> = (ms, signal) =>
      delay(ms, undefined, { signal }),
  ) {
    if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) throw new TelegramError("TELEGRAM_TOKEN_INVALID");
  }

  async getMe(signal?: AbortSignal): Promise<TelegramIdentity> {
    const result = await this.call("getMe", {}, signal);
    const parsed = sender
      .extend({ is_bot: z.literal(true), username: z.string().min(1) })
      .safeParse(result);
    if (!parsed.success) throw new TelegramError("TELEGRAM_UNAVAILABLE");
    return { id: parsed.data.id, username: parsed.data.username };
  }

  async getUpdates(offset: number | undefined, signal: AbortSignal): Promise<TelegramUpdate[]> {
    const result = await this.call(
      "getUpdates",
      { offset, timeout: 25, allowed_updates: ["message"] },
      signal,
    );
    const parsed = z.array(telegramUpdateSchema).safeParse(result);
    if (!parsed.success) throw new TelegramError("TELEGRAM_UNAVAILABLE");
    return parsed.data;
  }

  async sendMessage(input: TelegramSend, signal?: AbortSignal): Promise<void> {
    const result = await this.call(
      "sendMessage",
      {
        chat_id: input.chatId,
        text: input.text,
        parse_mode: input.parseMode,
        reply_parameters: input.replyTo
          ? { message_id: Number(input.replyTo), allow_sending_without_reply: true }
          : undefined,
        link_preview_options: { is_disabled: true },
      },
      signal,
    );
    if (!z.object({ message_id: integer.positive() }).safeParse(result).success)
      throw new TelegramError("TELEGRAM_DELIVERY_FAILED", undefined, 0);
  }

  async *downloadFile(
    fileId: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    signal?.throwIfAborted();
    // The hosted Bot API supports downloads up to 20 MB. Metadata is not proof of actual size.
    const limit = Math.min(maxBytes, 20_000_000);
    const expiresAt = Date.now() + 30000;
    const deadline = AbortSignal.timeout(30000);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      for (let attempt = 0; ; attempt++) {
        let yielded = false;
        try {
          for await (const chunk of this.readFile(fileId, limit, requestSignal)) {
            yielded = true;
            yield chunk;
          }
          return;
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof AttachmentError) throw error;
          const failure = error instanceof FileReadError ? error : undefined;
          const minimum = failure?.retryAfterMs;
          const retryDelayMs = Math.max(1000 * 2 ** attempt, minimum ?? 0);
          // Restarting after a yield would append duplicate bytes to the caller's partial file.
          if (
            yielded ||
            attempt >= 2 ||
            minimum === undefined ||
            !Number.isSafeInteger(minimum) ||
            minimum < 0 ||
            requestSignal.aborted ||
            Date.now() + retryDelayMs >= expiresAt
          )
            throw new AttachmentError(
              "ATTACHMENT_UNAVAILABLE",
              yielded
                ? "download_partial"
                : requestSignal.aborted
                  ? "download_timeout"
                  : failure?.reason,
            );
          await this.wait(retryDelayMs, requestSignal);
        }
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError(
        "ATTACHMENT_UNAVAILABLE",
        requestSignal.aborted ? "download_timeout" : undefined,
      );
    }
  }

  private async *readFile(
    fileId: string,
    limit: number,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let reason: "download_metadata" | "download_body" = "download_metadata";
    try {
      const parsed = z
        .object({
          file_id: z.string().min(1),
          file_size: integer.nonnegative().optional(),
          file_path: z.string().min(1),
        })
        .safeParse(await this.call("getFile", { file_id: fileId }, signal));
      if (!parsed.success) throw new AttachmentError("ATTACHMENT_UNAVAILABLE", reason);
      if (parsed.data.file_size !== undefined && parsed.data.file_size > limit)
        throw new AttachmentError("ATTACHMENT_TOO_LARGE");
      const path = parsed.data.file_path;
      const segments = path.split("/");
      if (
        /[\\\p{Cc}]/u.test(path) ||
        segments.some((part) => !part || part === "." || part === "..")
      )
        throw new AttachmentError("ATTACHMENT_UNAVAILABLE", reason);
      reason = "download_body";
      const response = await this.fetcher(
        `https://api.telegram.org/file/bot${this.token}/${segments.map(encodeURIComponent).join("/")}`,
        { method: "GET", redirect: "error", signal },
      );
      reader = response.body?.getReader();
      if (!response.ok || !reader)
        throw new FileReadError(
          reason,
          response.status >= 500 && response.status <= 599 ? 0 : undefined,
        );
      let size = 0;
      for (;;) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) throw new AttachmentError("ATTACHMENT_TOO_LARGE");
        yield next.value;
      }
      if (parsed.data.file_size !== undefined && size !== parsed.data.file_size)
        throw new AttachmentError("ATTACHMENT_REJECTED");
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AttachmentError || error instanceof FileReadError) throw error;
      throw new FileReadError(
        reason,
        error instanceof TelegramError
          ? error.fileRetryAfterMs
          : transientNetworkError(error)
            ? 0
            : undefined,
      );
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }

  async sendImage(input: TelegramImageSend, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const parsed = generatedImageSchema.safeParse(input.image);
    if (
      !parsed.success ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(input.filename) ||
      !["photo", "document"].includes(input.kind) ||
      (input.kind === "photo" && !canSendImagePreview(parsed.data))
    )
      throw new TelegramError("TELEGRAM_DELIVERY_FAILED");
    const image = parsed.data;
    const form = new FormData();
    form.set("chat_id", input.chatId);
    if (input.replyTo)
      form.set(
        "reply_parameters",
        JSON.stringify({ message_id: Number(input.replyTo), allow_sending_without_reply: true }),
      );
    form.set(
      input.kind,
      new Blob([Buffer.from(image.base64, "base64")], { type: image.mimeType }),
      input.filename,
    );
    if (input.kind === "document") {
      form.set("caption", "Скачать оригинал");
      form.set("disable_content_type_detection", "true");
    }
    const result = await this.call(
      input.kind === "photo" ? "sendPhoto" : "sendDocument",
      form,
      signal,
    );
    if (!z.object({ message_id: integer.positive() }).safeParse(result).success)
      throw new TelegramError("TELEGRAM_DELIVERY_FAILED", undefined, 0);
  }

  private async call(method: TelegramMethod, body: object, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(
      method === "getUpdates"
        ? 35000
        : method === "sendPhoto" || method === "sendDocument"
          ? 60000
          : 15000,
    );
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const failureCode = isDelivery(method) ? "TELEGRAM_DELIVERY_FAILED" : "TELEGRAM_UNAVAILABLE";
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: body instanceof FormData ? undefined : { "content-type": "application/json" },
        body: body instanceof FormData ? body : JSON.stringify(body),
        // Bun 1.4.0 stalled live uploads on pooled connections; media POSTs use fresh connections.
        ...(body instanceof FormData ? { keepalive: false } : {}),
        redirect: "error",
        signal: requestSignal,
      });
      if (method !== "getFile") {
        if (response.status === 401 || (method === "getMe" && response.status === 404))
          throw new TelegramError("TELEGRAM_TOKEN_INVALID");
        if (response.status === 409) throw new TelegramError("TELEGRAM_CONFLICT");
      }
      const serverFailure = response.status >= 500 && response.status <= 599;
      const parsed = envelope.safeParse(
        await response.json().catch((error: unknown) => {
          // A known 5xx stays transient even when its body cannot be read or decoded.
          if (serverFailure) return undefined;
          // An unreadable 429 cannot authorize a retry before an unknown retry_after.
          if (!response.ok && !serverFailure) throw new TelegramError(failureCode);
          throw error;
        }),
      );
      if (!parsed.success)
        throw retryError(
          method,
          failureCode,
          serverFailure || (isDelivery(method) && response.ok) ? 0 : undefined,
        );
      const data = parsed.data;
      if (!data.ok || !response.ok) {
        if (
          response.status === 401 ||
          data.error_code === 401 ||
          (method === "getMe" && data.error_code === 404)
        )
          throw new TelegramError("TELEGRAM_TOKEN_INVALID");
        if (method !== "getFile") {
          if (response.status === 409 || data.error_code === 409)
            throw new TelegramError("TELEGRAM_CONFLICT");
        }
        if (!data.ok && response.status === 429 && data.error_code === 429) {
          const parameters = floodControl.safeParse(data.parameters);
          throw retryError(
            method,
            failureCode,
            parameters.success ? parameters.data.retry_after * 1000 : undefined,
          );
        }
        if (
          !data.ok &&
          serverFailure &&
          (data.error_code === undefined || (data.error_code >= 500 && data.error_code <= 599))
        )
          throw retryError(method, failureCode, 0);
        // Only an explicit parser rejection proves that a rich message was not sent.
        if (
          method === "sendMessage" &&
          !data.ok &&
          response.status === 400 &&
          data.error_code === 400 &&
          /^Bad Request: can't parse entities(?::|$)/i.test(data.description ?? "")
        )
          throw new TelegramError("TELEGRAM_PARSE_ERROR");
        throw new TelegramError(failureCode);
      }
      return data.result;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof TelegramError) throw error;
      // Fetch errors can include the token-bearing URL; neither cause nor description escapes this adapter.
      const transient = deadline.aborted || transientNetworkError(error);
      throw retryError(method, failureCode, transient || isDelivery(method) ? 0 : undefined);
    }
  }
}
