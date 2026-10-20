import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatGptWebProvider,
  type NativeChatGptSession,
} from "../../src/providers/chatgpt-web/ChatGptWebProvider";
import { GatewayBrowserError } from "../../src/providers/chatgpt-web/upstream/src/adapters/chatgpt-web/gateway-session";
import { LocalAttachmentStore } from "../../src/storage/LocalAttachmentStore";
import { createLogger } from "../../src/logging/logger";
import type { ProviderSubmission } from "../../src/ports/ChatProvider";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tgwebgpt-r6-provider-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const remote = "6abce299-fdbc-83ed-9b04-7016343a6984";
function native() {
  const sends: Parameters<NativeChatGptSession["send"]>[0][] = [];
  const session: NativeChatGptSession = {
    health: async () => "ready",
    initializeConversation: async () => {},
    inspectConversation: async () => {},
    send: async (input) => {
      sends.push(input);
      return { state: "submitted", remoteId: remote, turnId: "accepted-user-turn" };
    },
    observe: async () => ({
      state: "completed",
      text: "synthetic answer",
      messageId: "accepted-assistant-turn",
    }),
    login: async () => {},
    close: async () => {},
  };
  return { session, sends };
}

test("AUTH_REQUIRED and browser failure never submit; raw exceptions never cross the port", async () => {
  const { session, sends } = native();
  const provider = new ChatGptWebProvider({ profileDir: join(root, "profile"), session });
  session.health = async () => "auth_required";
  expect((await provider.health()).state).toBe("auth_required");
  await expect(provider.createConversation()).rejects.toThrow("AUTH_REQUIRED");
  session.health = async () => {
    throw new Error("synthetic-secret-cookie");
  };
  expect((await provider.health()).state).toBe("unavailable");
  await expect(provider.inspectConversation(remote)).rejects.toThrow("PROVIDER_UNAVAILABLE");
  expect(sends).toHaveLength(0);
});

test("READY also requires valid identity metadata after acquiring browser ownership", async () => {
  const { session, sends } = native();
  const profileDir = join(root, "profile");
  session.health = async () => {
    writeFileSync(join(profileDir, "gateway-conversations.json"), "invalid");
    return "ready";
  };
  const provider = new ChatGptWebProvider({ profileDir, session });
  expect((await provider.health()).state).toBe("unavailable");
  expect(sends).toHaveLength(0);
});

test("initialized drafts bind durably to inspected remote identity; aliases converge without another prompt", async () => {
  const { session, sends } = native();
  const directory = join(root, "profile");
  const provider = new ChatGptWebProvider({ profileDir: directory, session });
  const draft = await provider.createConversation();
  const submission = await provider.send({
    conversationId: draft.id,
    clientRequestId: "r1",
    text: "exact prompt",
    attachments: [],
  });
  expect(submission.state).toBe("submitted");
  expect(sends).toEqual([{ id: "r1", remoteId: undefined, text: "exact prompt", files: [] }]);
  expect((await provider.inspectConversation(`https://chatgpt.com/c/${remote}`)).id).toBe(draft.id);
  await provider.close();
  const reopened = new ChatGptWebProvider({ profileDir: directory, session: native().session });
  expect((await reopened.inspectConversation(remote)).id).toBe(draft.id);
  expect((await reopened.inspectRequest(submission as ProviderSubmission)).state).toBe("unknown");
  await reopened.close();
});

test("inaccessible/invalid references cannot create a ready binding or mutate another host", async () => {
  const { session } = native();
  let inspections = 0;
  session.inspectConversation = async () => {
    inspections++;
    throw new GatewayBrowserError("chat_access_denied");
  };
  const provider = new ChatGptWebProvider({ profileDir: join(root, "profile"), session });
  await expect(provider.inspectConversation(`https://evil.example/c/${remote}`)).rejects.toThrow(
    "INVALID_CONVERSATION_REFERENCE",
  );
  expect(inspections).toBe(0);
  await expect(provider.inspectConversation(remote)).rejects.toThrow("CHAT_ACCESS_DENIED");
  expect(inspections).toBe(1);
});

test("adapter reads actual attachment bytes in order and preserves filenames, MIME and exact caption", async () => {
  const store = new LocalAttachmentStore(join(root, "files"));
  await store.initialize();
  const bytes = Buffer.from("%PDF-1.4\nsynthetic\n%%EOF");
  const stored = await store.put(
    (async function* () {
      yield bytes;
    })(),
    100,
  );
  const { session, sends } = native();
  const provider = new ChatGptWebProvider({
    profileDir: join(root, "profile"),
    session,
    attachmentStore: store,
  });
  const conversation = await provider.inspectConversation(remote);
  const result = await provider.send({
    conversationId: conversation.id,
    clientRequestId: "files",
    text: " /stop\ncaption ",
    attachments: [
      {
        storageKey: stored.key,
        filename: "../input.pdf",
        mimeType: "application/pdf",
        sizeBytes: bytes.length,
      },
    ],
  });
  expect(result.state).toBe("submitted");
  expect(sends[0]?.text).toBe(" /stop\ncaption ");
  expect(sends[0]?.files).toEqual([
    { name: "../input.pdf", mimeType: "application/pdf", buffer: bytes },
  ]);
  stored.release();
});

