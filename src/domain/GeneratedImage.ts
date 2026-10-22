import { z } from "zod";

export const maxGeneratedImages = 4;
export const maxGeneratedImageBytes = 20_000_000;
export const maxGeneratedResultBytes = 20_000_000;

export const generatedImageSchema = z
  .strictObject({
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000),
    base64: z
      .string()
      .min(4)
      .max(Math.ceil(maxGeneratedImageBytes / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .superRefine((image, context) => {
    const bytes = Buffer.from(image.base64, "base64");
    const signature =
      image.mimeType === "image/png"
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : image.mimeType === "image/jpeg"
          ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
          : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    if (
      !signature ||
      bytes.length > maxGeneratedImageBytes ||
      bytes.toString("base64") !== image.base64
    )
      context.addIssue({ code: "custom", message: "Invalid generated image" });
  })
  .readonly();
export type GeneratedImage = z.infer<typeof generatedImageSchema>;
export const generatedImagesSchema = z
  .array(generatedImageSchema)
  .max(maxGeneratedImages)
  .refine(
    (images) =>
      images.reduce((sum, image) => sum + Buffer.byteLength(image.base64, "base64"), 0) <=
      maxGeneratedResultBytes,
  )
  .readonly();

export function canSendImagePreview(image: GeneratedImage): boolean {
  return (
    image.mimeType !== "image/webp" &&
    Buffer.byteLength(image.base64, "base64") <= 10_000_000 &&
    image.width + image.height <= 10_000 &&
    Math.max(image.width, image.height) / Math.min(image.width, image.height) <= 20
  );
}
