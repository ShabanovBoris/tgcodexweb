if (!process.env.TGWEBGPT_TEST_BROWSER) {
  process.stderr.write(
    "TGWEBGPT_TEST_BROWSER must point to a local Chromium executable. No browser was started.\n",
  );
  process.exitCode = 1;
} else {
  const child = Bun.spawn([process.execPath, "--no-env-file", "test", "./tests/browser"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, TGWEBGPT_BROWSER_TEST: "1" },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
}
