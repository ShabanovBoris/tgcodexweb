import { z } from "zod";

const integer = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const sender = z.object({ id: integer.positive(), is_bot: z.boolean() });
const message = z.object({
  message_id: integer.nonnegative(),
  from: sender.optional(),
  sender_chat: z.unknown().optional(),
  chat: z.object({ id: integer, type: z.enum(["private", "group", "supergroup", "channel"]) }),
  text: z.string().optional(),
  caption: z.string().optional(),
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
}

export class TelegramError extends Error {
  constructor(
    readonly code:
      | "TELEGRAM_TOKEN_INVALID"
      | "TELEGRAM_UNAVAILABLE"
      | "TELEGRAM_PARSE_ERROR"
      | "TELEGRAM_DELIVERY_FAILED",
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
});

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

  private async call(
    method: "getMe" | "getUpdates" | "sendMessage",
    body: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(method === "getUpdates" ? 35000 : 15000);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: requestSignal,
      });
      const parsed = envelope.safeParse(await response.json());
      if (!parsed.success)
        throw new TelegramError(
          method === "sendMessage" ? "TELEGRAM_DELIVERY_FAILED" : "TELEGRAM_UNAVAILABLE",
        );
      const data = parsed.data;
      if (!data.ok || !response.ok) {
        if (data.error_code === 401 || (method === "getMe" && data.error_code === 404))
          throw new TelegramError("TELEGRAM_TOKEN_INVALID");
        // Only an explicit parser rejection proves that a rich message was not sent.
        if (
          method === "sendMessage" &&
          data.error_code === 400 &&
          /^Bad Request: can't parse entities(?::|$)/i.test(data.description ?? "")
        )
          throw new TelegramError("TELEGRAM_PARSE_ERROR");
        throw new TelegramError(
          method === "sendMessage" ? "TELEGRAM_DELIVERY_FAILED" : "TELEGRAM_UNAVAILABLE",
        );
      }
      return data.result;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof TelegramError) throw error;
      // Fetch errors can include the token-bearing URL; neither cause nor description escapes this adapter.
      throw new TelegramError(
        method === "sendMessage" ? "TELEGRAM_DELIVERY_FAILED" : "TELEGRAM_UNAVAILABLE",
      );
    }
  }
}
