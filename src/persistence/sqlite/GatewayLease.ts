import { Database, SQLiteError } from "bun:sqlite";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseError } from "./Database";

// A separate SQLite file holds the process lease without blocking application DB writes.
// OS locks disappear on process death; the lock file must never be deleted to clear a lease.
export function acquireGatewayLease(databasePath: string): () => void {
  let lease: Database | undefined;
  try {
    const path = resolve(databasePath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const canonical = existsSync(path)
      ? realpathSync(path)
      : join(realpathSync(dirname(path)), basename(path));
    lease = new Database(`${canonical}-gateway-lock`, { create: true, strict: true });
    lease.run("PRAGMA busy_timeout = 0");
    lease.run("BEGIN EXCLUSIVE");
  } catch (cause) {
    lease?.close(true);
    const busy = cause instanceof SQLiteError && [5, 6].includes(cause.errno & 255);
    throw new DatabaseError(busy ? "gateway_busy" : "initialization_failed", cause);
  }
  const owned = lease;
  let released = false;
  return () => {
    if (released) return;
    owned.close(true);
    released = true;
  };
}
