import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
import { readChatGptAuthSession } from "../../../launcher/electron/chatgpt-auth-session.cjs";
import { openNormalBrowserLogin } from "../../browser-login";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_SEND_BUTTON_SELECTOR,
  chatGptAssistantTurnSelector,
} from "../../chatgpt-session";
import {
  ChatGptCompletionTracker,
  withChatGptBrowserObservationTimeout,
  type ChatGptResponseDomSnapshot,
  type ChatGptSubmissionBaseline,
  type ChatGptSubmissionDomState,
} from "./browser-worker";
import { ChatGptMarkdownBuffer } from "./markdown";

// Local fork API. No native page, auth payload, or exception leaves the gateway provider module.
export type GatewaySessionOptions = {
  profileDir: string;
  executablePath?: string;
  headless?: boolean;
  launch?: typeof chromium.launchPersistentContext;
};
export type GatewayFile = { name: string; mimeType: string; buffer: Buffer };
export type GatewayCode =
  | "auth_required"
  | "unavailable"
  | "chat_not_found"
  | "chat_access_denied"
  | "busy"
  | "upload_failed";
export class GatewayBrowserError extends Error {
  constructor(readonly code: GatewayCode) {
    super(code);
  }
}
export type GatewaySendReceipt =
  | { state: "submitted"; remoteId: string; turnId: string }
  | { state: "not_submitted"; code: GatewayCode }
  | { state: "unknown" };
export type GatewayObservation =
  | { state: "running" }
  | { state: "completed"; text: string; messageId: string }
  | { state: "unknown" };
export type GatewayPrimitives = {
  composer(page: Page): Promise<Locator>;
  baseline(page: Page, text?: string): Promise<ChatGptSubmissionBaseline>;
  state(page: Page, baseline: ChatGptSubmissionBaseline): Promise<ChatGptSubmissionDomState>;
  insert(page: Page, text: string): Promise<void>;
  attachedText(page: Page): Promise<string>;
  equivalent(expected: string, observed: string): boolean;
  attach(page: Page, files: GatewayFile[]): Promise<void>;
  response(locator: Locator): Promise<ChatGptResponseDomSnapshot>;
};
type Operation = {
  id: string;
  page?: Page;
  baseline?: ChatGptSubmissionBaseline;
  remoteId?: string;
  turnId?: string;
  responseId?: string;
  tracker: ChatGptCompletionTracker;
  markdown: ChatGptMarkdownBuffer;
  outcome?: GatewayObservation;
};
const remotePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function gatewayConversationId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const id = /^\/c\/([^/]+)\/?$/.exec(parsed.pathname)?.[1]?.toLowerCase();
    return parsed.origin === "https://chatgpt.com" && id && remotePattern.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
