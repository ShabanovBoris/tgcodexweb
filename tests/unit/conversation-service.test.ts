import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConversationService } from "../../src/application/ConversationService";
import { FakeChatProvider } from "../../src/providers/fake/FakeChatProvider";
import { later, QueueFixture } from "../fixtures/queue";

let f: QueueFixture;
beforeEach(() => {
  f = new QueueFixture();
});
afterEach(() => f.close());

function setup(provider = new FakeChatProvider()) {
  let id = 0;
  const service = new ConversationService(
    f.conversations,
    provider,
    () => later,
    () => `new-${++id}`,
  );
  return { service, provider };
}

test("AC-C01/C02 creates, persists and selects named/unique generated aliases", async () => {
  const { service } = setup();
  const named = await service.create("123", "coding");
  expect(named.providerConversationId).toBe("fake-conversation-1");
  expect(service.current("123").id).toBe(named.id);
  expect((await service.create("123")).alias).toBe("chat-1");
  expect((await service.create("123")).alias).toBe("chat-2");
  f.reopen();
  expect(f.conversations.getActive("123")?.alias).toBe("chat-2");
  expect(f.conversations.findByAlias("123", "coding")).toEqual(named);
});

test("AC-C03 rejects duplicate/invalid aliases before remote create or inspect", async () => {
  let effects = 0;
  class CountingProvider extends FakeChatProvider {
    override async createConversation() {
      effects++;
      return super.createConversation();
    }
    override async inspectConversation(reference: string) {
      effects++;
      return super.inspectConversation(reference);
    }
  }
  const { service } = setup(new CountingProvider());
  await expect(service.create("123", "c1")).rejects.toThrow("ALIAS_EXISTS");
  await expect(service.add("123", "c1", "remote")).rejects.toThrow("ALIAS_EXISTS");
  for (const alias of ["", "two words", "a\u0000b", "a\u202eb", "a".repeat(65)])
    await expect(service.create("123", alias)).rejects.toThrow("INVALID_ALIAS");
  expect(effects).toBe(0);
});

test("AC-C04/C05 stores only inspected opaque identity, rejects inaccessible or invalid evidence", async () => {
  class ResolvingProvider extends FakeChatProvider {
    override async inspectConversation(reference: string) {
      if (reference === "supported-reference")
        return { id: " opaque Remote/ID ", url: "https://example.test/conversation" };
      return super.inspectConversation(reference);
    }
  }
  const { service } = setup(new ResolvingProvider());
  expect((await service.add("123", "research", "supported-reference")).providerConversationId).toBe(
    " opaque Remote/ID ",
  );
  await expect(service.add("123", "missing", "no-access")).rejects.toThrow("CHAT_NOT_FOUND");
  expect(f.conversations.findByAlias("123", "missing")).toBeNull();
  class InvalidProvider extends FakeChatProvider {
    override async createConversation() {
      return { id: "" };
    }
  }
  await expect(setup(new InvalidProvider()).service.create("123", "invalid")).rejects.toThrow(
    "PROVIDER_UNAVAILABLE",
  );
  expect(f.conversations.findByAlias("123", "invalid")).toBeNull();
});

test("AC-C06..09 user-scoped selection, rename, archive/reuse preserve historical identity", async () => {
  const { service } = setup();
  service.authorizeUser("456");
  await service.add("456", "foreign", "Remote");
  const old = await service.add("123", "research", "remote");
  f.requests.create({
    id: "historical",
    conversationId: old.id,
    telegramUpdateId: "77",
    state: "created",
    createdAt: later,
  });
  service.rename("123", "research", "renamed");
  expect(service.current("123")).toMatchObject({
    id: old.id,
    alias: "renamed",
    providerConversationId: "remote",
  });
  service.use("123", "c1");
  expect(service.current("123").alias).toBe("c1");
  for (const action of [
    () => service.use("123", "foreign"),
    () => service.rename("123", "foreign", "stolen"),
    () => service.remove("123", "foreign"),
  ])
    expect(action).toThrow("CHAT_NOT_FOUND");
  expect(service.current("456").alias).toBe("foreign");
  service.use("123", "renamed");
  service.remove("123", "renamed");
  expect(() => service.current("123")).toThrow("NO_ACTIVE_CHAT");
  const reused = await service.add("123", "renamed", "Remote");
  expect(reused.id).not.toBe(old.id);
  expect(f.requests.get("historical")?.conversationId).toBe(old.id);
  expect(f.conversations.get(old.id)).toMatchObject({
    archived: true,
    providerConversationId: "remote",
  });
  expect(service.list("123").filter((c) => c.alias === "renamed")).toHaveLength(1);
  f.reopen();
  expect(
    f.conversations.list("123", { includeArchived: true }).find((chat) => chat.id === old.id),
  ).toMatchObject({ archived: true, providerConversationId: "remote" });
  expect(f.conversations.list("456", { includeArchived: true }).map((chat) => chat.alias)).toEqual([
    "foreign",
  ]);
});

test("rename conflicts leave mapping and selection unchanged", () => {
  const { service } = setup();
  service.use("123", "c1");
  expect(() => service.rename("123", "c1", "other")).toThrow("ALIAS_EXISTS");
  service.rename("123", "c1", "c1");
  expect(service.current("123").alias).toBe("c1");
});
