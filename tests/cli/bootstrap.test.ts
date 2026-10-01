import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Environment } from "../../src/config/Config";

const repository = resolve(import.meta.dir, "../..");
const cli = join(repository, "src/cli/index.ts");
const fixtures = { TELEGRAM_BOT_TOKEN: "r0-fixture-token", TELEGRAM_ALLOWED_USER_IDS: "123" };
const invalidEnvironments: Environment[] = [
  { TELEGRAM_BOT_TOKEN: "", TELEGRAM_ALLOWED_USER_IDS: "123" },
  { TELEGRAM_BOT_TOKEN: "r0-fixture-token" },
  { ...fixtures, TELEGRAM_ALLOWED_USER_IDS: "" },
  { ...fixtures, GENERATION_TIMEOUT_MS: "0" },
  { ...fixtures, LOG_CONTENT: "yes" },
];
let root: string;

// Subprocess получает только явно заданный env и собственный cwd, без credentials и чужого state.
function run(command: string, env: Environment = {}) {
  return Bun.spawnSync([process.execPath, "--no-env-file", cli, command], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tgcodexweb-r0-cli-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("local bootstrap CLI", () => {
  test("missing config exits with safe field errors before filesystem side effects", () => {
    const result = run("start");
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    const receipt = JSON.parse(result.stderr.toString());
    expect(receipt.errorCode).toBe("CONFIG_ERROR");
    expect(receipt.issues).toEqual([
      { field: "TELEGRAM_BOT_TOKEN", reason: "required" },
      { field: "TELEGRAM_ALLOWED_USER_IDS", reason: "required" },
    ]);
    expect(readdirSync(root)).toEqual([]);
  });

  test.each(invalidEnvironments)(
    "rejects incomplete or invalid config without creating data",
    (env) => {
      const result = run("start", env);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr.toString()).errorCode).toBe("CONFIG_ERROR");
      expect(result.stderr.toString()).not.toContain("r0-fixture-token");
      expect(readdirSync(root)).toEqual([]);
    },
  );

  test("config check returns no config values and does not create data", () => {
    const result = run("config:check", fixtures);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stderr.toString()).operation).toBe("config.valid");
    expect(result.stderr.toString()).not.toContain(fixtures.TELEGRAM_BOT_TOKEN);
    expect(readdirSync(root)).toEqual([]);
  });

  test("database maintenance initializes and reopens without credentials", () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = run("db:migrate");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stderr.toString()).operation).toBe("database.migrated");
    }
    const database = new Database(join(root, "data/gateway.sqlite"), { readonly: true });
    try {
      expect(
        database.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      ).toEqual([
        { name: "active_conversations" },
        { name: "attachments" },
        { name: "conversations" },
        { name: "processed_updates" },
        { name: "request_inputs" },
        { name: "requests" },
        { name: "schema_migrations" },
        { name: "sqlite_sequence" },
        { name: "users" },
      ]);
      expect(database.query("SELECT version, name FROM schema_migrations").all()).toEqual([
        { version: 1, name: "0001_domain.sql" },
        { version: 2, name: "0002_reuse_archived_alias.sql" },
        { version: 3, name: "0003_request_inputs.sql" },
      ]);
    } finally {
      database.close(true);
    }
  });

  test("bootstrap is one-shot, migrates local metadata and never announces READY", () => {
    const result = run("start", fixtures);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stderr.toString()).operation).toBe("bootstrap.complete");
    expect(result.stderr.toString()).not.toContain("READY");
    expect(result.stderr.toString()).not.toContain(fixtures.TELEGRAM_BOT_TOKEN);
    expect(existsSync(join(root, "data/gateway.sqlite"))).toBe(true);
    expect(existsSync(join(root, "data/browser-profile"))).toBe(false);
    expect(existsSync(join(root, "data/tmp"))).toBe(false);
  });

  test("database failures are normalized without raw path or exception", () => {
    const blocked = join(root, "r0-private-path");
    writeFileSync(blocked, "fixture");
    const result = run("db:migrate", { DATABASE_PATH: join(blocked, "gateway.sqlite") });
    expect(result.exitCode).toBe(1);
    const receipt = JSON.parse(result.stderr.toString());
    expect(receipt.errorCode).toBe("DATABASE_ERROR");
    expect(receipt.reason).toBe("initialization_failed");
    expect(result.stderr.toString()).not.toContain("r0-private-path");
  });

  test("bunfig disables automatic local .env loading", () => {
    copyFileSync(join(repository, "bunfig.toml"), join(root, "bunfig.toml"));
    writeFileSync(
      join(root, ".env"),
      "TELEGRAM_BOT_TOKEN=r0-local-file-fixture\nTELEGRAM_ALLOWED_USER_IDS=123\n",
    );
    const result = Bun.spawnSync([process.execPath, cli, "start"], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr.toString()).errorCode).toBe("CONFIG_ERROR");
    expect(result.stderr.toString()).not.toContain("r0-local-file-fixture");
    expect(existsSync(join(root, "data"))).toBe(false);
  });

  test("explicit .env file works without leaking its fixture token", () => {
    copyFileSync(join(repository, "bunfig.toml"), join(root, "bunfig.toml"));
    writeFileSync(
      join(root, ".env"),
      "TELEGRAM_BOT_TOKEN=r0-local-file-fixture\nTELEGRAM_ALLOWED_USER_IDS=123\n",
    );
    const result = Bun.spawnSync([process.execPath, "--env-file=.env", cli, "config:check"], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stderr.toString()).operation).toBe("config.valid");
    expect(result.stderr.toString()).not.toContain("r0-local-file-fixture");
  });

  test("runtime pin mismatch fails without launching bootstrap", () => {
    mkdirSync(join(root, "scripts"));
    copyFileSync(
      join(repository, "scripts/check-toolchain.ts"),
      join(root, "scripts/check-toolchain.ts"),
    );
    const manifest = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
    manifest.engines.bun = "0.0.0";
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    const result = Bun.spawnSync(
      [process.execPath, "--no-env-file", join(root, "scripts/check-toolchain.ts")],
      {
        cwd: root,
        env: { PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr.toString()).errorCode).toBe("TOOLCHAIN_ERROR");
    expect(existsSync(join(root, "data"))).toBe(false);
  });

  test("unsupported commands return a stable error without echoing arguments", () => {
    const result = run("r0-private-argument");
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr.toString()).errorCode).toBe("CLI_ERROR");
    expect(result.stderr.toString()).not.toContain("r0-private-argument");
    expect(readdirSync(root)).toEqual([]);
  });
});
