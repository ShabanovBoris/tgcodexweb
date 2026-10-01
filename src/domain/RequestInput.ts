import { z } from "zod";
import { attachmentSchema } from "./Attachment";

// Вход принадлежит одному выполнению; readonly snapshot не становится локальной историей разговора.
export const requestInputSchema = z
  .strictObject({
    text: z.string().min(1).optional(),
    attachments: z.array(attachmentSchema).readonly(),
  })
  .refine((input) => input.text !== undefined || input.attachments.length > 0)
  .readonly();
export type RequestInput = z.infer<typeof requestInputSchema>;
