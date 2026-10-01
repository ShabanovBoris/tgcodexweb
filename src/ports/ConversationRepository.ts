import type { Conversation, GatewayUser } from "../domain/Conversation";

// Core видит business data; synchronous контракт соответствует одному локальному SQLite owner.
export interface ConversationRepository {
  putUser(user: GatewayUser): void;
  getUser(telegramUserId: string): GatewayUser | null;
  create(conversation: Conversation): void;
  get(id: string): Conversation | null;
  findByAlias(telegramUserId: string, alias: string): Conversation | null;
  list(telegramUserId: string): Conversation[];
  getActive(telegramUserId: string): Conversation | null;
  select(telegramUserId: string, conversationId: string): void;
  rename(id: string, alias: string, at: string): void;
  archive(id: string, at: string): void;
}
