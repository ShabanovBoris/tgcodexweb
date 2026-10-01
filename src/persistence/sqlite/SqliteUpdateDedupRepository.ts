import type { Database } from "bun:sqlite";
import {
  type ProcessedUpdate,
  processedUpdateSchema,
  type UpdateDedupRepository,
} from "../../ports/UpdateDedupRepository";
import { repositoryOperation } from "./repositoryOperation";

// Marker неизменяем; повторный INSERT отклоняется, не подменяя исходный requestId.
export class SqliteUpdateDedupRepository implements UpdateDedupRepository {
  constructor(private readonly database: Database) {}

  // FK запрещает dangling request reference; разные updates могут ссылаться на один logical request.
  record(input: ProcessedUpdate): void {
    const update = processedUpdateSchema.parse(input);
    repositoryOperation(() =>
      this.database
        .query(
          "INSERT INTO processed_updates (telegram_update_id, request_id, processed_at) VALUES (?, ?, ?)",
        )
        .run(update.telegramUpdateId, update.requestId ?? null, update.processedAt),
    );
  }

  // Read-only lookup является persistence primitive, не deduplication service.
  get(telegramUpdateId: string): ProcessedUpdate | null {
    return repositoryOperation(() => {
      const row = this.database
        .query<Omit<ProcessedUpdate, "requestId"> & { requestId: string | null }, [string]>(
          "SELECT telegram_update_id AS telegramUpdateId, request_id AS requestId, processed_at AS processedAt FROM processed_updates WHERE telegram_update_id=?",
        )
        .get(telegramUpdateId);
      return row
        ? processedUpdateSchema.parse({ ...row, requestId: row.requestId ?? undefined })
        : null;
    });
  }
}
