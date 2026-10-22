import type { Request } from "../../domain/Request";
import { canSendImagePreview } from "../../domain/GeneratedImage";
import {
  maxDeliveryAttempts,
  type ResultDeliveryRepository,
  type DeliveryChunk,
} from "../../ports/ResultDeliveryRepository";
import type { RequestResult } from "../../ports/RequestResultRepository";
import { type TelegramApi, TelegramError } from "./TelegramApi";
import { unknownRecoveryNotice } from "./TelegramCommands";
import { renderTelegram } from "./TelegramRenderer";

const retryDelaysMs = [1000, 2000, 4000, 8000, 16000] as const;
const maxRetryDelayMs = 60000;
export function requestResultText(result: RequestResult): string {
  const request = result.request;
  if (result.message?.imageError)
    return [
      result.message.text,
      `Изображение создано в ChatGPT, но файл не получен: ${result.message.imageError}.`,
    ]
      .filter(Boolean)
      .join("\n\n");
  if (result.message?.images?.length) return result.message.text;
  return (
    result.message?.text ||
    (request.state === "completed"
      ? `Завершено: пустой ответ [${request.id}]`
      : `Запрос [${request.id}]: ${request.state}${result.errorCode ? ` · ${result.errorCode}` : ""}${request.state === "unknown" ? `\n${unknownRecoveryNotice}` : ""}`)
  );
}

export function requestResultPlan(result: RequestResult): readonly DeliveryChunk[] {
  const text = requestResultText(result);
  const chunks: DeliveryChunk[] = text ? [...renderTelegram(text)] : [];
  for (const [index, image] of (result.message?.images ?? []).entries()) {
    if (canSendImagePreview(image)) chunks.push({ kind: "photo", image: index });
    chunks.push({ kind: "document", image: index });
  }
  return chunks;
}

export async function sendResultPart(
  api: Pick<TelegramApi, "sendMessage" | "sendImage">,
  chunk: DeliveryChunk,
  result: RequestResult,
  destination: () => Readonly<{ chatId: string; replyTo?: string }>,
  signal?: AbortSignal,
): Promise<void> {
  if ("kind" in chunk) {
    const image = result.message?.images?.[chunk.image];
    if (!image || !api.sendImage) throw new TelegramError("TELEGRAM_DELIVERY_FAILED");
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[
      image.mimeType
    ];
    await api.sendImage(
      {
        ...destination(),
        image,
        kind: chunk.kind,
        filename: `original-${chunk.image + 1}.${extension}`,
      },
      signal,
    );
    return;
  }
  try {
    await api.sendMessage({ ...destination(), text: chunk.html, parseMode: "HTML" }, signal);
  } catch (error) {
    if (!(error instanceof TelegramError) || error.code !== "TELEGRAM_PARSE_ERROR") throw error;
    await api.sendMessage({ ...destination(), text: chunk.plain }, signal);
  }
}

export class TelegramResultDelivery {
  constructor(
    private readonly dependencies: Readonly<{
      repository: ResultDeliveryRepository;
      api: Pick<TelegramApi, "sendMessage" | "sendImage">;
      destination: (request: Request) => Readonly<{ chatId: string; replyTo?: string }> | null;
      now: () => string;
      signal?: AbortSignal;
    }>,
  ) {}

  async deliver(id: string): Promise<boolean> {
    const { repository, api, now } = this.dependencies;
    this.dependencies.signal?.throwIfAborted();
    const attempt = repository.start(id, now());
    if (!attempt) return false;
    try {
      const chunks = attempt.plan ?? requestResultPlan(attempt.result);
      if (!attempt.plan) repository.savePlan(id, attempt.attempts, chunks);
      const destination = () => {
        this.dependencies.signal?.throwIfAborted();
        const time = now();
        if (time >= attempt.expiresAt) {
          repository.expire(time);
          throw new TelegramError("TELEGRAM_DELIVERY_FAILED");
        }
        const target = this.dependencies.destination(attempt.result.request);
        if (!target) throw new TelegramError("TELEGRAM_DELIVERY_FAILED");
        return target;
      };
      for (let index = attempt.nextChunk; index < chunks.length; index++) {
        await sendResultPart(
          api,
          chunks[index],
          attempt.result,
          destination,
          this.dependencies.signal,
        );
        repository.acknowledge(id, attempt.attempts, index + 1);
      }
      repository.complete(id, attempt.attempts, now());
      return true;
    } catch (error) {
      // Unknown transport failures are retryable by the operator-approved at-least-once policy.
      // Explicit fatal errors and flood control without a usable minimum do not authorize a retry.
      const minimum =
        error instanceof TelegramError
          ? error.code === "TELEGRAM_DELIVERY_FAILED"
            ? error.deliveryRetryAfterMs
            : undefined
          : error instanceof Error && !("code" in error && error.code === "DATABASE_ERROR")
            ? 0
            : undefined;
      const retry =
        minimum !== undefined &&
        Number.isSafeInteger(minimum) &&
        minimum >= 0 &&
        minimum <= maxRetryDelayMs &&
        attempt.attempts < maxDeliveryAttempts;
      const next = retry
        ? new Date(
            Date.parse(now()) + Math.max(retryDelaysMs[attempt.attempts - 1], minimum),
          ).toISOString()
        : undefined;
      repository.fail(id, attempt.attempts, now(), next);
      this.dependencies.signal?.throwIfAborted();
      throw new TelegramError("TELEGRAM_DELIVERY_FAILED");
    }
  }
}
