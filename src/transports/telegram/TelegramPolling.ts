import type { TelegramApi, TelegramIdentity, TelegramUpdate } from "./TelegramApi";

type Dependencies = Readonly<{
  api: TelegramApi;
  initialize: (identity: TelegramIdentity) => Promise<void>;
  handle: (update: TelegramUpdate) => Promise<void>;
  shutdown: () => Promise<void>;
}>;

export class TelegramPolling {
  private phase: "idle" | "starting" | "running" | "stopping" | "stopped" | "error" = "idle";
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
    const identity = await this.dependencies.api.getMe();
    if (signal.aborted) return;
    await this.dependencies.initialize(identity);
    if (signal.aborted) return;
    this.phase = "running";
    let offset: number | undefined;
    while (!signal.aborted) {
      const updates = await this.dependencies.api.getUpdates(offset, signal);
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
}
