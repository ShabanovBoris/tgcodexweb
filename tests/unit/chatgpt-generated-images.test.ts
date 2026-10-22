import { expect, test } from "bun:test";
import type { Locator } from "playwright-core";
import {
  downloadGeneratedImages,
  type GeneratedImageState,
} from "../../src/providers/chatgpt-web/GeneratedImages";
import { pngImage } from "../fixtures/generated-image";

const state = (urls: string[]): GeneratedImageState => ({
  present: true,
  status: "loaded",
  completionActionVisible: true,
  signature: "synthetic",
  sources: urls.map((url) => ({ url, width: 1, height: 1 })),
});
const source = "https://chatgpt.com/backend-api/estuary/content?id=synthetic";

test("a settled failed preview returns a fixed image error without fetching its signed source", async () => {
  let reads = 0;
  const turn = {
    evaluate: async () => {
      reads++;
      throw new Error("must not run");
    },
  } as unknown as Locator;
  expect(await downloadGeneratedImages(turn, { ...state([source]), status: "failed" })).toEqual({
    imageError: "GENERATED_IMAGE_UNAVAILABLE",
  });
  expect(reads).toBe(0);
});

test("a failed preview still propagates caller cancellation without a download", async () => {
  const controller = new AbortController();
  controller.abort(new Error("operator stopped"));
  await expect(
    downloadGeneratedImages(
      {} as Locator,
      { ...state([source]), status: "failed" },
      controller.signal,
    ),
  ).rejects.toBe(controller.signal.reason);
});

test.each([
  "http://chatgpt.com/backend-api/estuary/content?id=synthetic",
  "https://untrusted.example/backend-api/estuary/content?id=synthetic",
  "https://chatgpt.com/api/auth/session",
  "https://private:password@chatgpt.com/backend-api/estuary/content",
  "file:///private/data/image.png",
  "data:image/png;base64,invalid",
])("generated source %s cannot initiate a download or expose its URL", async (url) => {
  let reads = 0;
  const turn = {
    evaluate: async () => {
      reads++;
      throw new Error("must not run");
    },
  } as unknown as Locator;
  const result = await downloadGeneratedImages(turn, state([url]));
  expect(result).toEqual({ imageError: "GENERATED_IMAGE_UNAVAILABLE" });
  expect(reads).toBe(0);
  expect(JSON.stringify(result)).not.toContain(url);
});

test("partial retrieval preserves validated first image, shares byte budget and hides the failing signed source", async () => {
  const limits: number[] = [];
  const turn = {
    evaluate: async (_fn: unknown, input: { limit: number }) => {
      limits.push(input.limit);
      return limits.length === 1
        ? { mimeType: pngImage.mimeType, base64: pngImage.base64 }
        : { limitExceeded: true };
    },
  } as unknown as Locator;
  expect(await downloadGeneratedImages(turn, state([source, `${source}2`]))).toEqual({
    images: [pngImage],
    imageError: "GENERATED_IMAGE_LIMIT",
  });
  expect(limits).toEqual([20_000_000, 20_000_000 - Buffer.byteLength(pngImage.base64, "base64")]);
});

test("abort joins the bounded active read, propagates its reason and starts no next image", async () => {
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const controller = new AbortController();
  let reads = 0,
    settled = false;
  const turn = {
    evaluate: async () => {
      reads++;
      entered.resolve();
      await finish.promise;
      return { mimeType: pngImage.mimeType, base64: pngImage.base64 };
    },
  } as unknown as Locator;
  const operation = downloadGeneratedImages(turn, state([source, `${source}2`]), controller.signal);
  void operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await entered.promise;
  controller.abort(new Error("operator stopped"));
  await Promise.resolve();
  expect(settled).toBe(false);
  finish.resolve();
  await expect(operation).rejects.toBe(controller.signal.reason);
  expect(reads).toBe(1);
});
