import { afterEach, expect, test } from "bun:test";
import type { BrowserContext, Locator, Page } from "playwright-core";
import {
  GatewayBrowserSession,
  type GatewayPrimitives,
} from "../../src/providers/chatgpt-web/upstream/src/adapters/chatgpt-web/gateway-session";

const remote = "00000000-0000-4000-8000-000000000001";
const originalNow = Date.now;
afterEach(() => {
  Date.now = originalNow;
});

function fixture(
  options: {
    enabledAfter?: number;
    expire?: boolean;
    initial?: string;
    foreignEdit?: boolean;
    activationError?: boolean;
    stopAfterInsert?: boolean;
  } = {},
) {
  let clock = 0,
    value = options.initial ?? "",
    activated = false;
  const counts = { presses: 0, enabledChecks: 0, inserts: 0, clears: 0, closes: 0 };
  Date.now = () => (clock += options.expire ? 11_000 : 1);
  const send = {
    waitFor: async () => {},
    count: async () => 1,
    isEnabled: async () => ++counts.enabledChecks >= (options.enabledAfter ?? 1),
    press: async () => {
      counts.presses++;
      if (options.activationError) throw new Error("private native details");
      activated = true;
    },
  } as unknown as Locator;
  const form = { locator: () => send } as unknown as Locator;
  const composer = { locator: () => form } as unknown as Locator;
  const page = {
    goto: async () => ({ status: () => 200 }),
    url: () => `https://chatgpt.com/c/${remote}`,
    evaluate: async () => ({ sessionAuthenticated: true }),
    close: async () => {
      counts.closes++;
    },
  } as unknown as Page;
  const context = {
    newPage: async () => page,
    setDefaultTimeout: () => {},
    on: () => {},
    close: async () => {},
  } as unknown as BrowserContext;
  const initial = ["group:user:old", "group:assistant:old"];
  const primitives: GatewayPrimitives = {
    composer: async () => composer,
    baseline: async () => ({
      userTurns: composer,
      responseTurns: composer,
      initialTurnIdentities: initial,
      domCache: {},
    }),
    state: async () => ({
      userTurnCount: 0,
      assistantTurnCount: 0,
      visibleStopButtonCount: options.stopAfterInsert && counts.inserts ? 1 : 0,
      turnIdentities: activated ? [...initial, "group:user:new"] : initial,
      userIdentities: [],
      responseIdentities: [],
    }),
    attachedText: async () => value,
    equivalent: (expected, observed) => expected === observed,
    insert: async (_page, text) => {
      counts.inserts++;
      value = options.foreignEdit ? "another editor's draft" : text;
    },
    clear: async () => {
      counts.clears++;
      value = "";
    },
    attach: async () => {},
    response: async () => {
      throw new Error("No result observation during preparation");
    },
  };
  const session = new GatewayBrowserSession(
    { profileDir: "synthetic-unused-profile", launch: async () => context },
    primitives,
  );
  return {
    session,
    counts,
    value: () => value,
    enable: () => {
      options.enabledAfter = 1;
      options.expire = false;
    },
  };
}

test("composer hydration can enable Send later without another insertion or activation", async () => {
  const f = fixture({ enabledAfter: 3 });
  try {
    expect(
      await f.session.send({ id: "r1", remoteId: remote, text: "own prompt", files: [] }),
    ).toMatchObject({ state: "submitted" });
    expect(f.counts).toMatchObject({ presses: 1, inserts: 1, clears: 0 });
    expect(f.counts.enabledChecks).toBeGreaterThanOrEqual(3);
  } finally {
    await f.session.close();
  }
});

test("a pre-Send readiness failure clears only the owned plain draft so a new request can prepare", async () => {
  const f = fixture({ enabledAfter: Infinity, expire: true });
  try {
    expect(
      await f.session.send({ id: "r1", remoteId: remote, text: "own prompt", files: [] }),
    ).toEqual({ state: "not_submitted", code: "unavailable" });
    expect(f.counts).toMatchObject({ presses: 0, inserts: 1, clears: 1, closes: 1 });
    expect(f.value()).toBe("");
    f.enable();
    expect(
      await f.session.send({ id: "r2", remoteId: remote, text: "new prompt", files: [] }),
    ).toMatchObject({ state: "submitted" });
    expect(f.counts.presses).toBe(1);
  } finally {
    await f.session.close();
  }
});

test("a pre-existing draft is preserved even when its text matches the new request", async () => {
  const f = fixture({ initial: "own prompt" });
  try {
    expect(
      await f.session.send({ id: "r1", remoteId: remote, text: "own prompt", files: [] }),
    ).toEqual({ state: "not_submitted", code: "busy" });
    expect(f.counts).toMatchObject({ presses: 0, inserts: 0, clears: 0 });
    expect(f.value()).toBe("own prompt");
  } finally {
    await f.session.close();
  }
});

test("changed composer text is neither submitted nor cleared", async () => {
  const f = fixture({ foreignEdit: true, expire: true });
  try {
    expect(
      await f.session.send({ id: "r1", remoteId: remote, text: "own prompt", files: [] }),
    ).toEqual({ state: "not_submitted", code: "unavailable" });
    expect(f.counts).toMatchObject({ presses: 0, clears: 0 });
    expect(f.value()).toBe("another editor's draft");
  } finally {
    await f.session.close();
  }
});

test("ambiguous Send activation retains its draft and is never activated again", async () => {
  const f = fixture({ activationError: true });
  try {
    expect(
      await f.session.send({ id: "r1", remoteId: remote, text: "own prompt", files: [] }),
    ).toEqual({ state: "unknown", reason: "send_activation_unconfirmed" });
    expect(f.counts).toMatchObject({ presses: 1, clears: 0, closes: 0 });
    expect(f.value()).toBe("own prompt");
    expect(
      await f.session.send({ id: "r2", remoteId: remote, text: "new prompt", files: [] }),
    ).toEqual({ state: "not_submitted", code: "busy" });
    expect(f.counts.presses).toBe(1);
  } finally {
    await f.session.close();
  }
});

test("generation beginning during preparation is rechecked before Send", async () => {
  const f = fixture({ stopAfterInsert: true });
  try {
    expect(
      await f.session.send({ id: "r1", remoteId: remote, text: "own prompt", files: [] }),
    ).toEqual({ state: "not_submitted", code: "busy" });
    expect(f.counts).toMatchObject({ presses: 0, clears: 1 });
  } finally {
    await f.session.close();
  }
});
