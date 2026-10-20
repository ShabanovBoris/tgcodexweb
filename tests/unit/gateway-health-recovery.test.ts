import { expect, test } from "bun:test";
import type { BrowserContext, Locator, Page } from "playwright-core";
import {
  GatewayBrowserSession,
  type GatewayPrimitives,
} from "../../src/providers/chatgpt-web/upstream/src/adapters/chatgpt-web/gateway-session";

function fixture(closeFails = false) {
  let launches = 0,
    pages = 0,
    closedPages = 0,
    navigations = 0;
  let failNavigation = true,
    authenticated = true;
  let contextClosed: (() => void) | undefined;
  let navigationGate: Promise<void> | undefined;
  const entered = Promise.withResolvers<void>();
  const composer = {
    filter() {
      return this;
    },
    count: async () => 1,
    isEditable: async () => true,
  } as unknown as Locator;
  const session = new GatewayBrowserSession(
    {
      profileDir: "unused-synthetic-profile",
      launch: async () => {
        launches++;
        return {
          setDefaultTimeout: () => {},
          on: (_event: string, listener: () => void) => {
            contextClosed = listener;
          },
          newPage: async () => {
            pages++;
            let navigated = false,
              closed = false;
            return {
              goto: async () => {
                navigations++;
                entered.resolve();
                await navigationGate;
                if (failNavigation) throw new Error("private network details");
                navigated = true;
              },
              isClosed: () => closed,
              close: async () => {
                if (!closed) closedPages++;
                closed = true;
              },
              evaluate: async () =>
                navigated ? { sessionAuthenticated: authenticated } : { sessionCheckError: true },
              locator: () => composer,
            } as unknown as Page;
          },
          close: async () => {
            contextClosed?.();
            if (closeFails) throw new Error("private close failure");
          },
        } as unknown as BrowserContext;
      },
    },
    {} as GatewayPrimitives,
  );
  return {
    session,
    counts: () => ({ launches, pages, closedPages, navigations }),
    succeed: () => {
      failNavigation = false;
    },
    setAuth: (value: boolean) => {
      authenticated = value;
    },
    closeContext: () => contextClosed?.(),
    gate: (value: Promise<void>) => {
      navigationGate = value;
    },
    entered: entered.promise,
  };
}

test("failed health navigation is discarded and the next read-only health creates a fresh probe", async () => {
  const f = fixture();
  try {
    expect(await f.session.health()).toBe("unavailable");
    f.succeed();
    expect(await f.session.health()).toBe("ready");
    expect(f.counts()).toEqual({ launches: 1, pages: 2, closedPages: 1, navigations: 2 });
  } finally {
    await f.session.close();
  }
});

test("concurrent health requests share a single probe and closing the context permits a later safe reopen", async () => {
  const f = fixture();
  f.succeed();
  const gate = Promise.withResolvers<void>();
  f.gate(gate.promise);
  try {
    const first = f.session.health(),
      second = f.session.health();
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual(["ready", "ready"]);
    expect(f.counts()).toMatchObject({ launches: 1, pages: 1, navigations: 1 });
    f.closeContext();
    expect(await f.session.health()).toBe("ready");
    expect(f.counts()).toMatchObject({ launches: 2, pages: 2, navigations: 2 });
  } finally {
    await f.session.close();
  }
  expect(await f.session.health()).toBe("unavailable");
  expect(f.counts().launches).toBe(2);
});

test("AUTH_REQUIRED can be checked again without a prompt, upload or mutation primitive", async () => {
  const f = fixture();
  f.succeed();
  f.setAuth(false);
  try {
    expect(await f.session.health()).toBe("auth_required");
    f.setAuth(true);
    expect(await f.session.health()).toBe("ready");
  } finally {
    await f.session.close();
  }
});

test.each([false, true])(
  "session disposal joins health even when context close fails: %s",
  async (closeFails) => {
    const f = fixture(closeFails);
    f.succeed();
    const gate = Promise.withResolvers<void>();
    f.gate(gate.promise);
    const health = f.session.health();
    await f.entered;
    let closed = false;
    const closing = f.session.close().then(
      () => {
        closed = true;
        return undefined;
      },
      (error: unknown) => {
        closed = true;
        return error;
      },
    );
    await Promise.resolve();
    expect(closed).toBe(false);
    gate.resolve();
    expect(await health).toBe("unavailable");
    const closeError = await closing;
    if (closeFails) expect(closeError).toEqual(new Error("private close failure"));
    else expect(closeError).toBeUndefined();
    expect(closed).toBe(true);
    expect(await f.session.health()).toBe("unavailable");
    expect(f.counts().launches).toBe(1);
  },
);
