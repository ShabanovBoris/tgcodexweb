import { expect, test } from "bun:test";
import { HttpTelegramApi } from "../../src/transports/telegram/TelegramApi";
import { pngImage } from "../fixtures/generated-image";

test.skipIf(process.env.TGWEBGPT_TELEGRAM_HTTP_TEST !== "1")(
  "media uploads use separate connections after identity and preserve multipart bytes",
  async () => {
    const connections: { method: string; port: number }[] = [];
    const uploads: FormData[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request, server) {
        const method = new URL(request.url).pathname.split("/").at(-1) as string;
        const address = server.requestIP(request);
        if (!address) throw new Error("Local client address missing");
        connections.push({ method, port: address.port });
        if (method === "getMe")
          return Response.json({ ok: true, result: { id: 123, is_bot: true, username: "local" } });
        uploads.push(await request.formData());
        return Response.json({ ok: true, result: { message_id: 100 + uploads.length } });
      },
    });
    try {
      const api = new HttpTelegramApi("123:synthetic", (url, input) =>
        fetch(new URL(new URL(url).pathname, server.url), input),
      );
      await api.getMe();
      for (const kind of ["photo", "document"] as const)
        await api.sendImage({
          chatId: "123",
          replyTo: "77",
          image: pngImage,
          kind,
          filename: "original-1.png",
        });
      await api.getMe();

      expect(connections.map((entry) => entry.method)).toEqual([
        "getMe",
        "sendPhoto",
        "sendDocument",
        "getMe",
      ]);
      const [identity, photo, document, finalIdentity] = connections;
      expect(photo.port).not.toBe(identity.port);
      expect(document.port).not.toBe(identity.port);
      expect(document.port).not.toBe(photo.port);
      expect(finalIdentity.port).toBe(identity.port);
      for (const [index, kind] of ["photo", "document"].entries()) {
        const form = uploads[index];
        expect(form.get("chat_id")).toBe("123");
        expect(JSON.parse(form.get("reply_parameters") as string)).toEqual({
          message_id: 77,
          allow_sending_without_reply: true,
        });
        const file = form.get(kind) as File;
        expect(file.name).toBe("original-1.png");
        expect(file.type).toBe("image/png");
        expect(Buffer.from(await file.arrayBuffer()).toString("base64")).toBe(pngImage.base64);
      }
      expect(uploads[1].get("caption")).toBe("Скачать оригинал");
      expect(uploads[1].get("disable_content_type_detection")).toBe("true");
    } finally {
      await server.stop(true);
    }
  },
  10000,
);
