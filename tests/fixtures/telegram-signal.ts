import { runCli } from "../../src/cli/index";

const mode = process.argv[2];
let polls = 0;
// Only this subprocess replaces fetch; no sockets, live bot or credentials are used.
globalThis.fetch = (async (url: string | URL | Request, input?: RequestInit) => {
  if (String(url).endsWith("/getMe"))
    return Response.json({ ok: true, result: { id: 777, is_bot: true, username: "r7_bot" } });
  if (!String(url).endsWith("/getUpdates")) throw new Error("unexpected fixture method");
  polls++;
  if (mode === "backoff")
    return Response.json(
      { ok: false, error_code: 429, parameters: { retry_after: 60 } },
      { status: 429 },
    );
  process.stderr.write('{"operation":"fixture.poll_entered"}\n');
  return new Promise<Response>((_resolve, reject) => {
    const signal = input?.signal;
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}) as typeof fetch;
const exitCode = await runCli(["start:fake", "--private"], {
  TELEGRAM_BOT_TOKEN: "123456789:R7_SYNTHETIC_TOKEN",
  TELEGRAM_ALLOWED_USER_IDS: "123",
});
process.stdout.write(`${JSON.stringify({ exitCode, polls })}\n`);
process.exitCode = exitCode;
