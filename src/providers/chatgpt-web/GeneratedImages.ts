import type { Locator } from "playwright-core";
import {
  type GeneratedImage,
  generatedImageSchema,
  maxGeneratedImages,
  maxGeneratedImageBytes,
  maxGeneratedResultBytes,
} from "../../domain/GeneratedImage";
import { CHATGPT_COMPLETION_ACTION_SELECTOR } from "./upstream/src/chatgpt-session";

type ImageSource = Readonly<{ url: string; width: number; height: number }>;
export type GeneratedImageState = Readonly<{
  present: boolean;
  status: "loading" | "loaded" | "failed";
  signature: string;
  completionActionVisible: boolean;
  sources: readonly ImageSource[];
}>;
export type GeneratedImageResult = Readonly<{
  images?: readonly GeneratedImage[];
  imageError?: "GENERATED_IMAGE_UNAVAILABLE" | "GENERATED_IMAGE_LIMIT";
}>;

// Only the exact correlated assistant turn is inspected. Avatars, user uploads and web-search images are not output files.
export async function observeGeneratedImages(turn: Locator): Promise<GeneratedImageState> {
  return turn.evaluate(
    (root, actionSelector) => {
      const rendered = (node: Element) => {
        for (let element: Element | null = node; element; element = element.parentElement) {
          const style = getComputedStyle(element);
          if (
            element.hasAttribute("hidden") ||
            element.getAttribute("aria-hidden") === "true" ||
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.opacity === "0"
          )
            return false;
        }
        return node.isConnected;
      };
      const galleries = [
        ...root.querySelectorAll('[data-testid="generated-image-gallery"]'),
      ].filter(rendered);
      const previews = galleries
        .flatMap((gallery) => [
          ...gallery.querySelectorAll<HTMLImageElement>(
            '[data-testid="generated-image-preview"] img',
          ),
        ])
        .filter(rendered);
      const sources = [
        ...new Map(
          previews.map((image) => [
            image.currentSrc || image.src,
            {
              url: image.currentSrc || image.src,
              width: image.naturalWidth,
              height: image.naturalHeight,
            },
          ]),
        ).values(),
      ];
      const last = galleries.at(-1);
      const completionActionVisible =
        !!last &&
        [...root.querySelectorAll(actionSelector)].some(
          (action) =>
            rendered(action) &&
            !last.contains(action) &&
            !!(last.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING),
        );
      const status =
        previews.length === 0 ||
        previews.some(
          (image) =>
            !image.complete ||
            !(
              image.currentSrc ||
              image.getAttribute("src")?.trim() ||
              image.getAttribute("srcset")?.trim()
            ),
        )
          ? "loading"
          : previews.some((image) => image.naturalWidth === 0 || image.naturalHeight === 0)
            ? "failed"
            : "loaded";
      return {
        present: galleries.length > 0,
        status,
        sources,
        signature: JSON.stringify({ status, sources }),
        completionActionVisible,
      };
    },
    CHATGPT_COMPLETION_ACTION_SELECTOR,
    { timeout: 2000 },
  );
}

export async function downloadGeneratedImages(
  turn: Locator,
  state: GeneratedImageState,
  signal?: AbortSignal,
): Promise<GeneratedImageResult> {
  const images: GeneratedImage[] = [];
  if (state.sources.length > maxGeneratedImages) return { imageError: "GENERATED_IMAGE_LIMIT" };
  if (state.status === "failed") {
    signal?.throwIfAborted();
    return { imageError: "GENERATED_IMAGE_UNAVAILABLE" };
  }
  let remaining = maxGeneratedResultBytes;
  for (const source of state.sources) {
    signal?.throwIfAborted();
    try {
      const url = new URL(source.url);
      if (
        url.origin !== "https://chatgpt.com" ||
        url.pathname !== "/backend-api/estuary/content" ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error("GENERATED_IMAGE_UNAVAILABLE");
      // Cookies remain in the browser. Never export auth headers or persist the signed source URL.
      const result = await turn.evaluate(
        async (_root, input) => {
          const response = await fetch(input.url, {
            credentials: "same-origin",
            redirect: "error",
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok || !response.body) throw new Error("GENERATED_IMAGE_UNAVAILABLE");
          const mimeType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
          if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType ?? ""))
            throw new Error("GENERATED_IMAGE_UNAVAILABLE");
          if (Number(response.headers.get("content-length")) > input.limit)
            return { limitExceeded: true as const };
          const reader = response.body.getReader();
          let size = 0,
            binary = "";
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.byteLength;
              if (size > input.limit) return { limitExceeded: true as const };
              for (let offset = 0; offset < next.value.length; offset += 8192)
                binary += String.fromCharCode(...next.value.subarray(offset, offset + 8192));
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          return { mimeType, base64: btoa(binary) };
        },
        { url: source.url, limit: Math.min(maxGeneratedImageBytes, remaining) },
        { timeout: 18000 },
      );
      signal?.throwIfAborted();
      if ("limitExceeded" in result)
        return { ...(images.length ? { images } : {}), imageError: "GENERATED_IMAGE_LIMIT" };
      const image = generatedImageSchema.parse({
        ...result,
        width: source.width,
        height: source.height,
      });
      remaining -= Buffer.byteLength(image.base64, "base64");
      images.push(image);
    } catch {
      signal?.throwIfAborted();
      return { ...(images.length ? { images } : {}), imageError: "GENERATED_IMAGE_UNAVAILABLE" };
    }
  }
  return images.length ? { images } : {};
}
