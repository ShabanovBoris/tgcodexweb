import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.each(["backoff", "poll"] as const)(
  "R7 CLI SIGTERM during %s cleans up without another poll",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "tgcodexweb-r7-signal-"));
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "../fixtures/telegram-signal.ts"),
        mode,
      ],
      {
        cwd: root,
        env: { PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      let receipt = "",
        signalled = false;
      const expected = mode === "backoff" ? "telegram.poll_retry" : "fixture.poll_entered";
      for await (const chunk of child.stderr) {
        receipt += new TextDecoder().decode(chunk);
        if (!signalled && receipt.includes(expected)) {
          signalled = true;
          child.kill("SIGTERM");
        }
      }
      expect(signalled).toBe(true);
      expect(await child.exited).toBe(0);
      expect(JSON.parse(await new Response(child.stdout).text())).toEqual({
        exitCode: 0,
        polls: 1,
      });
      expect(receipt).not.toContain("R7_SYNTHETIC_TOKEN");
      expect(receipt).not.toContain("api.telegram.org");
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
