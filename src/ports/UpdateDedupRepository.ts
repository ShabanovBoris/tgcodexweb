import { z } from "zod";

// Nullable requestId сохраняет command updates без создания ложного logical request.
export const processedUpdateSchema = z
  .strictObject({
    telegramUpdateId: z.string().regex(/^(0|[1-9][0-9]*)$/),
    requestId: z.string().min(1).optional(),
    processedAt: z.iso.datetime(),
  })
  .readonly();
export type ProcessedUpdate = z.infer<typeof processedUpdateSchema>;

// record never overwrites ingress evidence. R5 acceptance can bind a staged album marker
// from no request to its one Request atomically; an existing request binding never changes.
export interface UpdateDedupRepository {
  record(update: ProcessedUpdate): void;
  get(telegramUpdateId: string): ProcessedUpdate | null;
}
