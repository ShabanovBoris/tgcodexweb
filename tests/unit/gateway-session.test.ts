import { afterEach, expect, spyOn, test } from "bun:test";
import type { BrowserContext, Locator, Page } from "playwright-core";
import {
  GatewayBrowserSession,
  type GatewayPrimitives,
} from "../../src/providers/chatgpt-web/upstream/src/adapters/chatgpt-web/gateway-session";
import type { ChatGptSubmissionDomState } from "../../src/providers/chatgpt-web/upstream/src/adapters/chatgpt-web/browser-worker";

const remote = "00000000-0000-4000-8000-000000000001";
const originalNow = Date.now;
afterEach(() => {
  Date.now = originalNow;
});

function fixture(
  mode: "receipt" | "no_receipt" | "foreign" | "single_foreign" | "unreadable",
  pressFails = true,
) {
  let activated = false,
    presses = 0,
    readsAfterActivation = 0,
    responseReads = 0,
    clock = 0;
  spyOn(Date, "now").mockImplementation(() => clock);
  const initial = ["group:user:old", "group:assistant:old"];
  const send = {
    waitFor: async () => {},
    count: async () => 1,
    isEnabled: async () => true,
    press: async () => {
      presses++;
      activated = true;
      if (pressFails) throw new Error("private token and browser details");
    },
  } as unknown as Locator;
  const form = { locator: () => send } as unknown as Locator;
  const composer = { locator: () => form } as unknown as Locator;
  const page = {
    goto: async () => ({ status: () => 200 }),
    url: () => `https://chatgpt.com/c/${remote}`,
    evaluate: async () => ({ sessionAuthenticated: true }),
    locator: () => ({ count: async () => 1 }),
    close: async () => {},
  } as unknown as Page;
  const context = {
    newPage: async () => page,
    setDefaultTimeout: () => {},
    on: () => {},
    close: async () => {},
  } as unknown as BrowserContext;
  const primitives: GatewayPrimitives = {
    composer: async () => composer,
    baseline: async () => ({
      userTurns: composer,
      responseTurns: composer,
      initialTurnIdentities: initial,
      domCache: {},
    }),
    state: async () => {
      const state: ChatGptSubmissionDomState = {
        userTurnCount: 0,
        assistantTurnCount: 0,
        visibleStopButtonCount: 0,
        turnIdentities: initial,
        userIdentities: [],
        responseIdentities: [],
      };
      if (!activated) return state;
      readsAfterActivation++;
      if (mode === "unreadable") throw new Error("private observation details");
      if (mode === "no_receipt") {
        clock = 20001;
        return state;
      }
      const users =
        mode === "foreign"
          ? ["group:user:new", "group:user:foreign"]
          : mode === "single_foreign"
            ? ["group:user:foreign"]
            : ["group:user:new"];
      const responses = mode === "single_foreign" ? ["group:assistant:foreign"] : [];
      return {
        ...state,
        turnIdentities: [...initial, ...users, ...responses],
        responseIdentities: responses,
      };
    },
    attachedText: async () => "",
    equivalent: () => true,
    insert: async () => {},
    attach: async () => {},
    response: async () => {
      responseReads++;
      return {
        responsePresent: true,
        visibleText: "foreign answer",
        fullHtml: "<p>foreign answer</p>",
        markdownSegments: [
          {
            key: "foreign",
            tag: "p",
            html: "<p>foreign answer</p>",
            text: "foreign answer",
            streamable: false,
          },
        ],
        completionActionVisible: true,
        stoppedThinkingVisible: false,
        traceBlocks: [],
      };
    },
  };
  const session = new GatewayBrowserSession(
    { profileDir: "synthetic-unused-profile", launch: async () => context },
    primitives,
  );
  return { session, counts: () => ({ presses, readsAfterActivation, responseReads }) };
}

test("an Enter error before dispatch cannot adopt a sole foreign turn", async () => {
  const { session, counts } = fixture("single_foreign");
  try {
    const result = await session.send({
      id: "r1",
      remoteId: remote,
      text: "own prompt",
      files: [],
    });
    expect(result).toEqual({ state: "unknown", reason: "send_activation_unconfirmed" });
    expect(await session.observe("r1", "group:user:foreign")).toEqual({ state: "unknown" });
    expect(
      (await session.send({ id: "r1", remoteId: remote, text: "own prompt", files: [] })).state,
    ).toBe("not_submitted");
    expect(counts()).toEqual({ presses: 1, readsAfterActivation: 0, responseReads: 0 });
  } finally {
    await session.close();
  }
});

test("a successful Enter still accepts the new-turn receipt", async () => {
  const { session, counts } = fixture("receipt", false);
  try {
    expect(await session.send({ id: "r1", remoteId: remote, text: "", files: [] })).toMatchObject({
      state: "submitted",
      remoteId: remote,
      turnId: "group:user:new",
    });
    expect(counts()).toEqual({ presses: 1, readsAfterActivation: 1, responseReads: 0 });
  } finally {
    await session.close();
  }
});

test.each(["receipt", "no_receipt", "foreign", "unreadable"] as const)(
  "a Send action error with %s evidence remains UNKNOWN and is never activated twice",
  async (mode) => {
    const { session, counts } = fixture(mode);
    try {
      const result = await session.send({ id: "r1", remoteId: remote, text: "", files: [] });
      expect(result).toEqual({ state: "unknown", reason: "send_activation_unconfirmed" });
      expect(JSON.stringify(result)).not.toContain("private");
      expect((await session.send({ id: "r1", remoteId: remote, text: "", files: [] })).state).toBe(
        "not_submitted",
      );
      expect(counts()).toEqual({ presses: 1, readsAfterActivation: 0, responseReads: 0 });
    } finally {
      await session.close();
    }
  },
);

test.each([
  ["no_receipt", "submission_ack_timeout"],
  ["foreign", "multiple_new_user_turns"],
  ["unreadable", "submission_observation_failed"],
] as const)("successful Enter with %s evidence remains UNKNOWN", async (mode, reason) => {
  const { session, counts } = fixture(mode, false);
  try {
    expect(await session.send({ id: "r1", remoteId: remote, text: "", files: [] })).toEqual({
      state: "unknown",
      reason,
    });
    expect(counts().presses).toBe(1);
    expect(counts().readsAfterActivation).toBeGreaterThan(0);
  } finally {
    await session.close();
  }
});
