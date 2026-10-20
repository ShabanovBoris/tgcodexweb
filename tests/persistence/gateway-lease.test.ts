import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireGatewayLease } from "../../src/persistence/sqlite/GatewayLease";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tgwebgpt-r7-lease-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("runtime and maintenance exclude each other across path aliases and release explicitly", () => {
  const path = join(root, "gateway.sqlite");
  const release = acquireGatewayLease(path);
  try {
    symlinkSync(root, join(root, "alias"));
    expect(() => acquireGatewayLease(join(root, "alias/gateway.sqlite"))).toThrow("DATABASE_ERROR");
  } finally {
    release();
  }
  release();
  acquireGatewayLease(path)();
});

test("a killed process releases the SQLite lease without removing its lock file", async () => {
  const path = join(root, "gateway.sqlite");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      resolve(import.meta.dir, "../fixtures/gateway-lease.ts"),
      path,
    ],
    { env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("locked\n");
    reader.releaseLock();
    expect(() => acquireGatewayLease(path)).toThrow("DATABASE_ERROR");
    child.kill("SIGKILL");
    await child.exited;
    acquireGatewayLease(path)();
    expect(await new Response(child.stderr).text()).toBe("");
  } finally {
    child.kill();
    await child.exited;
  }
});
