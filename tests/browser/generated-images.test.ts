import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSubmission } from "../../src/ports/ChatProvider";
import type { ChatGptWebProvider } from "../../src/providers/chatgpt-web/ChatGptWebProvider";
import { CHATGPT_COMPLETION_SETTLE_MS } from "../../src/providers/chatgpt-web/upstream/src/adapters/chatgpt-web/browser-worker";
import { BrowserFixture, fixtureRemote } from "../fixtures/chatgpt-browser";
import { pngImage } from "../fixtures/generated-image";

describe.skipIf(process.env.TGWEBGPT_BROWSER_TEST !== "1")(
  "generated images in the correlated browser turn",
  () => {
    let root: string, fixture: BrowserFixture, provider: ChatGptWebProvider;
    let releasePreviews: (() => void) | undefined;
    beforeEach(() => {
      releasePreviews = undefined;
      root = mkdtempSync(join(tmpdir(), "tgwebgpt-images-"));
      if (!process.env.TGWEBGPT_TEST_BROWSER) throw new Error("TGWEBGPT_TEST_BROWSER required");
      fixture = new BrowserFixture(join(root, "profile"), process.env.TGWEBGPT_TEST_BROWSER);
      fixture.groupedTurns = true;
      provider = fixture.provider();
    });
    afterEach(async () => {
      releasePreviews?.();
      await provider.close();
      rmSync(root, { recursive: true, force: true });
    });

    async function imageAnswer(
      options: {
        count?: number;
        invalid?: boolean;
        redirect?: boolean;
        running?: boolean;
        actions?: boolean;
        previewFailure?: 404 | 503 | "network";
        holdPreviews?: boolean;
      } = {},
    ) {
      const conversation = await provider.inspectConversation(fixtureRemote);
      const submission = (await provider.send({
        conversationId: conversation.id,
        clientRequestId: "generated",
        text: "synthetic image prompt",
        attachments: [],
      })) as ProviderSubmission;
      expect(submission.state).toBe("submitted");
      const page = fixture.mutationPage;
      const context = fixture.context;
      if (!page || !context) throw new Error("Fixture did not submit a browser turn");
      let downloads = 0;
      const previewStarted = Promise.withResolvers<void>();
      const previewRelease = Promise.withResolvers<void>();
      releasePreviews = () => previewRelease.resolve();
      await context.route("**/backend-api/estuary/content?**", async (route) => {
        if (route.request().resourceType() === "image") {
          previewStarted.resolve();
          if (options.holdPreviews) await previewRelease.promise;
          if (options.previewFailure === "network") {
            await route.abort();
            return;
          }
          if (options.previewFailure) {
            await route.fulfill({
              status: options.previewFailure,
              body: "synthetic preview failure",
            });
            return;
          }
        }
        if (route.request().resourceType() === "fetch") downloads++;
        if (options.redirect && route.request().resourceType() === "fetch")
          await route.fulfill({
            status: 302,
            headers: { location: "https://untrusted.example/image.png" },
          });
        else if (options.invalid && route.request().resourceType() === "fetch")
          await route.fulfill({ contentType: "text/html", body: "private error must not escape" });
        else
          await route.fulfill({
            contentType: "image/png",
            body: Buffer.from(pngImage.base64, "base64"),
          });
      });
      await fixture.finish();
      await page.evaluate(
        ({ count, running, actions }) => {
          const turn = document.querySelector('[data-turn-key="new-user"]');
          if (!turn) throw new Error("Fixture turn missing");
          turn.querySelector(".markdown")?.remove();
          turn
            .querySelectorAll('button[data-testid="copy-turn-action-button"]')
            .forEach((button) => {
              button.remove();
            });
          const userFooter = document.createElement("div");
          userFooter.className = "turn-action-controls";
          userFooter.innerHTML = '<button aria-label="Copy message">user action</button>';
          const gallery = document.createElement("div");
          gallery.dataset.testid = "generated-image-gallery";
          gallery.innerHTML = Array.from(
            { length: count },
            (_, i) =>
              `<button data-testid="generated-image-preview" aria-label="Generated image ${i + 1}"><img alt="Generated image ${i + 1}" src="https://chatgpt.com/backend-api/estuary/content?id=synthetic_${i}"></button>`,
          ).join("");
          turn.append(userFooter, gallery);
          if (actions) {
            const footer = document.createElement("div");
            footer.className = "turn-action-controls";
            footer.innerHTML = '<button aria-label="Copy image">Copy image</button>';
            turn.append(footer);
          }
          if (running) {
            const stop = document.createElement("button");
            stop.dataset.testid = "stop-button";
            stop.textContent = "Stop";
            document.body.append(stop);
          }
          const unrelated = document.createElement("img");
          unrelated.src = "data:image/png;base64,invalid";
          unrelated.alt = "user attachment";
          turn.append(unrelated);
        },
        {
          count: options.count ?? 1,
          running: options.running ?? false,
          actions: options.actions ?? true,
        },
      );
      const settledPreviews = () =>
        page.locator('[data-testid="generated-image-gallery"] img').evaluateAll(async (images) => {
          // Broken previews reject decode; tests assert their native completion/dimensions separately.
          await Promise.allSettled(images.map((image) => (image as HTMLImageElement).decode()));
        });
      if (options.holdPreviews) await previewStarted.promise;
      else await settledPreviews();
      return {
        submission,
        page,
        downloads: () => downloads,
        releasePreviews: async () => {
          previewRelease.resolve();
          await settledPreviews();
        },
      };
    }

    test.each([404, 503, "network"] as const)(
      "P1 broken preview (%s) completes with an explicit file error without UNKNOWN or another prompt",
      async (previewFailure) => {
        const answer = await imageAnswer({ previewFailure });
        const nativeImage = await answer.page
          .locator('[data-testid="generated-image-gallery"] img')
          .evaluate((element) => {
            const image = element as HTMLImageElement;
            return {
              complete: image.complete,
              width: image.naturalWidth,
              height: image.naturalHeight,
            };
          });
        expect(nativeImage).toEqual({ complete: true, width: 0, height: 0 });
        const outcome = await provider.awaitCompletion({
          submission: answer.submission,
          signal: AbortSignal.timeout(5000),
        });
        expect(outcome.state).toBe("completed");
        if (outcome.state === "completed") {
          expect(outcome.message.text).toBe("");
          expect(outcome.message.imageError).toBe("GENERATED_IMAGE_UNAVAILABLE");
          expect(outcome.message.images).toBeUndefined();
          expect(JSON.stringify(outcome)).not.toContain("backend-api");
        }
        expect(await provider.inspectRequest(answer.submission)).toEqual(outcome);
        expect(answer.downloads()).toBe(0);
        expect(fixture.submissions).toHaveLength(1);
      },
      30000,
    );

    test("an in-flight preview with final controls remains running until its browser load settles", async () => {
      const answer = await imageAnswer({ holdPreviews: true });
      expect((await provider.inspectRequest(answer.submission)).state).toBe("running");
      await Bun.sleep(CHATGPT_COMPLETION_SETTLE_MS + 100);
      expect((await provider.inspectRequest(answer.submission)).state).toBe("running");
      expect(answer.downloads()).toBe(0);
      await answer.releasePreviews();
      const outcome = await provider.awaitCompletion({
        submission: answer.submission,
        signal: AbortSignal.timeout(5000),
      });
      expect(outcome.state).toBe("completed");
      if (outcome.state === "completed") expect(outcome.message.images).toEqual([pngImage]);
      expect(answer.downloads()).toBe(1);
      expect(fixture.submissions).toHaveLength(1);
    }, 30000);

    test("an empty image source is still a placeholder, not a failed preview", async () => {
      const answer = await imageAnswer();
      await answer.page
        .locator('[data-testid="generated-image-gallery"] img')
        .evaluate((image) => image.removeAttribute("src"));
      expect((await provider.inspectRequest(answer.submission)).state).toBe("running");
      await Bun.sleep(CHATGPT_COMPLETION_SETTLE_MS + 100);
      expect(
        await answer.page
          .locator('[data-testid="generated-image-gallery"] img')
          .evaluate((element) => {
            const image = element as HTMLImageElement;
            return {
              complete: image.complete,
              source: image.currentSrc,
              width: image.naturalWidth,
            };
          }),
      ).toEqual({ complete: true, source: "", width: 0 });
      expect((await provider.inspectRequest(answer.submission)).state).toBe("running");
      expect(answer.downloads()).toBe(0);
      expect(fixture.submissions).toHaveLength(1);
    }, 30000);

    test("a broken preview still requires no Stop and final controls after the gallery", async () => {
      const answer = await imageAnswer({ previewFailure: 404, running: true });
      expect((await provider.inspectRequest(answer.submission)).state).toBe("running");
      await Bun.sleep(CHATGPT_COMPLETION_SETTLE_MS + 100);
      expect((await provider.inspectRequest(answer.submission)).state).toBe("running");
      await answer.page.evaluate(() => {
        document.querySelector('[data-testid="stop-button"]')?.remove();
        document.querySelector('button[aria-label="Copy image"]')?.parentElement?.remove();
      });
      expect((await provider.inspectRequest(answer.submission)).state).toBe("running");
      await Bun.sleep(CHATGPT_COMPLETION_SETTLE_MS + 100);
      expect((await provider.inspectRequest(answer.submission)).state).toBe("running");
      expect(answer.downloads()).toBe(0);
      await answer.page.evaluate(() => {
        const turn = document.querySelector('[data-turn-key="new-user"]');
        if (!turn) throw new Error("Fixture turn missing");
        const footer = document.createElement("div");
        footer.className = "turn-action-controls";
        footer.innerHTML = '<button aria-label="Copy image">Copy image</button>';
        turn.append(footer);
      });
      const outcome = await provider.awaitCompletion({
        submission: answer.submission,
        signal: AbortSignal.timeout(5000),
      });
      expect(outcome.state).toBe("completed");
      if (outcome.state === "completed")
        expect(outcome.message.imageError).toBe("GENERATED_IMAGE_UNAVAILABLE");
      expect(answer.downloads()).toBe(0);
      expect(fixture.submissions).toHaveLength(1);
    }, 30000);

    test("image-only completion waits for generation and final controls, then returns original bytes once", async () => {
      const answer = await imageAnswer({ running: true });
      expect((await provider.inspectRequest(answer.submission)).state).toBe("running");
      expect(answer.downloads()).toBe(0);
      await answer.page
        .locator('[data-testid="stop-button"]')
        .evaluate((button) => button.remove());
      const outcome = await provider.awaitCompletion({
        submission: answer.submission,
        signal: AbortSignal.timeout(10000),
      });
      expect(outcome.state).toBe("completed");
      if (outcome.state === "completed") {
        expect(outcome.message.text).toBe("");
        expect(outcome.message.images).toEqual([pngImage]);
        expect(outcome.message.imageError).toBeUndefined();
        expect(JSON.stringify(outcome)).not.toContain("backend-api");
      }
      expect(answer.downloads()).toBe(1);
      expect((await provider.inspectRequest(answer.submission)).state).toBe("completed");
      expect(answer.downloads()).toBe(1);
      expect(fixture.submissions).toHaveLength(1);
    }, 30000);

    test("the user's preceding footer and a loaded image alone do not prove completion", async () => {
      const answer = await imageAnswer({ actions: false });
      expect((await provider.inspectRequest(answer.submission)).state).toBe("running");
      await Bun.sleep(CHATGPT_COMPLETION_SETTLE_MS + 100);
      expect((await provider.inspectRequest(answer.submission)).state).toBe("running");
      expect(answer.downloads()).toBe(0);
    }, 30000);

    test("multiple images preserve gallery order and exclude unrelated user images", async () => {
      const answer = await imageAnswer({ count: 2 });
      const outcome = await provider.awaitCompletion({
        submission: answer.submission,
        signal: AbortSignal.timeout(10000),
      });
      expect(outcome.state).toBe("completed");
      if (outcome.state === "completed")
        expect(outcome.message.images).toEqual([pngImage, pngImage]);
      expect(answer.downloads()).toBe(2);
      expect(fixture.submissions).toHaveLength(1);
    }, 30000);

    test("a completed text footer before the gallery cannot finish mixed text/image output", async () => {
      const answer = await imageAnswer({ actions: false });
      await answer.page.evaluate(() => {
        const assistant = document.querySelector(
          '[data-turn-key="new-user"] [data-conversation-role="assistant"]',
        );
        if (!assistant) throw new Error("Fixture assistant missing");
        const text = document.createElement("div");
        text.className = "markdown";
        text.innerHTML = "<p>Generated image caption</p>";
        assistant.append(text);
      });
      expect((await provider.inspectRequest(answer.submission)).state).toBe("running");
      await Bun.sleep(CHATGPT_COMPLETION_SETTLE_MS + 100);
      expect((await provider.inspectRequest(answer.submission)).state).toBe("running");
      expect(answer.downloads()).toBe(0);
      await answer.page.evaluate(() => {
        const turn = document.querySelector('[data-turn-key="new-user"]');
        if (!turn) throw new Error("Fixture turn missing");
        const footer = document.createElement("div");
        footer.className = "turn-action-controls";
        footer.innerHTML = '<button aria-label="Copy image">Copy image</button>';
        turn.append(footer);
      });
      const outcome = await provider.awaitCompletion({
        submission: answer.submission,
        signal: AbortSignal.timeout(10000),
      });
      expect(outcome.state).toBe("completed");
      if (outcome.state === "completed") {
        expect(outcome.message.text).toContain("Generated image caption");
        expect(outcome.message.images).toEqual([pngImage]);
        expect(JSON.stringify(outcome)).not.toContain("backend-api");
      }
      expect(fixture.submissions).toHaveLength(1);
    }, 30000);

    test.each([{ invalid: true }, { redirect: true }, { count: 5 }])(
      "known completed image with %j reports bounded retrieval failure without UNKNOWN or another prompt",
      async (options) => {
        const answer = await imageAnswer(options);
        const outcome = await provider.awaitCompletion({
          submission: answer.submission,
          signal: AbortSignal.timeout(10000),
        });
        expect(outcome.state).toBe("completed");
        if (outcome.state === "completed") {
          expect(outcome.message.imageError).toBe(
            options.count ? "GENERATED_IMAGE_LIMIT" : "GENERATED_IMAGE_UNAVAILABLE",
          );
          expect(outcome.message.images).toBeUndefined();
        }
        expect(fixture.submissions).toHaveLength(1);
        expect(fixture.network.some((url) => url.includes("untrusted.example"))).toBe(false);
      },
      30000,
    );
  },
);
