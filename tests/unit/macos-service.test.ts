import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMacOSService, serviceLabel } from "../../scripts/macos-service";
import { canRestartService } from "../../src/cli/index";
import { TelegramError } from "../../src/transports/telegram/TelegramApi";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tgwebcodex service & "));
  roots.push(root);
  writeFileSync(join(root, ".env"), "TELEGRAM_BOT_TOKEN=123:SYNTHETIC_PRIVATE\n", { mode: 0o600 });
  const source = join(root, "fixture-bun");
  writeFileSync(source, "synthetic executable", { mode: 0o700 });
  return { root, source };
}

test("macOS preparation pins runtime bytes and produces a private, valid LaunchAgent without credentials", async () => {
  const { root, source } = fixture();
  const result = prepareMacOSService(root, source);
  expect(readFileSync(result.bunPath, "utf8")).toBe("synthetic executable");
  expect(statSync(result.bunPath).mode & 0o777).toBe(0o500);
  expect(statSync(result.directory).mode & 0o777).toBe(0o700);
  for (const path of [result.plistPath, result.stdoutPath, result.stderrPath]) {
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }
  const plist = readFileSync(result.plistPath, "utf8");
  expect(plist).not.toContain("SYNTHETIC_PRIVATE");
  expect(plist).not.toContain("/private/tmp/tgcodexweb-r5-tools");
  expect(prepareMacOSService(root, source)).toEqual(result);
  if (process.platform === "darwin") {
    const child = Bun.spawn(["/usr/bin/plutil", "-convert", "json", "-o", "-", result.plistPath]);
    const parsed = await new Response(child.stdout).json();
    expect(await child.exited).toBe(0);
    expect(parsed).toMatchObject({
      Label: serviceLabel,
      WorkingDirectory: root,
      ProgramArguments: [
        result.bunPath,
        `--env-file=${join(root, ".env")}`,
        join(root, "scripts/macos-service.ts"),
        "run",
      ],
      KeepAlive: { SuccessfulExit: false },
      RunAtLoad: true,
      ThrottleInterval: 30,
      ExitTimeOut: 120,
      AbandonProcessGroup: false,
      Umask: 63,
    });
    expect(parsed.EnvironmentVariables).toEqual({
      PATH: `${join(result.bunPath, "..")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    });
  }
});

test("preparation refuses a changed runtime or symlink log instead of overwriting it", () => {
  const { root, source } = fixture();
  const result = prepareMacOSService(root, source);
  writeFileSync(source, "different executable");
  expect(() => prepareMacOSService(root, source)).toThrow("SERVICE_RUNTIME_MISMATCH");
  writeFileSync(source, "synthetic executable");
  rmSync(result.stderrPath);
  const outside = join(root, "must-not-change");
  writeFileSync(outside, "private fixture");
  symlinkSync(outside, result.stderrPath);
  expect(() => prepareMacOSService(root, source)).toThrow("SERVICE_PATH_UNSAFE");
  expect(readFileSync(outside, "utf8")).toBe("private fixture");
});

test("service restart requires bounded read-only Telegram retry evidence, never a delivery or permanent failure", () => {
  for (const error of [
    new TelegramError("TELEGRAM_UNAVAILABLE", 0),
    new TelegramError("TELEGRAM_UNAVAILABLE", undefined, undefined, 0),
  ]) {
    expect(canRestartService(error)).toBe(true);
  }
  for (const error of [
    new TelegramError("TELEGRAM_TOKEN_INVALID", 0),
    new TelegramError("TELEGRAM_CONFLICT"),
    new TelegramError("TELEGRAM_UNAVAILABLE"),
    new TelegramError("TELEGRAM_UNAVAILABLE", 60000),
    new TelegramError("TELEGRAM_UNAVAILABLE", 60001),
    new TelegramError("TELEGRAM_UNAVAILABLE", -1),
    new TelegramError("TELEGRAM_UNAVAILABLE", Number.NaN),
    new TelegramError("TELEGRAM_UNAVAILABLE", undefined, 0),
    new TelegramError("TELEGRAM_UNAVAILABLE", 0, undefined, 60000),
    new Error("private fixture error"),
  ])
    expect(canRestartService(error)).toBe(false);
});
