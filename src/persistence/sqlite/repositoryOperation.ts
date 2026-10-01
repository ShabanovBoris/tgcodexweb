import { SQLiteError } from "bun:sqlite";
import { RequestTransitionError } from "../../domain/Request";
import { DatabaseError } from "./Database";

// Общая граница трёх SQLite adapters скрывает raw SQL errors, сохраняя domain transition errors.
export function repositoryOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof DatabaseError || cause instanceof RequestTransitionError) throw cause;
    if (cause instanceof SQLiteError) {
      if (
        cause.code === "SQLITE_CONSTRAINT_UNIQUE" ||
        cause.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
      )
        throw new DatabaseError("unique_conflict", cause);
      if (cause.code === "SQLITE_CONSTRAINT_FOREIGNKEY")
        throw new DatabaseError("foreign_key_violation", cause);
      if ((cause.errno & 255) === 19) throw new DatabaseError("constraint_violation", cause);
    }
    throw new DatabaseError("repository_failed", cause);
  }
}
