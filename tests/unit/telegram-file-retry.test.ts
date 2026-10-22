import { expect, test } from "bun:test";
import { HttpTelegramApi } from "../../src/transports/telegram/TelegramApi";

const token = "123:SYNTHETIC_FILE_TOKEN";
const metadata = () =>
  Response.json({
    ok: true,
    result: { file_id: "file", file_path: "photos/file.jpg", file_size: 3 },
  });
const networkError = () => Object.assign(new Error(`private ${token}`), { code: "ECONNRESET" });

test("file download retries a transient metadata read before returning exact bytes", async () => {
  let calls = 0;
  const waits: number[] = [];
  const api = new HttpTelegramApi(
    token,
    async () => {
      if (++calls === 1) throw networkError();
      return calls === 2 ? metadata() : new Response("abc");
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  expect(Buffer.concat(await Array.fromAsync(api.downloadFile("file", 10))).toString()).toBe("abc");
  expect(calls).toBe(3);
  expect(waits).toEqual([1000]);
});

test("file download releases a failed body before retrying its read", async () => {
  let calls = 0,
    cancelled = false;
  const waits: number[] = [];
  const api = new HttpTelegramApi(
    token,
    async () => {
      calls++;
      if (calls % 2 === 1) return metadata();
      if (calls === 2)
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 503 },
        );
      expect(cancelled).toBe(true);
      return new Response("abc");
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  expect(Buffer.concat(await Array.fromAsync(api.downloadFile("file", 10))).toString()).toBe("abc");
  expect(calls).toBe(4);
  expect(waits).toEqual([1000]);
});

test("file download retry exhaustion exposes only a fixed stage and code", async () => {
  let calls = 0;
  const waits: number[] = [];
  const api = new HttpTelegramApi(
    token,
    async () => {
      calls++;
      throw networkError();
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  await expect(Array.fromAsync(api.downloadFile("file", 10))).rejects.toMatchObject({
    code: "ATTACHMENT_UNAVAILABLE",
    reason: "download_metadata",
  });
  expect(calls).toBe(3);
  expect(waits).toEqual([1000, 2000]);
});

test.each([400, 403, 429])(
  "file download does not retry permanent or unspecified flood errors (%i)",
  async (status) => {
    let calls = 0;
    const waits: number[] = [];
    const api = new HttpTelegramApi(
      token,
      async () => {
        calls++;
        return Response.json({ ok: false, error_code: status }, { status });
      },
      async (ms) => {
        waits.push(ms);
      },
    );
    await expect(Array.fromAsync(api.downloadFile("file", 10))).rejects.toThrow(
      "ATTACHMENT_UNAVAILABLE",
    );
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  },
);

test.each([2, 31])(
  "file download respects flood minimum %i within the shared 30-second budget",
  async (seconds) => {
    let calls = 0;
    const waits: number[] = [];
    const api = new HttpTelegramApi(
      token,
      async () => {
        if (++calls === 1)
          return Response.json(
            { ok: false, error_code: 429, parameters: { retry_after: seconds } },
            { status: 429 },
          );
        return calls === 2 ? metadata() : new Response("abc");
      },
      async (ms) => {
        waits.push(ms);
      },
    );
    if (seconds === 2) {
      expect(Buffer.concat(await Array.fromAsync(api.downloadFile("file", 10))).toString()).toBe(
        "abc",
      );
      expect(waits).toEqual([2000]);
    } else {
      await expect(Array.fromAsync(api.downloadFile("file", 10))).rejects.toThrow(
        "ATTACHMENT_UNAVAILABLE",
      );
      expect(waits).toEqual([]);
      expect(calls).toBe(1);
    }
  },
);

test("file download never appends a restarted stream after exposing partial bytes", async () => {
  let calls = 0,
    pulls = 0;
  const waits: number[] = [];
  const api = new HttpTelegramApi(
    token,
    async () => {
      if (++calls === 1) return metadata();
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("a"));
            else controller.error(networkError());
          },
        }),
      );
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  const received: Uint8Array[] = [];
  try {
    for await (const chunk of api.downloadFile("file", 10)) received.push(chunk);
    throw new Error("Expected partial-read failure");
  } catch (error) {
    expect(error).toMatchObject({ code: "ATTACHMENT_UNAVAILABLE", reason: "download_partial" });
    expect(String(error)).not.toContain(token);
    expect(error).not.toHaveProperty("cause");
  }
  expect(Buffer.concat(received).toString()).toBe("a");
  expect(calls).toBe(2);
  expect(waits).toEqual([]);
});

test("file download cancellation during retry wait preserves the caller reason", async () => {
  let calls = 0;
  const controller = new AbortController(),
    reason = new Error("fixture cancellation");
  const api = new HttpTelegramApi(
    token,
    async () => {
      calls++;
      throw networkError();
    },
    async (_ms, signal) => {
      controller.abort(reason);
      expect(signal.aborted).toBe(true);
      throw new Error(token);
    },
  );
  await expect(Array.fromAsync(api.downloadFile("file", 10, controller.signal))).rejects.toBe(
    reason,
  );
  expect(calls).toBe(1);
});

test("unclassified TLS download failure is not retried or exposed", async () => {
  let calls = 0;
  const waits: number[] = [];
  const api = new HttpTelegramApi(
    token,
    async () => {
      if (++calls === 1) return metadata();
      throw Object.assign(new Error(token), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  await expect(Array.fromAsync(api.downloadFile("file", 10))).rejects.toMatchObject({
    code: "ATTACHMENT_UNAVAILABLE",
    reason: "download_body",
  });
  expect(calls).toBe(2);
  expect(waits).toEqual([]);
});
