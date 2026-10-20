import type { Request } from "../../domain/Request";
import {
  maxDeliveryAttempts,
  type ResultDeliveryRepository,
} from "../../ports/ResultDeliveryRepository";
import type { RequestResult } from "../../ports/RequestResultRepository";
import { type TelegramApi, TelegramError } from "./TelegramApi";
import { unknownRecoveryNotice } from "./TelegramCommands";
import { renderTelegram } from "./TelegramRenderer";

const retryDelaysMs = [1000, 2000, 4000, 8000, 16000] as const;
const maxRetryDelayMs = 60000;
export function requestResultText(result: RequestResult): string {
  const request = result.request;
  return (
    result.message?.text ||
    (request.state === "completed"
      ? `Завершено: пустой ответ [${request.id}]`
      : `Запрос [${request.id}]: ${request.state}${result.errorCode ? ` · ${result.errorCode}` : ""}${request.state === "unknown" ? `\n${unknownRecoveryNotice}` : ""}`)
  );
}

export class TelegramResultDelivery {
  constructor(
    private readonly dependencies: Readonly<{
      repository: ResultDeliveryRepository;
      api: Pick<TelegramApi, "sendMessage">;
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
      const chunks = attempt.plan ?? renderTelegram(requestResultText(attempt.result));
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
        const chunk = chunks[index];
        try {
          await api.sendMessage(
            { ...destination(), text: chunk.html, parseMode: "HTML" },
            this.dependencies.signal,
          );
        } catch (error) {
          if (!(error instanceof TelegramError) || error.code !== "TELEGRAM_PARSE_ERROR")
            throw error;
          await api.sendMessage({ ...destination(), text: chunk.plain }, this.dependencies.signal);
        }
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
