import { z } from "zod";

// Ссылка на transport file и generated storage key нужны для обработки; filename не является filesystem path.
export const attachmentSchema = z
  .strictObject({
    id: z.string().min(1),
    requestId: z.string().min(1),
    sourceFileId: z.string().min(1),
    filename: z.string().min(1),
    mimeType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    temporaryStorageKey: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    createdAt: z.iso.datetime(),
  })
  .readonly();
export type Attachment = z.infer<typeof attachmentSchema>;