export function gatewayDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export class GatewayBrowserSession {
  private context?: BrowserContext;
  private opening?: Promise<BrowserContext>;
  private probe?: Page;
  private operation?: Operation;
  private closed = false;

  constructor(
    private readonly options: GatewaySessionOptions,
    private readonly primitives: GatewayPrimitives,
  ) {}

  private async browser(): Promise<BrowserContext> {
    if (this.closed) throw new GatewayBrowserError("unavailable");
    if (this.context) return this.context;
    if (!this.opening) {
      this.opening = (async () => {
        const context = await (
          this.options.launch ?? chromium.launchPersistentContext.bind(chromium)
        )(this.options.profileDir, {
          executablePath: this.options.executablePath,
          headless: this.options.headless === true,
          timeout: 30_000,
          acceptDownloads: false,
          // Match upstream's verifier after normal manual login; keep the browser's native keys.
          ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
        });
        context.setDefaultTimeout(20_000);
        context.on("close", () => {
          this.context = undefined;
          this.probe = undefined;
        });
        this.context = context;
        return context;
      })().finally(() => {
        this.opening = undefined;
      });
    }
    return this.opening;
  }

  private async authenticate(page: Page): Promise<void> {
    const result = await withChatGptBrowserObservationTimeout(
      page.evaluate(readChatGptAuthSession, {
        origin: "https://chatgpt.com",
        timeoutMs: 5_000,
      }),
      6_000,
    );
    if (result.sessionCheckError) throw new GatewayBrowserError("unavailable");
    if (!result.sessionAuthenticated) throw new GatewayBrowserError("auth_required");
  }

  async login(signal?: AbortSignal): Promise<void> {
    if (this.closed || this.context || this.opening || !this.options.executablePath)
      throw new GatewayBrowserError("unavailable");
    await openNormalBrowserLogin({
      executablePath: this.options.executablePath,
      profileDir: this.options.profileDir,
      startUrl: "https://chatgpt.com/",
      signal,
    });
  }

  private async ensureProbePage(): Promise<void> {
    if (!this.probe || this.probe.isClosed()) {
      this.probe = await (await this.browser()).newPage();
      await this.probe.goto("https://chatgpt.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    }
  }

  async health(): Promise<"ready" | "auth_required" | "unavailable"> {
    try {
      await this.ensureProbePage();
      const probe = this.probe;
      if (!probe) return "unavailable";
      await this.authenticate(probe);
      const composer = probe.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
      return (await withChatGptBrowserObservationTimeout(
        (async () => (await composer.count()) === 1 && (await composer.isEditable()))(),
      ))
        ? "ready"
        : "unavailable";
    } catch (error) {
      return error instanceof GatewayBrowserError && error.code === "auth_required"
        ? "auth_required"
        : "unavailable";
    }
  }

  private async surface(remoteId?: string): Promise<Page> {
    const page = await (await this.browser()).newPage();
    try {
      const response = await page.goto(
        remoteId ? `https://chatgpt.com/c/${remoteId}` : "https://chatgpt.com/",
        { waitUntil: "domcontentloaded", timeout: 30_000 },
      );
      await this.authenticate(page);
      if (response?.status() === 404) throw new GatewayBrowserError("chat_not_found");
      if (response?.status() === 403) throw new GatewayBrowserError("chat_access_denied");
      await this.primitives.composer(page);
      if (remoteId) {
        if (gatewayConversationId(page.url()) !== remoteId)
          throw new GatewayBrowserError("chat_access_denied");
        const baseline = await this.primitives.baseline(page);
        if (baseline.initialTurnIdentities.length === 0)
          throw new GatewayBrowserError("chat_access_denied");
      } else {
        const url = new URL(page.url());
        if (
          url.origin !== "https://chatgpt.com" ||
          url.pathname !== "/" ||
          url.searchParams.has("temporary-chat")
        )
          throw new GatewayBrowserError("unavailable");
      }
      return page;
    } catch (error) {
      await page.close();
      throw error;
    }
  }

  async initializeConversation(): Promise<void> {
    const page = await this.surface();
    try {
      const baseline = await this.primitives.baseline(page);
      if (baseline.initialTurnIdentities.length !== 0) throw new GatewayBrowserError("unavailable");
    } finally {
      await page.close();
    }
  }

  async inspectConversation(remoteId: string): Promise<void> {
    const page = await this.surface(remoteId);
    await page.close();
  }

  async send(input: {
    id: string;
    remoteId?: string;
    text: string;
    files: GatewayFile[];
  }): Promise<GatewaySendReceipt> {
    if (this.operation && !this.operation.outcome) return { state: "not_submitted", code: "busy" };
    let page: Page | undefined;
    let activated = false;
    let uploading = false;
    try {
      page = await this.surface(input.remoteId);
      if ((await this.primitives.attachedText(page)) !== "") throw new GatewayBrowserError("busy");
      let baseline = await this.primitives.baseline(page);
      const before = await this.primitives.state(page, baseline);
      if (before.visibleStopButtonCount !== 0) throw new GatewayBrowserError("busy");
      if (input.text) await this.primitives.insert(page, input.text);
      uploading = true;
      await this.primitives.attach(page, input.files);
      uploading = false;
      if (!this.primitives.equivalent(input.text, await this.primitives.attachedText(page)))
        throw new GatewayBrowserError("unavailable");
      // Baseline after upload/hydration prevents remounted history acknowledging Send.
      baseline = await this.primitives.baseline(page, input.text);
      if ((await this.primitives.state(page, baseline)).visibleStopButtonCount !== 0)
        throw new GatewayBrowserError("busy");
      const composer = await this.primitives.composer(page);
      const send = composer
        .locator("xpath=ancestor::form[1]")
        .locator(CHATGPT_SEND_BUTTON_SELECTOR);
      await send.waitFor({ state: "visible", timeout: 20_000 });
      if ((await send.count()) !== 1 || !(await send.isEnabled()))
        throw new GatewayBrowserError("unavailable");
      const operation: Operation = {
        id: input.id,
        page,
        baseline,
        remoteId: input.remoteId,
        tracker: new ChatGptCompletionTracker(),
        markdown: new ChatGptMarkdownBuffer(),
      };
      this.operation = operation;
      activated = true;
      await send.press("Enter", { noWaitAfter: true, timeout: 20_000 });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const state = await this.primitives.state(page, baseline);
        const users = state.userIdentities.filter(
          (id) => !baseline.initialTurnIdentities.includes(id),
        );
        if (users.length > 1) return { state: "unknown" };
        const remoteId = gatewayConversationId(page.url());
        const turnId = users[0];
        if (
          users.length === 1 &&
          turnId &&
          remoteId &&
          (!input.remoteId || input.remoteId === remoteId)
        ) {
          operation.remoteId = remoteId;
          operation.turnId = turnId;
          baseline.acceptedUserIdentity = turnId;
          return { state: "submitted", remoteId, turnId };
        }
        await gatewayDelay(50);
      }
      return { state: "unknown" };
    } catch (error) {
      if (activated) return { state: "unknown" };
      return {
        state: "not_submitted",
        code: uploading
          ? "upload_failed"
          : error instanceof GatewayBrowserError
            ? error.code
            : "unavailable",
      };
    } finally {
      // An ambiguous Send keeps its owned page; closing it would not prove remote termination.
      if (!activated) await page?.close();
    }
  }

  async observe(id: string, turnId: string): Promise<GatewayObservation> {
    const operation = this.operation;
    if (!operation || operation.id !== id || operation.turnId !== turnId)
      return { state: "unknown" };
    if (operation.outcome) return operation.outcome;
    try {
      const { page, baseline } = operation;
      if (!page || !baseline || gatewayConversationId(page.url()) !== operation.remoteId)
        return { state: "unknown" };
      const state = await this.primitives.state(page, baseline);
      const newUsers = state.userIdentities.filter(
        (value) => !baseline.initialTurnIdentities.includes(value),
      );
      if (newUsers.some((value) => value !== operation.turnId)) return { state: "unknown" };
      const responses = state.responseIdentities.filter(
        (value) => !baseline.initialTurnIdentities.includes(value),
      );
      if (responses.length === 0) return { state: "running" };
      const responseId = responses[0];
      if (responses.length !== 1 || !responseId) return { state: "unknown" };
      if (
        operation.turnId.startsWith("group:user:") &&
        responseId !== `group:assistant:${operation.turnId.slice("group:user:".length)}`
      )
        return { state: "unknown" };
      if (operation.responseId && operation.responseId !== responseId) return { state: "unknown" };
      operation.responseId = responseId;
      const locator = page.locator(chatGptAssistantTurnSelector(responseId));
      if ((await withChatGptBrowserObservationTimeout(locator.count())) !== 1)
        return { state: "unknown" };
      const snapshot = await this.primitives.response(locator);
      operation.markdown.observe(snapshot.markdownSegments);
      if (
        !operation.tracker.update({
          responsePresent: snapshot.responsePresent,
          running: state.visibleStopButtonCount > 0,
          currentText: snapshot.visibleText,
          currentHtml: snapshot.fullHtml,
          completionActionVisible: snapshot.completionActionVisible,
        })
      )
        return { state: "running" };
      const final = operation.markdown.finish();
      if (!final.markdown && snapshot.visibleText) return { state: "unknown" };
      operation.outcome = { state: "completed", text: final.markdown, messageId: responseId };
      operation.baseline = undefined;
      operation.page = undefined;
      await page.close();
      return operation.outcome;
    } catch {
      return operation.outcome ?? { state: "unknown" };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.opening?.catch(() => undefined);
    await this.context?.close();
    this.context = undefined;
    this.operation = undefined;
    this.probe = undefined;
  }
}
