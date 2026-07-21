import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import type { CollabSessionStore } from "./collab-host.ts";
import { sqliteCollabStore } from "./collab-store.ts";
import { fakeSessionStore } from "./collab-store.fixtures.ts";

// node:sqlite needs Node ≥ 24 (stable) — on older CI runtimes the contract
// suite still runs against the fake, and the SQLite half skips loudly.
const sqlite = (() => {
  try {
    return createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => never;
    };
  } catch {
    return null;
  }
})();

/** The SQLite store against Node's real SQLite — the exact SQL that runs in
 * the Durable Object, exercised for real instead of via the in-memory fake. */
function nodeSqliteStore(): CollabSessionStore {
  const db = new (sqlite!.DatabaseSync as new (path: string) => {
    prepare(query: string): { all(...b: never[]): unknown[]; run(...b: never[]): unknown };
    exec(query: string): void;
  })(":memory:");
  return sqliteCollabStore({
    sql: {
      exec: (query: string, ...bindings: unknown[]) => {
        const statement = db.prepare(query);
        const rows = /^\s*(SELECT|PRAGMA)/i.test(query)
          ? (statement.all(...(bindings as never[])) as Record<string, unknown>[])
          : (statement.run(...(bindings as never[])), []);
        return { toArray: () => rows };
      },
    },
    // node:sqlite has no nested-transaction helper; the store only needs
    // atomicity, which BEGIN/COMMIT provides (throws roll back).
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
  });
}

const PATH = "/tasks/x.md";
const EPOCH = "e1";
const op = (version: number, clientId = "a", clientSeq = version) => ({
  changes: [version, "x"],
  clientId,
  clientSeq,
  version,
});

/** ONE behavioral contract, run against BOTH implementations — the retention
 * math (min of snapshot/base pruning) must never drift between them. */
const implementations: [string, () => CollabSessionStore][] = [
  ["fake", () => fakeSessionStore().store],
];
if (sqlite !== null) implementations.push(["sqlite", nodeSqliteStore]);

describe.each(implementations)("collab store contract (%s)", (_name, makeStore) => {
  test("birth: putSnapshot creates session + base idempotently", async () => {
    const store = makeStore();
    await store.putSnapshot(PATH, { clientSeqs: {}, content: "seed", epoch: EPOCH, version: 0 });
    expect(store.hasSession(PATH)).toBe(true);
    expect(store.livePaths()).toEqual([PATH]);
    expect(store.getBase(PATH)).toEqual({ content: "seed", version: 0 });
    // A later compaction snapshot must not reset the base or the session.
    await store.putSnapshot(PATH, { clientSeqs: {}, content: "later", epoch: EPOCH, version: 5 });
    expect(store.getBase(PATH)).toEqual({ content: "seed", version: 0 });
  });

  test("append round-trips ops and advances the dirty head", async () => {
    const store = makeStore();
    await store.putSnapshot(PATH, { clientSeqs: {}, content: "seed", epoch: EPOCH, version: 0 });
    await store.append(PATH, EPOCH, [op(0), op(1)]);
    expect(await store.readOps(PATH, EPOCH, -1)).toEqual([op(0), op(1)]);
    expect(await store.readOps(PATH, EPOCH, 0)).toEqual([op(1)]);
    expect(store.dirtySessions()).toEqual([PATH]);
    store.markFlushed(PATH, 2);
    expect(store.dirtySessions()).toEqual([]);
  });

  test("compaction prunes only BELOW the redline baseline", async () => {
    const store = makeStore();
    await store.putSnapshot(PATH, { clientSeqs: {}, content: "seed", epoch: EPOCH, version: 0 });
    await store.append(PATH, EPOCH, [op(0), op(1), op(2)]);
    // Compaction snapshot at v3 — but the baseline is still v0, so every op
    // stays reconstructable for the redline fold.
    await store.putSnapshot(PATH, { clientSeqs: {}, content: "v3", epoch: EPOCH, version: 3 });
    expect((await store.readOps(PATH, EPOCH, -1)).map((entry) => entry.version)).toEqual([0, 1, 2]);
    // A commit advances the baseline — NOW the covered ops may go.
    store.setBase(PATH, { content: "v3", version: 3 });
    expect(await store.readOps(PATH, EPOCH, -1)).toEqual([]);
    expect(store.getBase(PATH)).toEqual({ content: "v3", version: 3 });
  });

  test("commit-then-compact order also retains exactly the needed ops", async () => {
    const store = makeStore();
    await store.putSnapshot(PATH, { clientSeqs: {}, content: "seed", epoch: EPOCH, version: 0 });
    await store.append(PATH, EPOCH, [op(0), op(1)]);
    store.setBase(PATH, { content: "v2", version: 2 }); // commit first
    await store.append(PATH, EPOCH, [op(2), op(3)]);
    await store.putSnapshot(PATH, { clientSeqs: {}, content: "v4", epoch: EPOCH, version: 4 });
    // Baseline v2 keeps ops 2,3 (redline); snapshot v4 needs nothing below 4.
    expect((await store.readOps(PATH, EPOCH, -1)).map((entry) => entry.version)).toEqual([2, 3]);
  });

  test("endSession deletes everything durably", async () => {
    const store = makeStore();
    await store.putSnapshot(PATH, { clientSeqs: {}, content: "seed", epoch: EPOCH, version: 0 });
    await store.append(PATH, EPOCH, [op(0)]);
    store.endSession(PATH);
    expect(store.hasSession(PATH)).toBe(false);
    expect(store.livePaths()).toEqual([]);
    expect(store.getBase(PATH)).toBeNull();
    expect(await store.getSnapshot(PATH)).toBeNull();
    expect(await store.readOps(PATH, EPOCH, -1)).toEqual([]);
  });
});
