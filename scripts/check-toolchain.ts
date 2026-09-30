import manifest from "../package.json" with { type: "json" };

// Runtime pin является частью bootstrap-контракта, а не рекомендацией package manager.
export class ToolchainError extends Error {
  readonly code = "TOOLCHAIN_ERROR";
  readonly reason = "runtime_pin_mismatch";

  constructor() {
    super("TOOLCHAIN_ERROR");
    this.name = "ToolchainError";
  }
}

// Один manifest хранит pin; проверка не позволяет engines, packageManager и typings разойтись.
export function checkToolchain(): void {
  const expected = manifest.engines.bun;
  if (
    Bun.version !== expected ||
    manifest.packageManager !== `bun@${expected}` ||
    manifest.devDependencies["@types/bun"] !== expected
  ) {
    throw new ToolchainError();
  }
}

if (import.meta.main) {
  try {
    checkToolchain();
    process.stdout.write(
      `${JSON.stringify({ operation: "toolchain.valid", bunVersion: Bun.version })}\n`,
    );
  } catch {
    process.stderr.write(
      `${JSON.stringify({ errorCode: "TOOLCHAIN_ERROR", reason: "runtime_pin_mismatch" })}\n`,
    );
    process.exitCode = 1;
  }
}
