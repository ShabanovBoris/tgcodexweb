import { openDatabase } from "../../src/persistence/sqlite/Database";
import { SqliteRequestQueueRepository } from "../../src/persistence/sqlite/SqliteRequestQueueRepository";
import { attachment, later, request } from "./queue";

// Parent kills this process only after committed acceptance/claim; the stdin pipe is a crash-test barrier.
async function seed(): Promise<void> {
  const database = openDatabase(process.argv[2]);
  const store = new SqliteRequestQueueRepository(database);
  store.accept(
    request("z", "1"),
    { text: "synthetic first", attachments: [attachment("z", "z"), attachment("a", "z")] },
    3,
  );
  store.accept(request("a", "2", "alias"), { text: "synthetic second", attachments: [] }, 3);
  store.accept(request("m", "3"), { text: "synthetic third", attachments: [] }, 3);
  store.accept(
    request("independent", "4", "other"),
    { text: "synthetic independent", attachments: [] },
    3,
  );
  if (process.argv[3] === "sending") {
    store.claim("z", later);
    // Uploading began locally; no submission is fabricated before the simulated sending crash.
    const { SqliteRequestRepository } = await import(
      "../../src/persistence/sqlite/SqliteRequestRepository"
    );
    new SqliteRequestRepository(database).transition("z", { state: "sending", at: later });
  }
  process.stdout.write("committed\n");
  await Bun.stdin.text();
  database.close(true);
}

await seed();
