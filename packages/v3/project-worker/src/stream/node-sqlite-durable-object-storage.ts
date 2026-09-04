/// <reference types="node" />
// node-sqlite-durable-object-storage.ts — the `DurableObjectStorageSlice` over node:sqlite, so the
// REAL Stream runs in plain Node (the memory pins: local workerd enforces no isolate memory limit,
// a capped V8 does). Faithful where memory is concerned: `exec` hands back node:sqlite's LAZY row
// iterator, as workerd's cursor is, and `transactionSync` is a real BEGIN/ROLLBACK, so a throw
// inside a commit undoes its rows. The cell ceiling workerd enforces (2 MB, SQLITE_TOOBIG) is not
// reproduced here: the typed modules refuse before it, coded (reduce-checkpoint.ts).
import { DatabaseSync } from "node:sqlite";
import type { DurableObjectStorageSlice } from "./stream-storage.ts";

export function nodeSqliteDurableObjectStorage(): DurableObjectStorageSlice & { close(): void } {
  const db = new DatabaseSync(":memory:");
  return {
    sql: {
      exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) {
        const statement = db.prepare(query);
        const bound = bindings as (string | number | null)[];
        // A write runs NOW (an un-consumed `iterate()` never executes); a read stays lazy.
        if (statement.columns().length === 0) {
          statement.run(...bound);
          return Object.assign([] as T[], { toArray: () => [] as T[] });
        }
        const rows = statement.iterate(...bound) as IterableIterator<T>;
        return Object.assign(rows, { toArray: () => [...rows] });
      },
    },
    transactionSync: <T>(closure: () => T): T => {
      db.exec("BEGIN");
      try {
        const result = closure();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    setAlarm: async () => {},
    close: () => db.close(),
  };
}
