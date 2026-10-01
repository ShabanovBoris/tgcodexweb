import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  type Conversation,
  conversationSchema,
  type GatewayUser,
  userSchema,
} from "../../domain/Conversation";
import type { ConversationRepository } from "../../ports/ConversationRepository";
import { DatabaseError } from "./Database";
import { repositoryOperation } from "./repositoryOperation";

type ConversationRow = Omit<Conversation, "archived" | "providerUrl" | "lastUsedAt"> & {
  archived: number;
  providerUrl: string | null;
  lastUsedAt: string | null;
};
const columns = `c.id, c.telegram_user_id AS telegramUserId, c.alias,
  c.provider_conversation_id AS providerConversationId, c.provider_url AS providerUrl,
  c.status, c.created_at AS createdAt, c.updated_at AS updatedAt,
  c.last_used_at AS lastUsedAt, c.archived`;

// SQL null/INTEGER остаются внутри adapter; consumers получают валидированный business snapshot.
function conversationFromRow(row: ConversationRow): Conversation {
  return conversationSchema.parse({
    ...row,
    archived: row.archived === 1,
    providerUrl: row.providerUrl ?? undefined,
    lastUsedAt: row.lastUsedAt ?? undefined,
  });
}

// Adapter владеет local mappings и durable selection; ни один метод не удаляет remote conversation.
export class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly database: Database) {}

  // Повторная синхронизация authorization mapping меняет только enabled, сохраняя дату регистрации.
  putUser(input: GatewayUser): void {
    const user = userSchema.parse(input);
    repositoryOperation(() =>
      this.database
        .query(`INSERT INTO users VALUES (?, ?, ?)
      ON CONFLICT(telegram_user_id) DO UPDATE SET enabled=excluded.enabled WHERE enabled <> excluded.enabled`)
        .run(user.telegramUserId, Number(user.enabled), user.createdAt),
    );
  }

  // enabled является metadata, а не заменой transport allowlist guard.
  getUser(telegramUserId: string): GatewayUser | null {
    return repositoryOperation(() => {
      const row = this.database
        .query<{ telegramUserId: string; enabled: number; createdAt: string }, [string]>(
          "SELECT telegram_user_id AS telegramUserId, enabled, created_at AS createdAt FROM users WHERE telegram_user_id=?",
        )
        .get(telegramUserId);
      return row ? userSchema.parse({ ...row, enabled: row.enabled === 1 }) : null;
    });
  }

  // INSERT сохраняет uniqueness/FK, вместо replacement по слабому идентификатору.
  create(input: Conversation): void {
    const conversation = conversationSchema.parse(input);
    repositoryOperation(() =>
      this.database
        .query(`INSERT INTO conversations
      (id, telegram_user_id, alias, provider_conversation_id, provider_url, status, created_at, updated_at, last_used_at, archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          conversation.id,
          conversation.telegramUserId,
          conversation.alias,
          conversation.providerConversationId,
          conversation.providerUrl ?? null,
          conversation.status,
          conversation.createdAt,
          conversation.updatedAt,
          conversation.lastUsedAt ?? null,
          Number(conversation.archived),
        ),
    );
  }

  // Archived mapping остаётся адресуемым для request metadata после /remove.
  get(id: string): Conversation | null {
    return repositoryOperation(() => {
      const row = this.database
        .query<ConversationRow, [string]>(`SELECT ${columns} FROM conversations c WHERE c.id=?`)
        .get(id);
      return row ? conversationFromRow(row) : null;
    });
  }

  // Alias сравнивается точно, без скрытого case folding или изменения opaque identity.
  findByAlias(telegramUserId: string, alias: string): Conversation | null {
    return repositoryOperation(() => {
      const row = this.database
        .query<ConversationRow, [string, string]>(
          `SELECT ${columns} FROM conversations c WHERE c.telegram_user_id=? AND c.alias=? AND c.archived=0`,
        )
        .get(telegramUserId, alias);
      return row ? conversationFromRow(row) : null;
    });
  }

  // Публичный список исключает архив, не стирая historical references.
  list(telegramUserId: string): Conversation[] {
    return repositoryOperation(() =>
      this.database
        .query<ConversationRow, [string]>(
          `SELECT ${columns} FROM conversations c WHERE c.telegram_user_id=? AND c.archived=0 ORDER BY c.created_at, c.id`,
        )
        .all(telegramUserId)
        .map(conversationFromRow),
    );
  }

  // Один JOIN читает selection и mapping в одном SQLite snapshot.
  getActive(telegramUserId: string): Conversation | null {
    return repositoryOperation(() => {
      const row = this.database
        .query<ConversationRow, [string]>(
          `SELECT ${columns} FROM active_conversations a JOIN conversations c ON c.id=a.conversation_id AND c.telegram_user_id=a.telegram_user_id WHERE a.telegram_user_id=? AND c.archived=0`,
        )
        .get(telegramUserId);
      return row ? conversationFromRow(row) : null;
    });
  }

  // INSERT SELECT проверяет ownership и archived в том же statement, который меняет selection.
  select(telegramUserId: string, conversationId: string): void {
    repositoryOperation(() => {
      const result = this.database
        .query(`INSERT INTO active_conversations (telegram_user_id, conversation_id)
        SELECT telegram_user_id, id FROM conversations WHERE telegram_user_id=? AND id=? AND archived=0
        ON CONFLICT(telegram_user_id) DO UPDATE SET conversation_id=excluded.conversation_id`)
        .run(telegramUserId, conversationId);
      if (result.changes !== 1) throw new DatabaseError("invalid_selection");
    });
  }

  // Rename меняет только alias/updatedAt; provider identity и active pointer сохраняются.
  rename(id: string, alias: string, at: string): void {
    z.string().min(1).parse(alias);
    z.iso.datetime().parse(at);
    repositoryOperation(() => {
      const result = this.database
        .query("UPDATE conversations SET alias=?, updated_at=? WHERE id=? AND archived=0")
        .run(alias, at, id);
      if (result.changes !== 1) throw new DatabaseError("entity_not_found");
    });
  }

  // Clear selection и archive являются одной транзакцией, чтобы после restart не было dangling active alias.
  archive(id: string, at: string): void {
    z.iso.datetime().parse(at);
    repositoryOperation(() =>
      this.database
        .transaction(() => {
          const result = this.database
            .query("UPDATE conversations SET archived=1, updated_at=? WHERE id=? AND archived=0")
            .run(at, id);
          if (result.changes !== 1) throw new DatabaseError("entity_not_found");
          this.database.query("DELETE FROM active_conversations WHERE conversation_id=?").run(id);
        })
        .immediate(),
    );
  }
}
