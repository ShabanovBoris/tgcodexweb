import { expect, test } from "bun:test";
import { HttpTelegramApi } from "../../src/transports/telegram/TelegramApi";

test.skipIf(process.env.TGWEBGPT_TELEGRAM_HTTP_TEST !== "1").each(["metadata", "body"] as const)(
  "local HTTP file download recovers a %s 503 with exact bytes",
  async (stage) => {
    const calls: string[] = [],
      waits: number[] = [];
    const bytes = new Uint8Array([255, 216, 255, 10, 20, 30]);
    let failed = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const method = path.endsWith("/getMe")
          ? "getMe"
          : path.endsWith("/getFile")
            ? "getFile"
            : "body";
        calls.push(method);
        if (method === "getMe")
          return Response.json({ ok: true, result: { id: 123, is_bot: true, username: "local" } });
        if (method === "getFile") expect(await request.json()).toEqual({ file_id: "file" });
        if (!failed && (stage === "metadata" ? method === "getFile" : method === "body")) {
          failed = true;
          return Response.json({ ok: false, error_code: 503 }, { status: 503 });
        }
        return method === "getFile"
          ? Response.json({
              ok: true,
              result: { file_id: "file", file_path: "photos/file.jpg", file_size: bytes.length },
            })
          : new Response(bytes, { headers: { "content-type": "image/jpeg" } });
      },
    });
    try {
      const api = new HttpTelegramApi(
        "123:synthetic",
        (url, input) => fetch(new URL(new URL(url).pathname, server.url), input),
        async (ms) => {
          waits.push(ms);
        },
      );
      await api.getMe();
      const actual = Buffer.concat(await Array.fromAsync(api.downloadFile("file", 100)));
      expect(actual).toEqual(Buffer.from(bytes));
      expect(waits).toEqual([1000]);
      expect(calls).toEqual(
        stage === "metadata"
          ? ["getMe", "getFile", "getFile", "body"]
          : ["getMe", "getFile", "body", "getFile", "body"],
      );
    } finally {
      await server.stop(true);
    }
  },
  10000,
);
