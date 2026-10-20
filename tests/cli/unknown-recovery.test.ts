import { afterEach, beforeEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { acquireGatewayLease } from "../../src/persistence/sqlite/GatewayLease";
import { later, QueueFixture, request } from "../fixtures/queue";

let f: QueueFixture;
const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => {
  f = new QueueFixture();
  f.store.accept(request(id), { text: "private original", attachments: [] }, 3);
  f.store.claim(id, later);
  f.requests.transition(id, { state: "unknown", at: later });
  f.store.accept(request("next", "2"), { text: "private pending", attachments: [] }, 3);
});
afterEach(() => f.close());

function run(args: string[]) {
  return Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      resolve(import.meta.dir, "../../src/cli/index.ts"),
      "recover:unknown",
      ...args,
    ],
    { cwd: f.root, env: { DATABASE_PATH: f.path }, stdout: "pipe", stderr: "pipe" },
  );
}

test.each(
  [[id], [id, "--force"], ["private invalid argument", "--confirm-completed"]].map((args) => ({
    args,
  })),
)("explicit confirmation and a valid request ID are required: %j", ({ args }) => {
  const result = run(args);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr.toString())).toMatchObject({
    errorCode: "CLI_ERROR",
    reason: "unsupported_command",
  });
  expect(result.stderr.toString()).not.toContain("private");
  expect(f.store.snapshot().blocked).toHaveLength(1);
});

test("confirmed offline recovery requires no credentials, preserves pending input and is idempotent", () => {
  const original = f.requests.get(id);
  const input = f.database.query("SELECT * FROM request_inputs").all();
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = run([id, "--confirm-completed"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(JSON.parse(result.stderr.toString())).toMatchObject({
      operation: "request.unknown_resolved",
      requestId: id,
      requestState: "unknown",
      reason: "operator_confirmed_completed",
    });
    expect(result.stderr.toString()).not.toContain("private");
  }
  f.reopen();
  expect(f.requests.get(id)).toEqual(original);
  expect(f.database.query("SELECT * FROM request_inputs").all()).toEqual(input);
  expect(f.database.query("SELECT * FROM request_unknown_resolutions").all()).toHaveLength(1);
  expect(f.store.snapshot().blocked).toEqual([]);
});

test("a running gateway rejects recovery without changing the UNKNOWN or queued payload", () => {
  const release = acquireGatewayLease(f.path);
  try {
    const result = run([id, "--confirm-completed"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr.toString())).toMatchObject({
      errorCode: "DATABASE_ERROR",
      reason: "gateway_busy",
    });
    expect(f.store.snapshot().blocked).toHaveLength(1);
    expect(f.database.query("SELECT * FROM request_unknown_resolutions").all()).toEqual([]);
    expect(f.requests.get("next")?.state).toBe("queued");
  } finally {
    release();
  }
});
