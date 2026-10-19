import { z } from "zod";
import { AttachmentError } from "../../ports/AttachmentStore";

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
export type TelegramFetch = (url: string, input: RequestInit) => Promise<Response>;

export interface TelegramApi {
  getMe(): Promise<TelegramIdentity>;
  getUpdates(offset: number | undefined, signal: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(input: TelegramSend): Promise<void>;
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
  ) {
    super(code);
    this.name = "TelegramError";
  }
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

export class HttpTelegramApi implements TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetcher: TelegramFetch = fetch,
  ) {
    if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) throw new TelegramError("TELEGRAM_TOKEN_INVALID");
  }

  async getMe(): Promise<TelegramIdentity> {
    const result = await this.call("getMe", {});
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

  async sendMessage(input: TelegramSend): Promise<void> {
    const result = await this.call("sendMessage", {
      chat_id: input.chatId,
      text: input.text,
      parse_mode: input.parseMode,
      reply_parameters: input.replyTo
        ? { message_id: Number(input.replyTo), allow_sending_without_reply: true }
        : undefined,
      link_preview_options: { is_disabled: true },
    });
    if (!z.object({ message_id: integer.positive() }).safeParse(result).success)
      throw new TelegramError("TELEGRAM_DELIVERY_FAILED");
  }

  async *downloadFile(
    fileId: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    signal?.throwIfAborted();
    // The hosted Bot API supports downloads up to 20 MB. Metadata is not proof of actual size.
    const limit = Math.min(maxBytes, 20_000_000);
    const deadline = AbortSignal.timeout(30000);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const parsed = z
        .object({
          file_id: z.string().min(1),
          file_size: integer.nonnegative().optional(),
          file_path: z.string().min(1),
        })
        .safeParse(await this.call("getFile", { file_id: fileId }, requestSignal));
      if (!parsed.success) throw new AttachmentError("ATTACHMENT_UNAVAILABLE");
      if (parsed.data.file_size !== undefined && parsed.data.file_size > limit)
        throw new AttachmentError("ATTACHMENT_TOO_LARGE");
      const path = parsed.data.file_path;
      const segments = path.split("/");
      if (
        /[\\\p{Cc}]/u.test(path) ||
        segments.some((part) => !part || part === "." || part === "..")
      )
        throw new AttachmentError("ATTACHMENT_UNAVAILABLE");
      const response = await this.fetcher(
        `https://api.telegram.org/file/bot${this.token}/${segments.map(encodeURIComponent).join("/")}`,
        { method: "GET", redirect: "error", signal: requestSignal },
      );
      if (!response.ok || !response.body) throw new AttachmentError("ATTACHMENT_UNAVAILABLE");
      reader = response.body.getReader();
      let size = 0;
      for (;;) {
        requestSignal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) throw new AttachmentError("ATTACHMENT_TOO_LARGE");
        yield next.value;
      }
      if (parsed.data.file_size !== undefined && size !== parsed.data.file_size)
        throw new AttachmentError("ATTACHMENT_REJECTED");
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError("ATTACHMENT_UNAVAILABLE");
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }

  private async call(
    method: "getMe" | "getUpdates" | "sendMessage" | "getFile",
    body: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(method === "getUpdates" ? 35000 : 15000);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const failureCode =
      method === "sendMessage" ? "TELEGRAM_DELIVERY_FAILED" : "TELEGRAM_UNAVAILABLE";
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: requestSignal,
      });
      if (method === "getUpdates") {
        if (response.status === 401) throw new TelegramError("TELEGRAM_TOKEN_INVALID");
        if (response.status === 409) throw new TelegramError("TELEGRAM_CONFLICT");
      }
      const serverFailure = response.status >= 500 && response.status <= 599;
      const parsed = envelope.safeParse(
        await response.json().catch((error: unknown) => {
          // A known 5xx stays transient even when its body cannot be read or decoded.
          if (method === "getUpdates" && serverFailure) return undefined;
          // An unreadable 429 cannot authorize a retry before an unknown retry_after.
          if (method === "getUpdates" && !response.ok && !serverFailure)
            throw new TelegramError(failureCode);
          throw error;
        }),
      );
      if (!parsed.success)
        throw new TelegramError(
          failureCode,
          method === "getUpdates" && serverFailure ? 0 : undefined,
        );
      const data = parsed.data;
      if (!data.ok || !response.ok) {
        if (
          response.status === 401 ||
          data.error_code === 401 ||
          (method === "getMe" && data.error_code === 404)
        )
          throw new TelegramError("TELEGRAM_TOKEN_INVALID");
        if (method === "getUpdates") {
          if (response.status === 409 || data.error_code === 409)
            throw new TelegramError("TELEGRAM_CONFLICT");
          if (!data.ok && response.status === 429 && data.error_code === 429) {
            const parameters = floodControl.safeParse(data.parameters);
            throw new TelegramError(
              failureCode,
              parameters.success ? parameters.data.retry_after * 1000 : undefined,
            );
          }
          if (
            !data.ok &&
            serverFailure &&
            (data.error_code === undefined || (data.error_code >= 500 && data.error_code <= 599))
          )
            throw new TelegramError(failureCode, 0);
        }
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
      const transient =
        deadline.aborted ||
        (error instanceof Error &&
          "code" in error &&
          typeof error.code === "string" &&
          transientNetworkCodes.has(error.code));
      throw new TelegramError(failureCode, method === "getUpdates" && transient ? 0 : undefined);
    }
  }
}
