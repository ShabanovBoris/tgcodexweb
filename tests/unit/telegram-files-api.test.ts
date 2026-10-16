import { expect, test } from "bun:test";
import { HttpTelegramApi } from "../../src/transports/telegram/TelegramApi";

const token = "123:R5_SYNTHETIC_TOKEN";

test("getFile keeps source filename out of paths and downloads bytes only from the fixed Telegram origin", async () => {
  const calls: string[] = [];
  const api = new HttpTelegramApi(token, async (url, input) => {
    calls.push(url);
    expect(input.redirect).toBe("error");
    return calls.length === 1
      ? Response.json({
          ok: true,
          result: {
            file_id: "alternate-valid-file-id",
            file_path: "documents/file_1.ts",
            file_size: 3,
          },
        })
      : new Response("abc");
  });
  expect(await Array.fromAsync(api.downloadFile("file", 10))).toEqual([
    new TextEncoder().encode("abc"),
  ]);
  expect(calls).toEqual([
    `https://api.telegram.org/bot${token}/getFile`,
    `https://api.telegram.org/file/bot${token}/documents/file_1.ts`,
  ]);
});

test("hostile getFile paths, omitted paths and declared oversize never initiate download", async () => {
  for (const result of [
    { file_id: "file" },
    ...["../secret", "/etc/passwd", "a/../secret", "a\\b", "a//b"].map((file_path) => ({
      file_id: "file",
      file_path,
    })),
    { file_id: "file", file_path: "a/b", file_size: 11 },
  ]) {
    let calls = 0;
    const api = new HttpTelegramApi(token, async () => {
      calls++;
      return Response.json({ ok: true, result });
    });
    await expect(Array.fromAsync(api.downloadFile("file", 10))).rejects.toThrow();
    expect(calls).toBe(1);
  }
});

test("streamed overflow, body failures and truncated metadata normalize without token-bearing URLs", async () => {
  for (const kind of ["overflow", "truncated", "network", "body"] as const) {
    let calls = 0,
      cancelled = false;
    const api = new HttpTelegramApi(token, async () => {
      if (++calls === 1)
        return Response.json({
          ok: true,
          result: {
            file_id: "file",
            file_path: "a/b",
            ...(kind === "truncated" ? { file_size: 10 } : {}),
          },
        });
      if (kind === "network") throw new Error(`network ${token}`);
      return new Response(
        new ReadableStream({
          start(controller) {
            if (kind === "body") controller.error(new Error(token));
            else controller.enqueue(new Uint8Array(kind === "overflow" ? 11 : 2));
          },
          pull(controller) {
            if (kind !== "overflow") controller.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    });
    try {
      await Array.fromAsync(api.downloadFile("file", 10));
      throw new Error("expected failure");
    } catch (error) {
      expect(String(error)).toContain("ATTACHMENT_");
      expect(String(error)).not.toContain(token);
      expect(error).not.toHaveProperty("cause");
    }
    if (kind === "overflow") expect(cancelled).toBe(true);
  }
});

test("download cancellation propagates the caller's reason", async () => {
  const controller = new AbortController();
  const reason = new Error("fixture abort");
  const api = new HttpTelegramApi(token, async () => {
    controller.abort(reason);
    throw new Error(token);
  });
  await expect(Array.fromAsync(api.downloadFile("file", 10, controller.signal))).rejects.toBe(
    reason,
  );
});
