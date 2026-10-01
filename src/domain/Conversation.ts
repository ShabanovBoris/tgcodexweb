import { z } from "zod";

// Здесь хранится локальная привязка; remote history и browser auth принадлежат другим владельцам.
export const conversationSchema = z
  .strictObject({
    id: z.string().min(1),
    telegramUserId: z.string().regex(/^[1-9][0-9]*$/),
    alias: z.string().min(1),
    providerConversationId: z.string().min(1),
    providerUrl: z.string().min(1).optional(),
    status: z.enum(["ready", "unavailable", "unknown"]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().optional(),
    archived: z.boolean(),
  })
  .readonly();
export type Conversation = z.infer<typeof conversationSchema>;

// Persisted users обеспечивают ownership FK; проверка allowlist остаётся обязанностью будущего transport.
export const userSchema = z
  .strictObject({
    telegramUserId: z.string().regex(/^[1-9][0-9]*$/),
    enabled: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .readonly();
export type GatewayUser = z.infer<typeof userSchema>;

// MVP имеет один provider/profile: opaque ID уже каноничен, alias/URL/local ID не меняют ключ.
export function canonicalConversationKey(
  conversation: Pick<Conversation, "providerConversationId">,
): string {
  return conversation.providerConversationId;
}
