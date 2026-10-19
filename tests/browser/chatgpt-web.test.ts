import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { loadConfig } from "../../src/config/Config";
import { createLogger } from "../../src/logging/logger";
import { privateChatPolicy } from "../../src/main";
import { openDatabase } from "../../src/persistence/sqlite/Database";
import { runGateway } from "../../src/runtime/GatewayRuntime";
import type { ProviderSubmission } from "../../src/ports/ChatProvider";
import type { ChatGptWebProvider } from "../../src/providers/chatgpt-web/ChatGptWebProvider";
import { LocalAttachmentStore } from "../../src/storage/LocalAttachmentStore";
import { BrowserFixture, fixtureRemote } from "../fixtures/chatgpt-browser";
import { FakeTelegramApi, update } from "../fixtures/telegram";

// Explicit local-browser profile; every URL is intercepted. This is never live ChatGPT evidence.
describe.skipIf(process.env.TGWEBGPT_BROWSER_TEST !== "1")(
  "R6 fork with real Chromium and synthetic ChatGPT DOM",
  () => {
    let root: string;
    let fixture: BrowserFixture;
    let provider: ChatGptWebProvider;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "tgwebgpt-r6-browser-"));
      if (!process.env.TGWEBGPT_TEST_BROWSER) throw new Error("TGWEBGPT_TEST_BROWSER required");
      fixture = new BrowserFixture(join(root, "profile"), process.env.TGWEBGPT_TEST_BROWSER);
      provider = fixture.provider();
    });
    afterEach(async () => {
      await provider.close();
      rmSync(root, { recursive: true, force: true });
    });

    test("AUTH_REQUIRED differs from malformed/unreachable session and health submits nothing", async () => {
      fixture.auth = "missing";
      expect((await provider.health()).state).toBe("auth_required");
      expect(fixture.launchOptions?.ignoreDefaultArgs).toEqual([
        "--password-store=basic",
        "--use-mock-keychain",
      ]);
      await expect(provider.createConversation()).rejects.toThrow("AUTH_REQUIRED");
      fixture.auth = "malformed";
      expect((await provider.health()).state).toBe("unavailable");
      expect(fixture.submissions).toHaveLength(0);
      expect(fixture.uploads).toBe(0);
    });

    test("browser profile preserves only synthetic authentication through a real browser restart", async () => {
      fixture.auth = "cookie";
      expect((await provider.health()).state).toBe("auth_required");
      if (!fixture.context) throw new Error("Fixture browser did not start");
      await fixture.context.addCookies([
        {
          name: "gateway_fixture_auth",
          value: "synthetic",
          domain: "chatgpt.com",
          path: "/",
          expires: Date.now() / 1000 + 3600,
        },
      ]);
      expect((await provider.health()).state).toBe("ready");
      await provider.close();
      provider = fixture.provider();
      expect((await provider.health()).state).toBe("ready");
      expect(fixture.submissions).toHaveLength(0);
    });

    test("existing/new aliases converge, native PDF bytes upload once, partial text is not completion", async () => {
      const store = new LocalAttachmentStore(join(root, "files"));
      await store.initialize();
      await provider.close();
      provider = fixture.provider(store);
      const created = await provider.createConversation();
      const caption = "\nexact\ncaption";
      const bytes = Buffer.from("%PDF-1.4\nsynthetic\n%%EOF");
      const file = await store.put(
        (async function* () {
          yield bytes;
        })(),
        100,
      );
      const submission = (await provider.send({
        conversationId: created.id,
        clientRequestId: "roundtrip",
        text: caption,
        attachments: [
          {
            storageKey: file.key,
            filename: "input.pdf",
            mimeType: "application/pdf",
            sizeBytes: bytes.length,
          },
        ],
      })) as ProviderSubmission;
      expect(submission.state).toBe("submitted");
      expect(submission.providerRequestId).toBe("new-user");
      expect(fixture.submissions).toEqual([
        {
          text: caption,
          path: "/",
          files: [
            { name: "input.pdf", mimeType: "application/pdf", base64: bytes.toString("base64") },
          ],
        },
      ]);
      expect(fixture.uploads).toBe(1);
      expect((await provider.inspectRequest(submission)).state).toBe("running");
      const aborted = new AbortController();
      const waiting = provider.awaitCompletion({ submission, signal: aborted.signal });
      aborted.abort();
      expect((await waiting).state).toBe("unknown");
      expect((await provider.inspectRequest(submission)).state).toBe("running");
      expect((await provider.inspectConversation(fixtureRemote)).id).toBe(created.id);
      await fixture.finish();
      const outcome = await provider.awaitCompletion({
        submission,
        signal: AbortSignal.timeout(10_000),
      });
      expect(outcome.state).toBe("completed");
      if (outcome.state === "completed") {
        expect(outcome.message.text).toContain("final answer");
        expect(outcome.message.text).toContain("const x = 1;");
        expect(outcome.message.text).not.toContain("old answer");
      }
      expect(fixture.submissions).toHaveLength(1);
      file.release();
    }, 30_000);

    test.each([
      ["PDF", "application/pdf", "input.pdf", Buffer.from("%PDF-1.4\nsynthetic\n%%EOF")],
      ["JPEG", "image/jpeg", "input.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    ] as const)(
      "captionless %s binds the logical group and completes exactly once",
      async (_, mimeType, filename, bytes) => {
        const store = new LocalAttachmentStore(join(root, "files"));
        await store.initialize();
        await provider.close();
        fixture.groupedTurns = true;
        provider = fixture.provider(store);
        const stored = await store.put(
          (async function* () {
            yield bytes;
          })(),
          100,
        );
        try {
          const existing = await provider.inspectConversation(fixtureRemote);
          const submission = (await provider.send({
            conversationId: existing.id,
            clientRequestId: "captionless-file",
            attachments: [{ storageKey: stored.key, filename, mimeType, sizeBytes: bytes.length }],
          })) as ProviderSubmission;
          expect(submission.state).toBe("submitted");
          expect(submission.providerRequestId).toBe("group:user:new-user");
          expect(
            await fixture.mutationPage
              ?.locator('[data-turn-key="new-user"] [data-user-message-bubble]')
              .count(),
          ).toBe(0);
          expect(fixture.submissions).toEqual([
            {
              text: "",
              path: `/c/${fixtureRemote}`,
              files: [{ name: filename, mimeType, base64: bytes.toString("base64") }],
            },
          ]);
          expect((await provider.inspectRequest(submission)).state).toBe("running");
          await fixture.finish();
          const outcome = await provider.awaitCompletion({
            submission,
            signal: AbortSignal.timeout(10_000),
          });
          expect(outcome.state).toBe("completed");
          if (outcome.state === "completed") {
            expect(outcome.message.id).toBe("group:assistant:new-user");
            expect(outcome.message.text).toContain("final answer");
            expect(outcome.message.text).not.toContain("old answer");
          }
          expect(fixture.uploads).toBe(1);
          expect(fixture.submissions).toHaveLength(1);
        } finally {
          stored.release();
        }
      },
      40_000,
    );

    test("a foreign captionless group cannot complete the bound request", async () => {
      fixture.groupedTurns = true;
      const existing = await provider.inspectConversation(fixtureRemote);
      const submission = (await provider.send({
        conversationId: existing.id,
        clientRequestId: "grouped-foreign",
        text: "only mine",
        attachments: [],
      })) as ProviderSubmission;
      expect(submission.state).toBe("submitted");
      await fixture.foreignTurn();
      await fixture.finish();
      expect((await provider.inspectRequest(submission)).state).toBe("unknown");
      expect(fixture.submissions).toHaveLength(1);
    }, 30_000);

    test("duplicate filenames preserve both file payloads and produce one completed Send", async () => {
      const store = new LocalAttachmentStore(join(root, "files"));
      await store.initialize();
      await provider.close();
      provider = fixture.provider(store);
      const files = [];
      for (const text of ["%PDF-1.4\nfirst\n%%EOF", "%PDF-1.4\nsecond\n%%EOF"]) {
        const bytes = Buffer.from(text);
        const stored = await store.put(
          (async function* () {
            yield bytes;
          })(),
          100,
        );
        files.push({ bytes, stored });
      }
      try {
        const created = await provider.createConversation();
        const submission = (await provider.send({
          conversationId: created.id,
          clientRequestId: "duplicate-filenames",
          text: "two files, same name",
          attachments: files.map(({ bytes, stored }) => ({
            storageKey: stored.key,
            filename: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: bytes.length,
          })),
        })) as ProviderSubmission;
        expect(submission.state).toBe("submitted");
        expect(fixture.uploads).toBe(1);
        expect(fixture.submissions).toEqual([
          {
            text: "two files, same name",
            path: "/",
            files: files.map(({ bytes }) => ({
              name: "report.pdf",
              mimeType: "application/pdf",
              base64: bytes.toString("base64"),
            })),
          },
        ]);
        expect(
          await fixture.mutationPage
            ?.getByRole("group", { name: "report.pdf", exact: true })
            .count(),
        ).toBe(2);
        await fixture.finish();
        expect(
          (
            await provider.awaitCompletion({
              submission,
              signal: AbortSignal.timeout(10_000),
            })
          ).state,
        ).toBe("completed");
        expect(fixture.submissions).toHaveLength(1);
      } finally {
        for (const { stored } of files) stored.release();
      }
    }, 30_000);

    test("one chip with two UI representations waits for the second same-name file", async () => {
      const store = new LocalAttachmentStore(join(root, "files"));
      await store.initialize();
      await provider.close();
      provider = fixture.provider(store);
      fixture.uploadChipLimit = 1;
      fixture.nestedUploadSurface = true;
      const uploaded = new Promise<Page>((resolve) => {
        fixture.onUpload = resolve;
      });
      const files = [];
      for (const text of ["first", "second"]) {
        const bytes = Buffer.from(text);
        const stored = await store.put(
          (async function* () {
            yield bytes;
          })(),
          100,
        );
        files.push({ bytes, stored });
      }
      try {
        const conversation = await provider.createConversation();
        const sending = provider.send({
          conversationId: conversation.id,
          clientRequestId: "incomplete-duplicate-chips",
          text: "two files required",
          attachments: files.map(({ bytes, stored }) => ({
            storageKey: stored.key,
            filename: "report.txt",
            mimeType: "text/plain",
            sizeBytes: bytes.length,
          })),
        });
        const page = await uploaded;
        const groups = page.getByRole("group", { name: "report.txt", exact: true });
        await groups.first().waitFor({ state: "visible" });
        expect(await groups.count()).toBe(1);
        expect(await page.locator(".composer-attachment-surface").count()).toBe(1);
        expect(
          await page
            .locator('input[type="file"]')
            .evaluate((input) => (input as HTMLInputElement).files?.length),
        ).toBe(2);
        // A single chip in both UI representations must not acknowledge both file payloads.
        await Bun.sleep(250);
        expect(fixture.submissions).toHaveLength(0);
        await page.evaluate(() => {
          const chip = document.querySelector('#uploads [role="group"]');
          if (!chip?.parentElement) throw new Error("Fixture attachment chip missing");
          chip.parentElement.append(chip.cloneNode(true));
        });
        const submission = (await sending) as ProviderSubmission;
        expect(submission.state).toBe("submitted");
        expect(fixture.submissions).toHaveLength(1);
        await fixture.finish();
        expect(
          (await provider.awaitCompletion({ submission, signal: AbortSignal.timeout(10_000) }))
            .state,
        ).toBe("completed");
      } finally {
        for (const { stored } of files) stored.release();
      }
    }, 30_000);

    test("inaccessible conversations are rejected and a foreign new turn cannot complete this request", async () => {
      await expect(
        provider.inspectConversation("00000000-0000-4000-8000-000000000099"),
      ).rejects.toThrow("CHAT_NOT_FOUND");
      const existing = await provider.inspectConversation(fixtureRemote);
      const submission = (await provider.send({
        conversationId: existing.id,
        clientRequestId: "foreign",
        text: "only mine",
        attachments: [],
      })) as ProviderSubmission;
      expect(submission.state).toBe("submitted");
      expect(fixture.submissions[0]?.path).toBe(`/c/${fixtureRemote}`);
      await fixture.foreignTurn();
      await fixture.finish();
      expect((await provider.inspectRequest(submission)).state).toBe("unknown");
      expect(fixture.submissions).toHaveLength(1);
    }, 30_000);

    test("loss after physical Send is UNKNOWN and is never resent", async () => {
      fixture.dropAfterSubmit = true;
      const existing = await provider.inspectConversation(fixtureRemote);
      const input = {
        conversationId: existing.id,
        clientRequestId: "lost",
        text: "submit once",
        attachments: [],
      };
      expect((await provider.send(input)).state).toBe("unknown");
      expect((await provider.send(input)).state).toBe("unknown");
      expect(fixture.submissions).toHaveLength(1);
    }, 30_000);

    test("upload interruption is proven pre-submit and does not create a prompt", async () => {
      const store = new LocalAttachmentStore(join(root, "files"));
      await store.initialize();
      await provider.close();
      provider = fixture.provider(store);
      fixture.failUpload = true;
      const stored = await store.put(
        (async function* () {
          yield Buffer.from("synthetic source");
        })(),
        100,
      );
      const conversation = await provider.createConversation();
      const result = await provider.send({
        conversationId: conversation.id,
        clientRequestId: "upload",
        text: "caption",
        attachments: [
          { storageKey: stored.key, filename: "input.txt", mimeType: "text/plain", sizeBytes: 16 },
        ],
      });
      expect(result).toMatchObject({ state: "not_submitted", code: "UPLOAD_FAILED" });
      expect(fixture.uploads).toBe(1);
      expect(fixture.submissions).toHaveLength(0);
      stored.release();
    }, 30_000);

    test("Telegram ingress uses the same queue, fork, durable completion and response path", async () => {
      fixture.autoComplete = true;
      const config = loadConfig({
        TELEGRAM_BOT_TOKEN: "123456789:R6_SYNTHETIC",
        TELEGRAM_ALLOWED_USER_IDS: "123",
        DATABASE_PATH: join(root, "gateway.sqlite"),
        BROWSER_PROFILE_DIR: fixture.profileDir,
        ATTACHMENT_TEMP_DIR: join(root, "files"),
      });
      const api = new FakeTelegramApi();
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 15_000);
      let polls = 0;
      api.getUpdates = async (_offset, signal) => {
        if (++polls === 1)
          return [
            update(1, "/new coding"),
            update(2, "exact Telegram prompt"),
            update(2, "exact Telegram prompt"),
          ];
        return new Promise((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      };
      api.sendFailure = (message) => {
        if (message.parseMode === "HTML") controller.abort();
        return undefined;
      };
      const logs: string[] = [];
      try {
        await runGateway({
          config,
          api,
          provider,
          providerLabel: "R6 synthetic browser fixture",
          chatPolicy: privateChatPolicy,
          signal: controller.signal,
          log: createLogger({ sink: (line) => logs.push(line) }),
        });
      } finally {
        clearTimeout(deadline);
      }
      expect(fixture.submissions).toHaveLength(1);
      expect(fixture.submissions[0]?.text).toBe("exact Telegram prompt");
      expect(
        api.sent.some(
          (message) => message.parseMode === "HTML" && message.text.includes("final answer"),
        ),
      ).toBe(true);
      const database = openDatabase(config.database.path);
      try {
        expect(database.query("SELECT state FROM requests").all()).toEqual([
          { state: "completed" },
        ]);
        expect(database.query("SELECT COUNT(*) AS count FROM request_inputs").get()).toEqual({
          count: 0,
        });
        expect(database.query("SELECT COUNT(*) AS count FROM processed_updates").get()).toEqual({
          count: 2,
        });
      } finally {
        database.close(true);
      }
      expect(logs.join("")).not.toContain("exact Telegram prompt");
      expect(logs.join("")).not.toContain("final answer");
      expect(logs.join("")).not.toContain("R6_SYNTHETIC");
    }, 30_000);
  },
);
