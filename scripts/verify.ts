import { resolve } from "node:path";
import { checkToolchain } from "./check-toolchain";

const root = resolve(import.meta.dir, "..");

// Sequential checks дают один воспроизводимый exit code и останавливаются на первой ошибке.
async function verify(): Promise<void> {
  checkToolchain();
  for (const command of ["toolchain:check", "typecheck", "lint", "format:check", "test"]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", "run", command], {
      cwd: root,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      process.exitCode = exitCode;
      return;
    }
  }
}

if (import.meta.main) {
  try {
    await verify();
  } catch {
    process.stderr.write("Verification failed\n");
    process.exitCode = 1;
  }
}
