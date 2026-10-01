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

// Immutable marker хранит ingress evidence; orchestration дедупликации появится только в R2.
export interface UpdateDedupRepository {
  record(update: ProcessedUpdate): void;
  get(telegramUpdateId: string): ProcessedUpdate | null;
}
