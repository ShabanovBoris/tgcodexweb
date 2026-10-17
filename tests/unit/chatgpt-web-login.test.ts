import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNormalBrowserLogin } from "../../src/providers/chatgpt-web/upstream/src/browser-login";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tgwebgpt-r6-login-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixtureBrowser(body: string) {
  const script = join(root, "browser.ts");
  const executable = join(root, "browser");
  writeFileSync(script, body);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    executable,
    `#!/bin/sh\nexec ${quote(process.execPath)} --no-env-file ${quote(script)} "$@"\n`,
  );
  chmodSync(executable, 0o700);
  return {
    executablePath: executable,
    profileDir: join(root, "profile"),
    startUrl: "https://chatgpt.com/",
  };
}

test("manual login launches only the owned profile and joins normal browser exit", async () => {
  const receipt = join(root, "receipt.json");
  const options = fixtureBrowser(
    `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(receipt)},JSON.stringify(process.argv.slice(2)));`,
  );
  await openNormalBrowserLogin(options);
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual([
    `--user-data-dir=${options.profileDir}`,
    "--new-window",
    "--disable-background-mode",
    "--no-first-run",
    "--no-default-browser-check",
    "https://chatgpt.com/",
  ]);
});

test("manual login rejects a failed child without exposing its private stderr", async () => {
  const options = fixtureBrowser(
    'process.stderr.write("PRIVATE_LOGIN_DIAGNOSTIC"); process.exit(17);',
  );
  await expect(openNormalBrowserLogin(options)).rejects.toThrow(
    "Normal Chrome login window exited with status 17",
  );
});

test("aborting manual login joins the owned child; an already aborted call never spawns", async () => {
  const receipt = join(root, "pid");
  const options = fixtureBrowser(
    `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(receipt)},String(process.pid)); setInterval(()=>{},1000);`,
  );
  const controller = new AbortController();
  const settled = openNormalBrowserLogin({ ...options, signal: controller.signal }).catch(
    (error: unknown) => error,
  );
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(receipt) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(receipt)).toBe(true);
    const pid = Number(readFileSync(receipt, "utf8"));
    controller.abort();
    const error = await settled;
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(() => process.kill(pid, 0)).toThrow();
    rmSync(receipt);
    await expect(openNormalBrowserLogin({ ...options, signal: controller.signal })).rejects.toThrow(
      "Browser login aborted",
    );
    expect(existsSync(receipt)).toBe(false);
  } finally {
    controller.abort();
    await settled;
  }
});

test("aborting manual login force-stops an owned child that ignores SIGTERM", async () => {
  const receipt = join(root, "pid");
  const options = fixtureBrowser(
    `import {writeFileSync} from "node:fs"; process.on("SIGTERM",()=>{}); writeFileSync(${JSON.stringify(receipt)},String(process.pid)); setInterval(()=>{},1000);`,
  );
  const controller = new AbortController();
  let childSettled = false;
  const settled = openNormalBrowserLogin({ ...options, signal: controller.signal })
    .catch((error: unknown) => error)
    .finally(() => {
      childSettled = true;
    });
  let pid: number | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(receipt) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(receipt)).toBe(true);
    pid = Number(readFileSync(receipt, "utf8"));
    controller.abort();
    const error = await Promise.race([
      settled,
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve("LOGIN_ABORT_DID_NOT_SETTLE"), 7_500);
      }),
    ]);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(() => process.kill(pid as number, 0)).toThrow();
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (pid !== undefined && !childSettled) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // A successfully joined child no longer has a process to terminate.
      }
    }
    await settled;
  }
}, 15_000);
