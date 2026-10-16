import { z } from "zod";
import type {
  AttachmentService,
  IncomingAttachment,
  PreparedAttachments,
} from "../../application/AttachmentService";
import type { Conversation } from "../../domain/Conversation";
import { type AttachmentBatchRepository, batchText } from "../../ports/AttachmentBatchRepository";
import { AttachmentError } from "../../ports/AttachmentStore";
import type { ConversationRepository } from "../../ports/ConversationRepository";
import type { TelegramApi, TelegramUpdate } from "./TelegramApi";

type Message = NonNullable<TelegramUpdate["message"]>;
const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const documentSchema = z.object({
  file_id: z.string().min(1),
  file_name: z.string().min(1).optional(),
  mime_type: z.string().min(1).optional(),
  file_size: size.optional(),
});
const photoSchema = z
  .array(
    z.object({
      file_id: z.string().min(1),
      width: size.positive(),
      height: size.positive(),
      file_size: size.optional(),
    }),
  )
  .min(1);

export class TelegramFileCollector {
  constructor(
    private readonly dependencies: Readonly<{
      service: AttachmentService;
      batches: AttachmentBatchRepository;
      mappings: ConversationRepository;
      api: TelegramApi;
      fileUpload: boolean;
      ttlMs: number;
      now: () => string;
      newId: () => string;
    }>,
  ) {}

  private metadata(message: Message): IncomingAttachment {
    if (
      [
        message.audio,
        message.video,
        message.voice,
        message.animation,
        message.sticker,
        message.video_note,
      ].some((value) => value !== undefined)
    )
      throw new AttachmentError("ATTACHMENT_REJECTED");
    if (message.document !== undefined && message.photo === undefined) {
      const parsed = documentSchema.safeParse(message.document);
      if (parsed.success) {
        const file = parsed.data;
        const extension = (
          {
            "application/pdf": "pdf",
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/gif": "gif",
            "image/webp": "webp",
            "text/plain": "txt",
            "text/markdown": "md",
          } as Record<string, string>
        )[file.mime_type ?? ""];
        return {
          sourceFileId: file.file_id,
          filename: file.file_name ?? `document_${message.message_id}.${extension ?? "bin"}`,
          mimeType: file.mime_type,
          sizeBytes: file.file_size,
        };
      }
    }
    if (message.photo !== undefined && message.document === undefined) {
      const parsed = photoSchema.safeParse(message.photo);
      if (parsed.success) {
        const file = parsed.data.reduce((largest, next) =>
          next.width * next.height > largest.width * largest.height ? next : largest,
        );
        // PhotoSize supplies no MIME/name. This path accepts JPEG bytes; other supported images can be sent as documents.
        return {
          sourceFileId: file.file_id,
          filename: `photo_${message.message_id}.jpg`,
          mimeType: "image/jpeg",
          sizeBytes: file.file_size,
        };
      }
    }
    throw new AttachmentError("ATTACHMENT_REJECTED");
  }

  private mapping(userId: string, id: string): Conversation {
    const mapping = this.dependencies.mappings.get(id);
    if (
      !mapping ||
      mapping.telegramUserId !== userId ||
      mapping.archived ||
      mapping.status !== "ready"
    )
      throw new AttachmentError("ATTACHMENT_REJECTED");
    return mapping;
  }

  async collect(userId: string, message: Message, updateId: string, current: () => Conversation) {
    const { service, batches } = this.dependencies;
    if (!this.dependencies.fileUpload) throw new AttachmentError("ATTACHMENT_REJECTED");
    const now = this.dependencies.now();
    batches.expire(now);
    const existing = message.media_group_id
      ? batches.getGroup(userId, String(message.chat.id), message.media_group_id)
      : null;
    if (existing?.state === "closed") throw new AttachmentError("ATTACHMENT_REJECTED");
    if (
      message.media_group_id &&
      batches.getOpen(userId) &&
      batches.getOpen(userId)?.id !== existing?.id
    )
      throw new AttachmentError("ATTACHMENT_REJECTED");
    const mapping = this.mapping(userId, existing?.conversationId ?? current().id);
    const id = existing?.id ?? this.dependencies.newId();
    const file = this.metadata(message);
    const count = existing ? batches.items(existing.id).length : 0;
    if (count + 1 > service.options.maxFilesPerRequest)
      throw new AttachmentError("TOO_MANY_ATTACHMENTS");
    const prepared = await service.prepare(
      id,
      [file],
      (input) =>
        this.dependencies.api.downloadFile(input.sourceFileId, service.options.maxFileSizeBytes),
      now,
    );
    if (!message.media_group_id)
      return {
        kind: "single" as const,
        id,
        mapping,
        input: { text: message.caption || undefined, attachments: prepared.attachments },
        prepared,
      };
    try {
      batches.append(
        existing ?? {
          id,
          userId,
          chatId: String(message.chat.id),
          groupId: message.media_group_id,
          conversationId: mapping.id,
          createdAt: now,
          expiresAt: new Date(Date.parse(now) + this.dependencies.ttlMs).toISOString(),
          state: "open",
        },
        {
          updateId,
          messageId: message.message_id,
          caption: message.caption,
          attachment: prepared.attachments[0],
        },
      );
    } catch (error) {
      await service.cleanup(prepared.attachments);
      throw error;
    } finally {
      prepared.release();
    }
    return { kind: "staged" as const, count: count + 1, mapping };
  }

  pending(userId: string) {
    this.dependencies.batches.expire(this.dependencies.now());
    const batch = this.dependencies.batches.getOpen(userId);
    if (!batch) return null;
    const mapping = this.mapping(userId, batch.conversationId);
    const items = this.dependencies.batches.items(batch.id);
    return {
      id: batch.id,
      mapping,
      input: {
        text: batchText(items),
        attachments: items.map((item) => item.attachment),
        attachmentBatchId: batch.id,
      },
    };
  }

  async discard(userId: string): Promise<void> {
    const batch = this.dependencies.batches.getOpen(userId);
    if (batch)
      await this.dependencies.service.cleanup(this.dependencies.batches.close(userId, batch.id));
  }

  async releaseSingle(prepared: PreparedAttachments, accepted: boolean): Promise<void> {
    try {
      if (!accepted) await this.dependencies.service.cleanup(prepared.attachments);
    } finally {
      prepared.release();
    }
  }
}
