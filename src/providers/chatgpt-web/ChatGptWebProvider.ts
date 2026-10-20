import type { AttachmentStore } from "../../ports/AttachmentStore";
import type { createLogger } from "../../logging/logger";
import {
  type ChatProvider,
  ProviderOperationError,
  type ProviderRequestReference,
  type ProviderSendInput,
  type ProviderSendResult,
  type ProviderSubmission,
  type ProviderOutcome,
  type ProviderObservation,
  type ProviderCancelResult,
} from "../../ports/ChatProvider";
import { BrowserProfile, remoteIdPattern } from "./BrowserProfile";
import { ChatGptBrowserWorker } from "./upstream/src/adapters/chatgpt-web/browser-worker";
import {
  gatewayConversationId,
  gatewayDelay,
  gatewaySendUnknownReasons,
  GatewayBrowserError,
  type GatewayCode,
  type GatewayBrowserSession,
  type GatewayFile,
} from "./upstream/src/adapters/chatgpt-web/gateway-session";

export type NativeChatGptSession = Pick<
  GatewayBrowserSession,
  | "health"
  | "initializeConversation"
  | "inspectConversation"
  | "send"
  | "observe"
  | "login"
  | "close"
>;
const preSubmitCode = (code: GatewayCode) =>
  (
    ({
      auth_required: "AUTH_REQUIRED",
      unavailable: "PROVIDER_UNAVAILABLE",
      busy: "PROVIDER_UNAVAILABLE",
      chat_not_found: "CHAT_NOT_FOUND",
      chat_access_denied: "CHAT_ACCESS_DENIED",
      upload_failed: "UPLOAD_FAILED",
    }) as const
  )[code];

export class ChatGptWebProvider implements ChatProvider {
  // This fork owns one mutation page. Upstream's five launcher tabs do not prove gateway parallelism.
  readonly capabilities = Object.freeze({
    maxConcurrentConversations: 1,
    fileUpload: true,
    cancellation: false,
  });
  private readonly profile: BrowserProfile;
  private readonly session: NativeChatGptSession;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly attempted = new Set<string>();
  private current?: ProviderSubmission;

  constructor(
    private readonly options: {
      profileDir: string;
      executablePath?: string;
      headless?: boolean;
      attachmentStore?: AttachmentStore;
      session?: NativeChatGptSession;
      log?: ReturnType<typeof createLogger>;
    },
  ) {
    this.profile = new BrowserProfile(options.profileDir);
    this.session = options.session ?? ChatGptBrowserWorker.forGateway(options);
  }

  async health() {
    let state: "ready" | "auth_required" | "unavailable" = "unavailable";
    try {
      if (!this.closed) {
        this.profile.initialize(true);
        state = await this.session.health();
        // A prior failed browser launch may have overlapped the previous owner's final writes.
        if (state === "ready") this.profile.initialize(true);
      }
    } catch {
      /* Profile/browser exceptions never become diagnostics. */
      state = "unavailable";
    }
    return { state, observedAt: new Date().toISOString() };
  }

  createConversation(): Promise<{ id: string }> {
    return this.serialize(async () => {
      await this.requireReady();
      await this.safe(() => this.session.initializeConversation());
      return { id: this.profile.createDraft() };
    });
  }

  inspectConversation(reference: string): Promise<{ id: string; url: string }> {
    const lower = reference.toLowerCase();
    const remoteId = remoteIdPattern.test(lower) ? lower : gatewayConversationId(reference);
    if (!remoteId)
      return Promise.reject(new ProviderOperationError("INVALID_CONVERSATION_REFERENCE"));
    return this.serialize(async () => {
      await this.requireReady();
      await this.safe(() => this.session.inspectConversation(remoteId));
      return { id: this.profile.keyForRemote(remoteId), url: `https://chatgpt.com/c/${remoteId}` };
    });
  }

  send(input: ProviderSendInput): Promise<ProviderSendResult> {
    return this.serialize(async () => {
      const identity = {
        conversationId: input.conversationId,
        clientRequestId: input.clientRequestId,
      };
      if (this.attempted.has(input.clientRequestId)) return this.unknown(identity);
      let remoteId: string | undefined;
      let files: GatewayFile[];
      try {
        await this.requireReady();
        remoteId = this.profile.remoteId(input.conversationId);
        files = await this.files(input);
      } catch (error) {
        return {
          ...identity,
          state: "not_submitted",
          code:
            error instanceof ProviderOperationError &&
            error.code !== "INVALID_CONVERSATION_REFERENCE"
              ? error.code
              : "SEND_FAILED_PRE_SUBMIT",
        };
      }
      this.attempted.add(input.clientRequestId);
      try {
        const result = await this.session.send({
          id: input.clientRequestId,
          remoteId,
          text: input.text ?? "",
          files,
        });
        if (result.state === "not_submitted")
          return { ...identity, state: "not_submitted", code: preSubmitCode(result.code) };
        if (result.state === "unknown") {
          this.logSubmission(
            "provider.submission_unknown",
            input.clientRequestId,
            gatewaySendUnknownReasons.find((reason) => reason === result.reason) ??
              "native_send_unknown",
          );
          return this.unknown(identity);
        }
        // Persist the remote binding before exposing confirmed submission. Failure is ambiguous.
        this.profile.bind(input.conversationId, result.remoteId);
        this.current = { ...identity, state: "submitted", providerRequestId: result.turnId };
        if (result.activationRecovered)
          this.logSubmission(
            "provider.submission_recovered",
            input.clientRequestId,
            "send_activation_error_with_receipt",
          );
        return { ...this.current };
      } catch {
        this.logSubmission(
          "provider.submission_unknown",
          input.clientRequestId,
          "submission_receipt_failed",
        );
        return this.unknown(identity);
      }
    });
  }

