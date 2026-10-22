import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatGptWebProvider } from "../../src/providers/chatgpt-web/ChatGptWebProvider";
import { BrowserFixture, fixtureRemote } from "../fixtures/chatgpt-browser";

describe.skipIf(process.env.TGWEBGPT_BROWSER_TEST !== "1")(
  "composer preparation and owned draft cleanup",
  () => {
    let root: string, fixture: BrowserFixture, provider: ChatGptWebProvider;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "tgwebgpt-preparation-"));
      if (!process.env.TGWEBGPT_TEST_BROWSER) throw new Error("TGWEBGPT_TEST_BROWSER required");
      fixture = new BrowserFixture(join(root, "profile"), process.env.TGWEBGPT_TEST_BROWSER);
      provider = fixture.provider();
    });
    afterEach(async () => {
      await provider.close();
      rmSync(root, { recursive: true, force: true });
    });

    test("delayed editor readiness submits the exact prompt once", async () => {
      fixture.sendReadyDelayMs = 350;
      const conversation = await provider.inspectConversation(fixtureRemote);
      expect(
        await provider.send({
          conversationId: conversation.id,
          clientRequestId: "delayed",
          text: "synthetic image prompt",
          attachments: [],
        }),
      ).toMatchObject({ state: "submitted" });
      expect(fixture.submissions).toHaveLength(1);
      expect(fixture.submissions[0].text).toBe("synthetic image prompt");
    }, 30000);

    test("markdown editor hydration finishes before inserting the prompt", async () => {
      fixture.composerHydrationDelayMs = 700;
      const conversation = await provider.inspectConversation(fixtureRemote);
      expect(
        await provider.send({
          conversationId: conversation.id,
          clientRequestId: "hydration",
          text: "synthetic prompt after hydration",
          attachments: [],
        }),
      ).toMatchObject({ state: "submitted" });
      expect(fixture.submissions).toHaveLength(1);
      expect(fixture.submissions[0].text).toBe("synthetic prompt after hydration");
    }, 30000);

    test("a rejected preparation leaves no saved draft and a different request can submit", async () => {
      fixture.persistDraft = true;
      fixture.invalidSendAfterInsert = true;
      const conversation = await provider.inspectConversation(fixtureRemote);
      expect(
        await provider.send({
          conversationId: conversation.id,
          clientRequestId: "rejected",
          text: "synthetic failed prompt",
          attachments: [],
        }),
      ).toMatchObject({ state: "not_submitted", code: "PROVIDER_UNAVAILABLE" });
      expect(fixture.submissions).toHaveLength(0);
      if (!fixture.context) throw new Error("Fixture browser missing");
      const page = await fixture.context.newPage();
      await page.goto(`https://chatgpt.com/c/${fixtureRemote}`);
      expect(await page.locator("#prompt-textarea").textContent()).toBe("");
      expect(
        await page.evaluate(() =>
          localStorage.getItem(`gateway-fixture-draft:${location.pathname}`),
        ),
      ).toBe("");
      await page.close();

      fixture.invalidSendAfterInsert = false;
      expect(
        await provider.send({
          conversationId: conversation.id,
          clientRequestId: "different-request",
          text: "different synthetic prompt",
          attachments: [],
        }),
      ).toMatchObject({ state: "submitted" });
      expect(fixture.submissions).toHaveLength(1);
      expect(fixture.submissions[0].text).toBe("different synthetic prompt");
    }, 30000);
  },
);
