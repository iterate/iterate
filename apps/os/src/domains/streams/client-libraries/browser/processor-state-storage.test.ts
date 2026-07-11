// Regression tests for the shared processor_state checkpoint table and for the
// browser-raw-events schema version reset, running against real SQLite via
// node:sqlite. The key regression: bumping BROWSER_RAW_EVENTS_SCHEMA_VERSION
// drops the events table, so it must also clear the processor_state checkpoint —
// a stale checkpoint over an empty mirror would skip historical replay and then
// wedge on the append-continuity trigger.

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../../schemas.ts";
import type { Stream } from "../../../../itx-api.generated.ts";
import {
  BROWSER_RAW_EVENTS_SCHEMA_VERSION,
  BrowserRawEventsContract,
  BrowserRawEventsProcessor,
  ensureBrowserRawEventsSchema,
  type BrowserRawEventsState,
} from "../processors/browser-raw-events/implementation.ts";
import {
  browserProcessorStateStorage,
  deleteBrowserProcessorState,
} from "./processor-state-storage.ts";
import type { SqlClient, SqlValue } from "./stream-browser-db.ts";

// node:sqlite rejects the number[] member of SqlValue; these tests never use it.
type ScalarSqlValue = Exclude<SqlValue, number[]>;

// Minimal SqlClient over node:sqlite. Each call to wrap() returns a distinct
// client object, which matters: createSchemaEnsurer memoizes per client, so a
// fresh client simulates a fresh page load over the same persisted database.
function wrap(db: DatabaseSync): SqlClient {
  return {
    exec: async (sql, params = []) => {
      return db.prepare(sql).all(...(params as ScalarSqlValue[])) as Record<string, SqlValue>[];
    },
    batch: async (statements, options) => {
      if (options?.transaction) db.exec("BEGIN");
      try {
        for (const statement of statements) {
          db.prepare(statement.sql).run(...((statement.params ?? []) as ScalarSqlValue[]));
        }
        if (options?.transaction) db.exec("COMMIT");
      } catch (error) {
        if (options?.transaction) db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** Minimal stream stub for tests that never call the richer stream capability methods. */
const stream = () => ({ append() {} }) as unknown as Stream;

function rawEvent(offset: number): StreamEvent {
  return {
    type: "test/raw",
    payload: { offset },
    offset,
    createdAt: new Date(0).toISOString(),
    path: "/tests/raw",
  };
}

function createRawEventsProcessor(sql: SqlClient) {
  const storage = browserProcessorStateStorage<BrowserRawEventsState>({
    sql,
    processorSlug: BrowserRawEventsContract.slug,
  });
  return new BrowserRawEventsProcessor({
    stream: stream(),
    path: "/tests/raw",
    projectId: null,
    sql,
    readState: storage.readState,
    writeState: storage.writeState,
  });
}

describe("browserProcessorStateStorage", () => {
  it("round-trips snapshots keyed by slug and subscription key", async () => {
    const sql = wrap(new DatabaseSync(":memory:"));
    const a = browserProcessorStateStorage<{ n: number }>({
      sql,
      processorSlug: "proc-a",
      subscriptionKey: "sub-1",
    });
    const b = browserProcessorStateStorage<{ n: number }>({
      sql,
      processorSlug: "proc-a",
      subscriptionKey: "sub-2",
    });

    expect(await a.readState()).toBeUndefined();

    await a.writeState({ offset: 3, state: { n: 1 } });
    await b.writeState({ offset: 9, state: { n: 2 } });
    await a.writeState({ offset: 4, state: { n: 5 } });

    expect(await a.readState()).toEqual({ offset: 4, state: { n: 5 } });
    expect(await b.readState()).toEqual({ offset: 9, state: { n: 2 } });
  });

  it("deletes one subscription key, or every row for a slug when the key is omitted", async () => {
    const sql = wrap(new DatabaseSync(":memory:"));
    const write = (slug: string, key: string) =>
      browserProcessorStateStorage({ sql, processorSlug: slug, subscriptionKey: key }).writeState({
        offset: 1,
        state: {},
      });
    const read = (slug: string, key: string) =>
      browserProcessorStateStorage({ sql, processorSlug: slug, subscriptionKey: key }).readState();

    await write("proc-a", "sub-1");
    await write("proc-a", "sub-2");
    await write("proc-b", "sub-1");

    await deleteBrowserProcessorState({ sql, processorSlug: "proc-a", subscriptionKey: "sub-1" });
    expect(await read("proc-a", "sub-1")).toBeUndefined();
    expect(await read("proc-a", "sub-2")).toBeDefined();

    await deleteBrowserProcessorState({ sql, processorSlug: "proc-a" });
    expect(await read("proc-a", "sub-2")).toBeUndefined();
    expect(await read("proc-b", "sub-1")).toBeDefined();
  });
});

describe("browser raw events schema version reset", () => {
  it("mirrors a batch and checkpoints through processor_state", async () => {
    const sql = wrap(new DatabaseSync(":memory:"));
    const processor = createRawEventsProcessor(sql);

    await processor.ingest({ events: [rawEvent(1), rawEvent(2)], streamMaxOffset: 2 });

    expect(await processor.snapshot()).toMatchObject({ offset: 2 });
    const rows = await sql.exec(`SELECT offset FROM events ORDER BY offset`);
    expect(rows.map((row) => Number(row.offset))).toEqual([1, 2]);
  });

  it("clears the checkpoint together with the dropped table on a version bump (regression)", async () => {
    const db = new DatabaseSync(":memory:");

    // First "page load": mirror two events at the current schema version.
    const firstLoad = createRawEventsProcessor(wrap(db));
    await firstLoad.ingest({ events: [rawEvent(1), rawEvent(2)], streamMaxOffset: 2 });
    expect(await firstLoad.snapshot()).toMatchObject({ offset: 2 });

    // Simulate the deployed BROWSER_RAW_EVENTS_SCHEMA_VERSION moving past what
    // this database was built with.
    db.exec(`PRAGMA user_version = ${BROWSER_RAW_EVENTS_SCHEMA_VERSION - 1}`);

    // Second "page load" (fresh SqlClient, so the schema ensurer re-runs): the
    // version reset must clear the checkpoint, not just drop the table.
    // Before the fix this snapshot reported offset 2 over an empty mirror, so
    // the server skipped historical replay and the first new insert hit the
    // append-continuity trigger.
    const secondLoad = createRawEventsProcessor(wrap(db));
    expect(await secondLoad.snapshot()).toMatchObject({ offset: 0 });

    // Full replay from the server rebuilds the mirror from offset 1.
    await secondLoad.ingest({
      events: [rawEvent(1), rawEvent(2), rawEvent(3)],
      streamMaxOffset: 3,
    });
    const sql = wrap(db);
    const rows = await sql.exec(`SELECT offset FROM events ORDER BY offset`);
    expect(rows.map((row) => Number(row.offset))).toEqual([1, 2, 3]);
    const [version] = await sql.exec(`PRAGMA user_version`);
    expect(Number(version?.user_version)).toBe(BROWSER_RAW_EVENTS_SCHEMA_VERSION);
  });

  it("resets before the checkpoint is read even when ingest is called without snapshot", async () => {
    const db = new DatabaseSync(":memory:");

    const firstLoad = createRawEventsProcessor(wrap(db));
    await firstLoad.ingest({ events: [rawEvent(1), rawEvent(2)], streamMaxOffset: 2 });

    db.exec(`PRAGMA user_version = ${BROWSER_RAW_EVENTS_SCHEMA_VERSION - 1}`);

    // Straight to ingest, no snapshot() first: prepare() must still run the
    // version reset before the stale checkpoint is memoized. Without that,
    // offsets 1-2 are filtered out against the stale cursor and inserting
    // offset 3 into the freshly-reset table trips the continuity trigger.
    const secondLoad = createRawEventsProcessor(wrap(db));
    await secondLoad.ingest({
      events: [rawEvent(1), rawEvent(2), rawEvent(3)],
      streamMaxOffset: 3,
    });

    const rows = await wrap(db).exec(`SELECT offset FROM events ORDER BY offset`);
    expect(rows.map((row) => Number(row.offset))).toEqual([1, 2, 3]);
  });

  it("leaves the mirror and checkpoint untouched when the version matches", async () => {
    const db = new DatabaseSync(":memory:");

    const firstLoad = createRawEventsProcessor(wrap(db));
    await firstLoad.ingest({ events: [rawEvent(1), rawEvent(2)], streamMaxOffset: 2 });

    const secondLoad = createRawEventsProcessor(wrap(db));
    expect(await secondLoad.snapshot()).toMatchObject({ offset: 2 });

    // Resume after the checkpoint: replayed offsets dedupe, new offsets append.
    await secondLoad.ingest({
      events: [rawEvent(2), rawEvent(3)],
      streamMaxOffset: 3,
    });
    const rows = await wrap(db).exec(`SELECT offset FROM events ORDER BY offset`);
    expect(rows.map((row) => Number(row.offset))).toEqual([1, 2, 3]);
  });

  it("the continuity trigger rejects a gap in mirrored offsets", async () => {
    const sql = wrap(new DatabaseSync(":memory:"));
    await ensureBrowserRawEventsSchema(sql);

    const insert = (offset: number) =>
      sql.exec(`INSERT INTO events (local_index, raw_jsonb) VALUES (?, jsonb(?))`, [
        offset - 1,
        JSON.stringify(rawEvent(offset)),
      ]);

    await insert(1);
    await expect(insert(3)).rejects.toThrow(/append continuously/);
  });
});

// The event_type_counts table replaces the UI's reactive COUNT(*) full scans
// (they starve ingest on deep mirrors — see the schema comment). Its one
// invariant: it always equals what COUNT(*) GROUP BY type would return.
describe("browser raw events incremental type counts", () => {
  const typedEvent = (offset: number, type: string): StreamEvent => ({
    ...rawEvent(offset),
    type,
  });

  const countsByType = async (sql: SqlClient) =>
    Object.fromEntries(
      (await sql.exec(`SELECT type, n FROM event_type_counts ORDER BY type`)).map((row) => [
        row.type,
        Number(row.n),
      ]),
    );

  it("tracks per-type counts through ingest, matching COUNT(*)", async () => {
    const sql = wrap(new DatabaseSync(":memory:"));
    const processor = createRawEventsProcessor(sql);

    await processor.ingest({
      events: [typedEvent(1, "a"), typedEvent(2, "b"), typedEvent(3, "a")],
      streamMaxOffset: 3,
    });
    await processor.ingest({ events: [typedEvent(4, "a")], streamMaxOffset: 4 });

    expect(await countsByType(sql)).toEqual({ a: 3, b: 1 });
    const scanned = await sql.exec(`SELECT type, COUNT(*) AS n FROM events GROUP BY type`);
    expect(Object.fromEntries(scanned.map((row) => [row.type, Number(row.n)]))).toEqual(
      await countsByType(sql),
    );
  });

  it("does not double-count a replayed duplicate (RAISE IGNORE skips the count trigger)", async () => {
    const db = new DatabaseSync(":memory:");
    const firstLoad = createRawEventsProcessor(wrap(db));
    await firstLoad.ingest({
      events: [typedEvent(1, "a"), typedEvent(2, "a")],
      streamMaxOffset: 2,
    });

    // A fresh page load resumes and the server replays an already-mirrored
    // offset: the before-insert trigger swallows it, so the count trigger
    // must never fire for it.
    const secondLoad = createRawEventsProcessor(wrap(db));
    await secondLoad.ingest({
      events: [typedEvent(2, "a"), typedEvent(3, "a")],
      streamMaxOffset: 3,
    });

    expect(await countsByType(wrap(db))).toEqual({ a: 3 });
  });

  it("a schema version reset drops the counts with the mirror", async () => {
    const db = new DatabaseSync(":memory:");
    const firstLoad = createRawEventsProcessor(wrap(db));
    await firstLoad.ingest({ events: [typedEvent(1, "a")], streamMaxOffset: 1 });
    expect(await countsByType(wrap(db))).toEqual({ a: 1 });

    db.exec(`PRAGMA user_version = ${BROWSER_RAW_EVENTS_SCHEMA_VERSION - 1}`);
    const secondLoad = createRawEventsProcessor(wrap(db));
    await secondLoad.ingest({
      events: [typedEvent(1, "b"), typedEvent(2, "b")],
      streamMaxOffset: 2,
    });

    // Only the rebuilt mirror's counts survive; nothing carried over from the
    // dropped generation.
    expect(await countsByType(wrap(db))).toEqual({ b: 2 });
  });
});
