import { afterEach, beforeEach, expect, test } from "bun:test";
import { QueueFixture, attachment, later, request } from "../fixtures/queue";

let f: QueueFixture;
beforeEach(() => {
  f = new QueueFixture();
});
afterEach(() => f.close());

test("clearing pending work retains dedup, removes input/files and survives reopen", () => {
  f.store.accept(request(), { text: "private input", attachments: [attachment()] }, 10);
  f.store.accept(request("r2", "2", "other"), { text: "other input", attachments: [] }, 10);
  expect(f.store.pending("123").map((r) => r.id)).toEqual(["r1", "r2"]);
  const cleared = f.store.clearPending("123", later, "c1");
  expect(cleared.map((r) => r.request.id)).toEqual(["r1"]);
  expect(cleared[0].attachments).toHaveLength(1);
  f.reopen();
  expect(f.requests.get("r1")).toMatchObject({ state: "failed", failureCode: "QUEUE_CLEARED" });
  expect(f.requests.get("r1")?.startedAt).toBeUndefined();
  expect(f.requests.listAttachments("r1")).toEqual([]);
  expect(f.updates.get("1")?.requestId).toBe("r1");
  expect(f.store.claim("r1", later)).toBeNull();
  expect(
    f.store.accept(request("duplicate", "1"), { text: "retry", attachments: [] }, 10).kind,
  ).toBe("duplicate");
  expect(f.store.pending("123").map((r) => r.id)).toEqual(["r2"]);
  expect(f.store.clearPending("123", later, "c1")).toEqual([]);
});

test("owner and mapping scope preserve active, unknown and foreign work on the same canonical key", () => {
  f.conversations.putUser({ telegramUserId: "456", enabled: true, createdAt: later });
  const original = f.conversations.get("c1");
  if (!original) throw new Error("Fixture mapping missing");
  f.conversations.create({
    ...original,
    id: "foreign",
    alias: "foreign",
    telegramUserId: "456",
  });
  for (const [id, mapping] of [
    ["r1", "c1"],
    ["r2", "c1"],
    ["r3", "alias"],
    ["r4", "foreign"],
    ["r5", "other"],
  ]) {
    f.store.accept(request(id, id.slice(1), mapping), { text: "private", attachments: [] }, 20);
  }
  f.store.claim("r1", later);
  f.requests.transition("r1", { state: "unknown", at: later });
  f.store.claim("r5", later);
  expect(f.store.pending("456").map((r) => r.id)).toEqual(["r4"]);
  expect(f.store.clearPending("123", later, "foreign")).toEqual([]);
  expect(f.store.clearPending("123", later).map((r) => r.request.id)).toEqual(["r2", "r3"]);
  f.reopen();
  expect(f.requests.get("r1")?.state).toBe("unknown");
  expect(f.requests.get("r5")?.state).toBe("sending");
  expect(f.requests.get("r4")?.state).toBe("queued");
  expect(f.store.snapshot().blocked.some((b) => b.requestId === "r1")).toBe(true);
});

test("a failed clear transaction rolls back every removed request and retained input", () => {
  for (const id of ["r1", "r2"])
    f.store.accept(request(id, id.slice(1)), { text: "private", attachments: [] }, 10);
  f.database.run(
    "CREATE TRIGGER reject_clear BEFORE UPDATE ON requests WHEN NEW.id='r2' AND NEW.failure_code='QUEUE_CLEARED' BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  );
  expect(() => f.store.clearPending("123", later)).toThrow();
  f.reopen();
  expect(f.store.snapshot().queued.map((w) => w.request.id)).toEqual(["r1", "r2"]);
});
