import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tgwebcodex-service-run-"));
  roots.push(root);
  const start = (mode: string) =>
    Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "../fixtures/macos-service.ts"),
        root,
        mode,
      ],
      { cwd: root, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" },
    );
  const records = () =>
    readFileSync(join(root, "data/service/lifecycle.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { root, start, records };
}

test.each([
  ["temporary", 75, "retryable_failure"],
  ["fatal", 0, "permanent_failure"],
] as const)(
  "managed CLI %s exit uses launchd policy without leaking credentials",
  async (mode, code, reason) => {
    const f = fixture();
    const child = f.start(mode);
    expect(await child.exited).toBe(code);
    expect(f.records().map((r) => r.operation)).toEqual(["service.started", "service.stopped"]);
    expect(f.records()[1]).toMatchObject({ exitCode: code, reason });
    expect(statSync(join(f.root, "data/service/lifecycle.jsonl")).mode & 0o777).toBe(0o600);
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toContain(mode === "fatal" ? "TELEGRAM_TOKEN_INVALID" : "TELEGRAM_UNAVAILABLE");
    expect(stderr).not.toContain("SERVICE_SYNTHETIC_PRIVATE");
    expect(existsSync(join(f.root, "data/fake-gateway.sqlite"))).toBe(false);
  },
);

test("SIGKILL leaves an unclosed receipt; a fresh managed CLI appends a new run and SIGTERM joins shutdown", async () => {
  const f = fixture();
  for (const signal of ["SIGKILL", "SIGTERM"] as const) {
    const child = f.start("running");
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("polling");
      reader.releaseLock();
      child.kill(signal);
      const code = await child.exited;
      if (signal === "SIGTERM") expect(code).toBe(0);
      const stderr = await new Response(child.stderr).text();
      expect(stderr).not.toContain("SERVICE_SYNTHETIC_PRIVATE");
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  }
  const records = f.records();
  expect(records.map((r) => r.operation)).toEqual([
    "service.started",
    "service.started",
    "service.stop_requested",
    "service.stopped",
  ]);
  expect(records[0].processId).not.toBe(records[1].processId);
  expect(records[3]).toMatchObject({
    processId: records[1].processId,
    reason: "SIGTERM",
    exitCode: 0,
  });
  const db = new Database(join(f.root, "data/fake-gateway.sqlite"), { readonly: true });
  try {
    expect(db.query("SELECT id,state FROM requests ORDER BY id").all()).toEqual([
      { id: "ambiguous", state: "unknown" },
      { id: "successor", state: "queued" },
    ]);
    expect(db.query("SELECT request_id FROM request_inputs").all()).toEqual([
      { request_id: "successor" },
    ]);
    expect(
      db.query("SELECT request_id FROM processed_updates ORDER BY telegram_update_id").all(),
    ).toEqual([{ request_id: "ambiguous" }, { request_id: "successor" }]);
    expect(db.query("SELECT conversation_id FROM active_conversations").all()).toEqual([
      { conversation_id: "c1" },
    ]);
  } finally {
    db.close();
  }
});
