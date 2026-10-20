import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../../src/persistence/sqlite/Database";
import { migrateDatabase } from "../../src/persistence/sqlite/migrations";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tgwebgpt-r7-doctor-cli-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const cli = resolve(import.meta.dir, "../../src/cli/index.ts");
function run(args = ["doctor"], env: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, "--no-env-file", cli, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}
const config = { TELEGRAM_BOT_TOKEN: "private-invalid-token", TELEGRAM_ALLOWED_USER_IDS: "123" };

test("doctor CLI emits one structured configuration report without filesystem effects", () => {
  const result = run();
  expect(result.exitCode).toBe(1);
  const report = JSON.parse(result.stdout.toString());
  expect(report.readyToStart).toBe(false);
  expect(report.checks.config).toMatchObject({ state: "unavailable", errorCode: "CONFIG_ERROR" });
  expect(report.checks.config.issues.map((issue: { field: string }) => issue.field)).toEqual([
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_ALLOWED_USER_IDS",
  ]);
  expect(result.stderr.toString()).toBe("");
  expect(readdirSync(root)).toEqual([]);
});

test("doctor CLI distinguishes invalid token and missing DB without creating a profile or database", () => {
  const result = run(["doctor"], config);
  expect(result.exitCode).toBe(1);
  const report = JSON.parse(result.stdout.toString());
  expect(report.checks.config.state).toBe("ready");
  expect(report.checks.telegram).toEqual({
    state: "unavailable",
    errorCode: "TELEGRAM_TOKEN_INVALID",
  });
  expect(report.checks.database.state).toBe("missing");
  expect(report.checks.provider.state).toBe("not_checked");
  expect(result.stdout.toString()).not.toContain(config.TELEGRAM_BOT_TOKEN);
  expect(readdirSync(root)).toEqual([]);
});

test("doctor CLI reads an existing schema without migrating or initializing the browser", () => {
  const database = openDatabase(join(root, "data/gateway.sqlite"));
  migrateDatabase(database);
  database.close(true);
  const before = readFileSync(join(root, "data/gateway.sqlite"));
  const result = run(["doctor"], config);
  const report = JSON.parse(result.stdout.toString());
  expect(report.checks.database).toMatchObject({
    state: "ready",
    appliedMigrations: 7,
    pendingMigrations: 0,
    queuedRequests: 0,
    blockedRequests: 0,
  });
  expect(report.checks.runtime.state).toBe("stopped");
  expect(report.checks.provider).toEqual({
    state: "not_checked",
    reason: "profile_not_initialized",
  });
  expect(readFileSync(join(root, "data/gateway.sqlite"))).toEqual(before);
  expect(readdirSync(join(root, "data"))).not.toContain("browser-profile");
});

test("doctor CLI leaves an unmigrated database empty and rejects extra arguments safely", () => {
  const path = join(root, "empty.sqlite");
  const database = new Database(path, { create: true });
  database.close();
  const result = run(["doctor"], { ...config, DATABASE_PATH: path });
  expect(JSON.parse(result.stdout.toString()).checks.database.state).toBe("migration_required");
  const reopened = new Database(path, { readonly: true });
  expect(reopened.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toHaveLength(0);
  reopened.close();
  const invalid = run(["doctor", "private-argument"], config);
  expect(invalid.exitCode).toBe(1);
  expect(JSON.parse(invalid.stderr.toString()).errorCode).toBe("CLI_ERROR");
  expect(invalid.stderr.toString()).not.toContain("private-argument");
});
