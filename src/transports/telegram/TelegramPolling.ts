import { setTimeout as delay } from "node:timers/promises";
import type { createLogger } from "../../logging/logger";
import {
  TelegramError,
  type TelegramApi,
  type TelegramIdentity,
  type TelegramUpdate,
} from "./TelegramApi";

type Dependencies = Readonly<{
  api: TelegramApi;
  initialize: (identity: TelegramIdentity) => Promise<void>;
  handle: (update: TelegramUpdate) => Promise<void>;
  shutdown: () => Promise<void>;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  log?: ReturnType<typeof createLogger>;
}>;

const retryDelaysMs = [1000, 2000, 4000, 8000, 16000] as const;
const maxRetryDelayMs = 60000;
function retryFailureReason(minimum: number | undefined, retries: number) {
  return minimum === undefined || !Number.isSafeInteger(minimum) || minimum < 0
    ? "not_retryable"
    : minimum > maxRetryDelayMs
      ? "retry_after_exceeds_limit"
      : retries === retryDelaysMs.length
        ? "retry_exhausted"
        : undefined;
}

async function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(delayMs, undefined, { signal });
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
}

export class TelegramPolling {
  private phase:
    | "idle"
    | "starting"
    | "running"
    | "reconnecting"
    | "stopping"
    | "stopped"
    | "error" = "idle";
  private closing: Promise<void> | undefined;
  constructor(private readonly dependencies: Dependencies) {}

  ready(): boolean {
    return this.phase === "running";
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.phase !== "idle") throw new Error("TELEGRAM_ALREADY_STARTED");
    this.phase = "starting";
    const onAbort = () => {
      this.phase = "stopping";
      void this.shutdown().catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let failed = false;
    let failure: unknown;
    try {
      await this.poll(signal);
    } catch (error) {
      if (!signal.aborted || error !== signal.reason) {
        this.phase = "error";
        failed = true;
        failure = error;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      try {
        await this.shutdown();
      } catch (error) {
        this.phase = "error";
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
      if (this.phase !== "error") this.phase = "stopped";
    }
    if (failed) throw failure;
  }

  private async poll(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const identity = await this.identity(signal);
    if (signal.aborted) return;
    await this.dependencies.initialize(identity);
    if (signal.aborted) return;
    let offset: number | undefined;
    let retries = 0;
    while (!signal.aborted) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.dependencies.api.getUpdates(offset, signal);
      } catch (error) {
        signal.throwIfAborted();
        this.phase = "reconnecting";
        const minimum =
          error instanceof TelegramError && error.code === "TELEGRAM_UNAVAILABLE"
            ? error.pollingRetryAfterMs
            : undefined;
        const reason = retryFailureReason(minimum, retries);
        if (reason) {
          this.dependencies.log?.("error", {
            operation: "telegram.poll_failed",
            errorCode: error instanceof TelegramError ? error.code : "TELEGRAM_UNAVAILABLE",
            reason,
          });
          throw error;
        }
        const retryDelayMs = Math.max(retryDelaysMs[retries], minimum as number);
        retries++;
        this.dependencies.log?.("warn", {
          operation: "telegram.poll_retry",
          errorCode: "TELEGRAM_UNAVAILABLE",
          retryAttempt: retries,
          retryDelayMs,
        });
        await (this.dependencies.wait ?? wait)(retryDelayMs, signal);
        signal.throwIfAborted();
        continue;
      }
      signal.throwIfAborted();
      if (retries)
        this.dependencies.log?.("info", {
          operation: "telegram.poll_recovered",
          retryAttempt: retries,
        });
      retries = 0;
      this.phase = "running";
      for (const update of updates) {
        if (signal.aborted) break;
        await this.dependencies.handle(update);
        // A later poll acknowledges only handled updates; durable ingress survives a lost offset.
        offset = update.update_id + 1;
      }
    }
  }

  private shutdown(): Promise<void> {
    this.closing ??= Promise.resolve().then(() => this.dependencies.shutdown());
    return this.closing;
  }

  private async identity(signal: AbortSignal): Promise<TelegramIdentity> {
    let retries = 0;
    for (;;) {
      signal.throwIfAborted();
      try {
        const identity = await this.dependencies.api.getMe(signal);
        signal.throwIfAborted();
        if (retries)
          this.dependencies.log?.("info", {
            operation: "telegram.identity_recovered",
            retryAttempt: retries,
          });
        return identity;
      } catch (error) {
        signal.throwIfAborted();
        const minimum =
          error instanceof TelegramError && error.code === "TELEGRAM_UNAVAILABLE"
            ? error.identityRetryAfterMs
            : undefined;
        const reason = retryFailureReason(minimum, retries);
        if (reason) {
          this.dependencies.log?.("error", {
            operation: "telegram.identity_failed",
            errorCode: error instanceof TelegramError ? error.code : "TELEGRAM_UNAVAILABLE",
            reason,
          });
          throw error;
        }
        const retryDelayMs = Math.max(retryDelaysMs[retries], minimum as number);
        retries++;
        this.dependencies.log?.("warn", {
          operation: "telegram.identity_retry",
          errorCode: "TELEGRAM_UNAVAILABLE",
          retryAttempt: retries,
          retryDelayMs,
        });
        await (this.dependencies.wait ?? wait)(retryDelayMs, signal);
      }
    }
  }
}
