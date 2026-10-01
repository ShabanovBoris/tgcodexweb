import { openDatabase } from "../../src/persistence/sqlite/Database";
import { migrateDatabase } from "../../src/persistence/sqlite/migrations";
import { SqliteConversationRepository } from "../../src/persistence/sqlite/SqliteConversationRepository";
import { SqliteRequestRepository } from "../../src/persistence/sqlite/SqliteRequestRepository";
import { SqliteUpdateDedupRepository } from "../../src/persistence/sqlite/SqliteUpdateDedupRepository";

// Isolated child process proves that repositories depend only on the durable database, not JS object state.
const database = openDatabase(process.argv[2]);
try {
  const conversations = new SqliteConversationRepository(database);
  const requests = new SqliteRequestRepository(database);
  const updates = new SqliteUpdateDedupRepository(database);
  process.stdout.write(
    JSON.stringify({
      migrations: migrateDatabase(database),
      active: conversations.getActive("123")?.id,
      request: requests.get("r1"),
      update: updates.get("1"),
      attachments: requests.listAttachments("r1"),
    }),
  );
} finally {
  database.close(true);
}
