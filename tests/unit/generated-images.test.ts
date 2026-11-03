import { expect, test } from "bun:test";
import {
  generatedImageSchema,
  generatedImagesSchema,
  canSendImagePreview,
} from "../../src/domain/GeneratedImage";

import { pngImage } from "../fixtures/generated-image";

test("generated image values contain bounded validated bytes, never URLs or arbitrary content", () => {
  expect(generatedImageSchema.parse(pngImage)).toEqual(pngImage);
  for (const value of [
    { ...pngImage, base64: Buffer.from("<svg>private</svg>").toString("base64") },
    { ...pngImage, mimeType: "image/svg+xml" },
    { ...pngImage, base64: "https://private.example/image?sig=secret" },
    { ...pngImage, base64: `${pngImage.base64}\n` },
    { ...pngImage, width: 0 },
    { ...pngImage, url: "https://private.example" },
  ])
    expect(generatedImageSchema.safeParse(value).success).toBe(false);
  expect(generatedImagesSchema.safeParse(Array(5).fill(pngImage)).success).toBe(false);
  expect(canSendImagePreview(pngImage)).toBe(true);
  expect(canSendImagePreview({ ...pngImage, width: 9000, height: 2000 })).toBe(false);
  expect(canSendImagePreview({ ...pngImage, width: 100, height: 1 })).toBe(false);
});
