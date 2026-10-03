import { z } from "zod";
import type { Conversation } from "../domain/Conversation";
import { type ChatProvider, ProviderOperationError } from "../ports/ChatProvider";
import type { ConversationRepository } from "../ports/ConversationRepository";

export class ConversationError extends Error {
  constructor(
    readonly code: "ALIAS_EXISTS" | "INVALID_ALIAS" | "CHAT_NOT_FOUND" | "NO_ACTIVE_CHAT",
  ) {
    super(code);
  }
}

const aliasSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^\s\p{Cc}\p{Cf}]+$/u);
const providerConversationSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1).optional(),
});

export class ConversationService {
  constructor(
    private readonly repository: ConversationRepository,
    private readonly provider: ChatProvider,
    private readonly now: () => string,
    private readonly newId: () => string,
  ) {}

  authorizeUser(telegramUserId: string): void {
    this.repository.putUser({ telegramUserId, enabled: true, createdAt: this.now() });
  }

  async create(telegramUserId: string, alias?: string): Promise<Conversation> {
    const name = alias ?? this.nextAlias(telegramUserId);
    this.availableAlias(telegramUserId, name);
    const remote = await this.remote(() => this.provider.createConversation({ titleHint: name }));
    return this.bind(telegramUserId, name, remote);
  }

  async add(telegramUserId: string, alias: string, reference: string): Promise<Conversation> {
    this.availableAlias(telegramUserId, alias);
    const remote = await this.remote(() => this.provider.inspectConversation(reference));
    return this.bind(telegramUserId, alias, remote);
  }

  list(telegramUserId: string): Conversation[] {
    return this.repository.list(telegramUserId);
  }

  current(telegramUserId: string): Conversation {
    const conversation = this.repository.getActive(telegramUserId);
    if (!conversation) throw new ConversationError("NO_ACTIVE_CHAT");
    return conversation;
  }

  use(telegramUserId: string, alias: string): Conversation {
    const conversation = this.find(telegramUserId, alias);
    this.repository.select(telegramUserId, conversation.id);
    return conversation;
  }

  rename(telegramUserId: string, oldAlias: string, alias: string): void {
    const conversation = this.find(telegramUserId, oldAlias);
    this.validateAlias(alias);
    const existing = this.repository.findByAlias(telegramUserId, alias);
    if (existing && existing.id !== conversation.id) throw new ConversationError("ALIAS_EXISTS");
    this.repository.rename(telegramUserId, conversation.id, alias, this.now());
  }

  remove(telegramUserId: string, alias: string): void {
    this.repository.archive(telegramUserId, this.find(telegramUserId, alias).id, this.now());
  }

  private find(telegramUserId: string, alias: string): Conversation {
    const conversation = this.repository.findByAlias(telegramUserId, alias);
    if (!conversation) throw new ConversationError("CHAT_NOT_FOUND");
    return conversation;
  }

  private async remote(operation: () => Promise<unknown>): Promise<unknown> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ProviderOperationError) throw error;
      throw new ProviderOperationError("PROVIDER_UNAVAILABLE");
    }
  }

  private validateAlias(alias: string): void {
    if (!aliasSchema.safeParse(alias).success) throw new ConversationError("INVALID_ALIAS");
  }

  private availableAlias(telegramUserId: string, alias: string): void {
    this.validateAlias(alias);
    if (this.repository.findByAlias(telegramUserId, alias))
      throw new ConversationError("ALIAS_EXISTS");
  }

  private nextAlias(telegramUserId: string): string {
    let number = 1;
    while (this.repository.findByAlias(telegramUserId, `chat-${number}`)) number++;
    return `chat-${number}`;
  }

  private bind(telegramUserId: string, alias: string, value: unknown): Conversation {
    const parsed = providerConversationSchema.safeParse(value);
    if (!parsed.success) throw new ProviderOperationError("PROVIDER_UNAVAILABLE");
    // Identity is supplied by the provider; never derive a canonical key from the reference or URL.
    this.availableAlias(telegramUserId, alias);
    const at = this.now();
    const conversation: Conversation = {
      id: this.newId(),
      telegramUserId,
      alias,
      providerConversationId: parsed.data.id,
      providerUrl: parsed.data.url,
      status: "ready",
      archived: false,
      createdAt: at,
      updatedAt: at,
    };
    this.repository.create(conversation);
    this.repository.select(telegramUserId, conversation.id);
    return conversation;
  }
}
