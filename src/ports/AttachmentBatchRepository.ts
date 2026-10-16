import type { Attachment } from "../domain/Attachment";

export type AttachmentBatch = Readonly<{
  id: string;
  userId: string;
  chatId: string;
  groupId: string;
  conversationId: string;
  createdAt: string;
  expiresAt: string;
  state: "open" | "closed";
}>;
export type AttachmentBatchItem = Readonly<{
  updateId: string;
  messageId: number;
  caption?: string;
  attachment: Attachment;
}>;
export interface AttachmentBatchRepository {
  getOpen(userId: string): AttachmentBatch | null;
  getGroup(userId: string, chatId: string, groupId: string): AttachmentBatch | null;
  items(batchId: string): readonly AttachmentBatchItem[];
  append(batch: AttachmentBatch, item: AttachmentBatchItem): void;
  close(userId: string, batchId: string): readonly Attachment[];
  expire(at: string): void;
  retainedStorageKeys(): ReadonlySet<string>;
}

export function batchText(items: readonly AttachmentBatchItem[]): string | undefined {
  const text = items
    .filter((item) => item.caption !== undefined)
    .map((item) => item.caption)
    .join("\n");
  return text || undefined;
}
