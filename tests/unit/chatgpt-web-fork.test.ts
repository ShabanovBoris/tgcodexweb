import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "../../src/providers/chatgpt-web/upstream/UPSTREAM.json";
import dependencies from "../../package.json";

test("local fork preserves the exact upstream sources except the enumerated gateway patches", () => {
  expect(manifest.revision).toBe("fa2d2c6c24926078b46eedb2186f69f2e8d548d7");
  expect(manifest.patches.map((item) => item.path).sort()).toEqual([
    "launcher/electron/chatgpt-auth-session.cjs",
    "src/adapters/chatgpt-web/browser-worker.ts",
    "src/browser-login.ts",
  ]);
  const root = join(import.meta.dir, "../../src/providers/chatgpt-web/upstream");
  const patches = new Map(manifest.patches.map((item) => [item.path, item.sha256]));
  for (const source of manifest.sources) {
    const bytes = readFileSync(join(root, source.path));
    const patch = patches.get(source.path);
    if (patch) expect(createHash("sha256").update(bytes).digest("hex")).toBe(patch);
    else
      expect(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")).toBe(
        source.sha,
      );
  }
  for (const addition of manifest.additions)
    expect(
      createHash("sha256")
        .update(readFileSync(join(root, addition.path)))
        .digest("hex"),
    ).toBe(addition.sha256);
  const declared: Record<string, string> = {
    ...dependencies.dependencies,
    ...dependencies.devDependencies,
  };
  for (const [name, version] of Object.entries(manifest.dependencies))
    expect(declared[name]).toBe(version);
});
