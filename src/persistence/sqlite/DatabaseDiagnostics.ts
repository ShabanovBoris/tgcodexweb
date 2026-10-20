import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { DatabaseError } from "./Database";
import { inspectMigrations } from "./migrations";
import { SqliteRequestQueueRepository } from "./SqliteRequestQueueRepository";
import { SqliteRequestResultRepository } from "./SqliteRequestResultRepository";

export type DatabaseDiagnostic =
  | Readonly<{ state: "missing" }>
  | Readonly<{ state: "migration_required"; appliedMigrations: number; pendingMigrations: number }>
  | Readonly<{
      state: "ready";
      appliedMigrations: number;
      pendingMigrations: 0;
      queuedRequests: number;
      blockedRequests: number;
      pendingDeliveries: number;
      failedDeliveries: number;
      expiredDeliveries: number;
    }>
  | Readonly<{
      state: "unavailable";
      errorCode: "DATABASE_ERROR";
      reason: DatabaseError["reason"] | "integrity_check_failed";
    }>;

export function inspectDatabase(path: string): DatabaseDiagnostic {
  let database: Database | undefined;
  try {
    try {
      if (!statSync(path).isFile()) throw new Error();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { state: "missing" };
      throw error;
    }
    database = new Database(path, { readonly: true, strict: true });
    database.run("PRAGMA query_only = ON");
    database.run("PRAGMA busy_timeout = 1000");
    if (
      database.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check !==
        "ok" ||
      database.query("PRAGMA foreign_key_check").get()
    )
      return {
        state: "unavailable",
        errorCode: "DATABASE_ERROR",
        reason: "integrity_check_failed",
      };
    const history = inspectMigrations(database);
    if (history.pending > 0)
      return {
        state: "migration_required",
        appliedMigrations: history.applied,
        pendingMigrations: history.pending,
      };
    const snapshot = new SqliteRequestQueueRepository(database).snapshot();
    const deliveries = new SqliteRequestResultRepository(database).diagnostics();
    const at = new Date().toISOString();
    const expired = (entry: (typeof deliveries)[number]) =>
      entry.state === "expired" || entry.expiresAt <= at;
    return {
      state: "ready",
      appliedMigrations: history.applied,
      pendingMigrations: 0,
      queuedRequests: snapshot.queued.length,
      blockedRequests: snapshot.blocked.length,
      pendingDeliveries: deliveries.filter((entry) => !expired(entry) && entry.state === "pending")
        .length,
      failedDeliveries: deliveries.filter((entry) => !expired(entry) && entry.state === "failed")
        .length,
      expiredDeliveries: deliveries.filter(expired).length,
    };
  } catch (error) {
    return {
      state: "unavailable",
      errorCode: "DATABASE_ERROR",
      reason:
        error instanceof DatabaseError
          ? error.reason
          : database
            ? "repository_failed"
            : "initialization_failed",
    };
  } finally {
    database?.close(true);
  }
}