  async awaitCompletion(input: {
    submission: ProviderSubmission;
    signal: AbortSignal;
  }): Promise<ProviderOutcome> {
    if (!this.matches(input.submission)) return this.unknown(input.submission);
    while (!input.signal.aborted) {
      const outcome = await this.inspectRequest(input.submission);
      if (outcome.state !== "running")
        return outcome.state === "not_submitted" ? this.unknown(input.submission) : outcome;
      await gatewayDelay(100, input.signal);
    }
    return this.unknown(input.submission);
  }

  async inspectRequest(reference: ProviderRequestReference): Promise<ProviderObservation> {
    const current = this.current;
    if (!current?.providerRequestId || !this.matches(reference)) return this.unknown(reference);
    try {
      const observed = await this.session.observe(
        reference.clientRequestId,
        current.providerRequestId,
      );
      if (observed.state === "unknown") return this.unknown(reference);
      if (observed.state === "running") return { ...current, state: "running" };
      return {
        ...current,
        state: "completed",
        message: { text: observed.text, id: observed.messageId },
      };
    } catch {
      return this.unknown(reference);
    }
  }

  async cancel(reference: ProviderRequestReference): Promise<ProviderCancelResult> {
    // The upstream AbortError/Stop acknowledgement does not prove a correlated cancelled outcome.
    return {
      state: "not_cancelled",
      conversationId: reference.conversationId,
      clientRequestId: reference.clientRequestId,
    };
  }

  async login(signal?: AbortSignal): Promise<void> {
    this.profile.initialize(true);
    await this.safe(() => this.session.login(signal));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail.catch(() => undefined);
    await this.safe(() => this.session.close());
    this.current = undefined;
  }

  private async files(input: ProviderSendInput): Promise<GatewayFile[]> {
    if (input.attachments.length > 10 || (!input.text && input.attachments.length === 0))
      throw new ProviderOperationError("ATTACHMENT_REJECTED");
    const files: GatewayFile[] = [];
    let total = 0;
    for (const file of input.attachments) {
      if (
        !this.options.attachmentStore ||
        file.sizeBytes <= 0 ||
        file.sizeBytes > 20_000_000 ||
        !Number.isSafeInteger(file.sizeBytes)
      )
        throw new ProviderOperationError("ATTACHMENT_REJECTED");
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const bytes of this.options.attachmentStore.read(file.storageKey)) {
          size += bytes.byteLength;
          if (size > file.sizeBytes) throw new Error();
          chunks.push(Buffer.from(bytes));
        }
        total += size;
        if (size !== file.sizeBytes || total > 50_000_000) throw new Error();
      } catch {
        throw new ProviderOperationError("UPLOAD_FAILED");
      }
      files.push({ name: file.filename, mimeType: file.mimeType, buffer: Buffer.concat(chunks) });
    }
    return files;
  }

  private matches(reference: ProviderRequestReference): boolean {
    return (
      !!this.current &&
      this.current.conversationId === reference.conversationId &&
      this.current.clientRequestId === reference.clientRequestId &&
      (!reference.providerRequestId ||
        this.current.providerRequestId === reference.providerRequestId)
    );
  }

  private logSubmission(
    operation: "provider.submission_unknown" | "provider.submission_recovered",
    requestId: string,
    reason: string,
  ): void {
    try {
      this.options.log?.("warn", { operation, requestId, reason });
    } catch {
      // Optional diagnostics cannot replace an established submission result.
    }
  }
  private unknown(reference: ProviderRequestReference): ProviderOutcome & { state: "unknown" } {
    return {
      state: "unknown",
      code: "SUBMISSION_STATE_UNKNOWN",
      conversationId: reference.conversationId,
      clientRequestId: reference.clientRequestId,
    };
  }
  private async requireReady(): Promise<void> {
    const state = (await this.health()).state;
    if (state !== "ready")
      throw new ProviderOperationError(
        state === "auth_required" ? "AUTH_REQUIRED" : "PROVIDER_UNAVAILABLE",
      );
  }
  private async safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new ProviderOperationError(
        error instanceof GatewayBrowserError ? preSubmitCode(error.code) : "PROVIDER_UNAVAILABLE",
      );
    }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