test("missing or oversized bytes fail before native Send", async () => {
  const store = new LocalAttachmentStore(join(root, "files"));
  await store.initialize();
  const { session, sends } = native();
  const provider = new ChatGptWebProvider({
    profileDir: join(root, "profile"),
    session,
    attachmentStore: store,
  });
  const conversation = await provider.inspectConversation(remote);
  for (const sizeBytes of [10, 20_000_001]) {
    const result = await provider.send({
      conversationId: conversation.id,
      clientRequestId: `bad-${sizeBytes}`,
      text: "caption",
      attachments: [
        {
          storageKey: "att_missing",
          filename: "input.pdf",
          mimeType: "application/pdf",
          sizeBytes,
        },
      ],
    });
    expect(result.state).toBe("not_submitted");
  }
  expect(sends).toHaveLength(0);
});

test("ambiguous native Send is not retried, including an explicit duplicate call", async () => {
  const { session, sends } = native();
  session.send = async (input) => {
    sends.push(input);
    throw new Error("synthetic-auth-token");
  };
  const provider = new ChatGptWebProvider({ profileDir: join(root, "profile"), session });
  const conversation = await provider.inspectConversation(remote);
  const input = {
    conversationId: conversation.id,
    clientRequestId: "ambiguous",
    text: "once",
    attachments: [],
  };
  expect((await provider.send(input)).state).toBe("unknown");
  expect((await provider.send(input)).state).toBe("unknown");
  expect(sends).toHaveLength(1);
});

test("submission diagnostics allow fixed reasons and never expose a native exception or arbitrary reason", async () => {
  const { session } = native();
  const lines: string[] = [];
  const provider = new ChatGptWebProvider({
    profileDir: join(root, "profile"),
    session,
    log: createLogger({ sink: (line) => lines.push(line) }),
  });
  const conversation = await provider.inspectConversation(remote);
  for (const mode of ["known", "untrusted", "throw"] as const) {
    session.send = async () => {
      if (mode === "throw") throw new Error("private native cookie details");
      return {
        state: "unknown",
        reason: mode === "known" ? "submission_ack_timeout" : "private native cookie details",
      } as Awaited<ReturnType<NativeChatGptSession["send"]>>;
    };
    expect(
      (
        await provider.send({
          conversationId: conversation.id,
          clientRequestId: mode,
          text: "private prompt",
          attachments: [],
        })
      ).state,
    ).toBe("unknown");
  }
  expect(lines.map((line) => JSON.parse(line).reason)).toEqual([
    "submission_ack_timeout",
    "native_send_unknown",
    "submission_receipt_failed",
  ]);
  expect(lines.join("")).not.toContain("private");
  await provider.close();
});

test("confirmed submission preserves the port result without UNKNOWN diagnostics", async () => {
  const { session } = native();
  const lines: string[] = [];
  const provider = new ChatGptWebProvider({
    profileDir: join(root, "profile"),
    session,
    log: createLogger({ sink: (line) => lines.push(line) }),
  });
  const conversation = await provider.inspectConversation(remote);
  expect(
    await provider.send({
      conversationId: conversation.id,
      clientRequestId: "r1",
      text: "private prompt",
      attachments: [],
    }),
  ).toEqual({
    state: "submitted",
    conversationId: conversation.id,
    clientRequestId: "r1",
    providerRequestId: "accepted-user-turn",
  });
  expect(lines).toHaveLength(0);
  await provider.close();
});

test("a diagnostic failure preserves UNKNOWN and cannot bind a foreign response", async () => {
  const { session, sends } = native();
  let observations = 0,
    diagnostics = 0;
  session.send = async (input) => {
    sends.push(input);
    return { state: "unknown", reason: "send_activation_unconfirmed" };
  };
  session.observe = async () => {
    observations++;
    return { state: "completed", text: "foreign answer", messageId: "foreign-response" };
  };
  const provider = new ChatGptWebProvider({
    profileDir: join(root, "profile"),
    session,
    log: () => {
      diagnostics++;
      throw new Error("private sink failure");
    },
  });
  const conversation = await provider.inspectConversation(remote);
  const input = {
    conversationId: conversation.id,
    clientRequestId: "r1",
    text: "private prompt",
    attachments: [],
  };
  expect((await provider.send(input)).state).toBe("unknown");
  expect(
    (await provider.inspectRequest({ ...input, providerRequestId: "group:user:foreign" })).state,
  ).toBe("unknown");
  expect((await provider.send(input)).state).toBe("unknown");
  expect(sends).toHaveLength(1);
  expect(observations).toBe(0);
  expect(diagnostics).toBe(1);
  await provider.close();
});

test("partial output stays running, foreign identity is unknown and abort detaches without cancellation", async () => {
  const { session } = native();
  let observations = 0;
  session.observe = async () => {
    observations++;
    return { state: "running" };
  };
  const provider = new ChatGptWebProvider({ profileDir: join(root, "profile"), session });
  const conversation = await provider.inspectConversation(remote);
  const submission = (await provider.send({
    conversationId: conversation.id,
    clientRequestId: "slow",
    text: "once",
    attachments: [],
  })) as ProviderSubmission;
  expect(
    (await provider.inspectRequest({ ...submission, providerRequestId: "foreign" })).state,
  ).toBe("unknown");
  expect(observations).toBe(0);
  const controller = new AbortController();
  const waiting = provider.awaitCompletion({ submission, signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  expect((await waiting).state).toBe("unknown");
  expect(provider.capabilities).toEqual({
    maxConcurrentConversations: 1,
    cancellation: false,
    fileUpload: true,
  });
  expect((await provider.cancel(submission)).state).toBe("not_cancelled");
  session.observe = async () => ({
    state: "completed",
    text: "final answer",
    messageId: "answer-id",
  });
  expect(
    await provider.awaitCompletion({ submission, signal: new AbortController().signal }),
  ).toEqual({
    ...submission,
    state: "completed",
    message: { text: "final answer", id: "answer-id" },
  });
});
