// Tests for the browser processors' durable state against real SQLite via
// node:sqlite, driven the way production drives them: a StreamProcessorRunner
// per processor whose progress lives in the transactional browser progress
// store (`processor_progress`), with projection writes and the two-cursor
// record committed in ONE transaction.
//
// The load-bearing regressions pinned here:
//   - bumping BROWSER_RAW_EVENTS_SCHEMA_VERSION drops the events table, so it
//     must also REWIND the resume cursor in the same transaction — a stale
//     cursor over an empty mirror would skip historical replay and silently
//     rebuild without the skipped prefix (the gap-tolerant trigger accepts
//     the hole);
//   - a commit that fails for ANY reason (revision fence, projection trigger)
//     rolls back the projection writes AND the progress record together.

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../../schemas.ts";
import type { Stream } from "../../../../itx-api.generated.ts";
import type { StreamProcessor } from "../../stream-processor.ts";
import { StreamProcessorRunner, type ProcessorProgress } from "../../stream-processor-runner.ts";
import {
  BROWSER_RAW_EVENTS_SCHEMA_VERSION,
  BROWSER_RAW_EVENTS_TABLES,
  BrowserRawEventsContract,
  BrowserRawEventsProcessor,
  ensureBrowserRawEventsSchema,
  type BrowserRawEventsState,
} from "../processors/browser-raw-events/implementation.ts";
import {
  BrowserFeedContract,
  BrowserFeedProcessor,
} from "../processors/browser-feed/implementation.ts";
import {
  browserProcessorProgressStore,
  deleteBrowserProcessorState,
  discardBrowserProcessorProjection,
  ensureBrowserProcessorProgressSchema,
  resetBrowserProcessorProjection,
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

/** Minimal stream stub: the runner only reaches for it on refolds/self-pulls,
 * which these tests never trigger (frames are stamped at their own tail and
 * resets rewind to offset 0, where the refold reads nothing). */
const stream = () =>
  ({
    append: async () => [],
    at() {
      return this;
    },
    readEvents: () => ({
      next: async () => [],
      [Symbol.dispose]: () => {},
    }),
  }) as unknown as Stream;

function rawEvent(offset: number, type = "test/raw"): StreamEvent {
  return {
    type,
    payload: { offset },
    offset,
    createdAt: new Date(0).toISOString(),
    path: "/tests/raw",
  };
}

/** One "page load": a processor + transactional progress store + runner over the db. */
function rawEventsLoad(db: DatabaseSync) {
  const sql = wrap(db);
  const processor = new BrowserRawEventsProcessor({
    stream: stream(),
    path: "/tests/raw",
    projectId: null,
    sql,
  });
  const progress = browserProcessorProgressStore<BrowserRawEventsState>({
    sql,
    processorSlug: BrowserRawEventsContract.slug,
    ensureProjectionSchema: (client) => processor.ensureProjectionSchema(client),
    projection: processor.projectionBuffer,
  });
  const runner = new StreamProcessorRunner({
    processor: processor as unknown as StreamProcessor<any, any>,
    stream: stream(),
    durability: { progress },
  });
  return {
    sql,
    processor,
    progress,
    runner,
    /** Deliver one frame, stamped at its own tail unless overridden. */
    async deliver(events: StreamEvent[], streamMaxOffset?: number) {
      const opened = await runner.openDelivery();
      await opened.sink({
        events,
        scannedAfterOffset: opened.checkpointOffset,
        scannedThroughOffset: events.at(-1)?.offset ?? opened.checkpointOffset,
        streamMaxOffset: streamMaxOffset ?? events.at(-1)!.offset,
      });
    },
  };
}

const readProgressRow = (sql: SqlClient, slug: string) =>
  sql.exec(
    `SELECT reducer_version, reduced_through_offset, acknowledged_through_offset, cursor_revision
     FROM processor_progress WHERE processor_slug = ?`,
    [slug],
  );

const mirroredOffsets = async (sql: SqlClient) =>
  (await sql.exec(`SELECT offset FROM events ORDER BY offset`)).map((row) => Number(row.offset));

describe("deleteBrowserProcessorState", () => {
  it("deletes one subscription key, or every row for a slug when the key is omitted", async () => {
    const sql = wrap(new DatabaseSync(":memory:"));
    await ensureBrowserProcessorProgressSchema(sql);
    // Raw progress rows (the retired-slug lane this function exists for).
    const write = (slug: string, key: string) =>
      sql.exec(
        `INSERT INTO processor_progress (
           processor_slug, subscription_key, reducer_version, reduced_through_offset,
           reduced_state, acknowledged_through_offset, cursor_revision
         ) VALUES (?, ?, 'v', 1, '{}', 1, 0)`,
        [slug, key],
      );
    const read = async (slug: string, key: string) =>
      (
        await sql.exec(
          `SELECT 1 AS present FROM processor_progress
           WHERE processor_slug = ? AND subscription_key = ?`,
          [slug, key],
        )
      )[0];

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
  it("mirrors a frame and commits the cursor through the transactional progress store", async () => {
    const db = new DatabaseSync(":memory:");
    const load = rawEventsLoad(db);

    await load.deliver([rawEvent(1), rawEvent(2)]);

    expect(await load.runner.snapshot()).toMatchObject({ offset: 2 });
    expect(await mirroredOffsets(load.sql)).toEqual([1, 2]);
    const [progress] = await readProgressRow(load.sql, BrowserRawEventsContract.slug);
    expect(progress).toMatchObject({ acknowledged_through_offset: 2, cursor_revision: 0 });
  });

  it("rewinds the cursor together with the dropped table on a version bump (regression)", async () => {
    const db = new DatabaseSync(":memory:");

    // First "page load": mirror two events at the current schema version.
    const firstLoad = rawEventsLoad(db);
    await firstLoad.deliver([rawEvent(1), rawEvent(2)]);
    expect(await firstLoad.runner.snapshot()).toMatchObject({ offset: 2 });

    // Simulate the deployed BROWSER_RAW_EVENTS_SCHEMA_VERSION moving past what
    // this database was built with.
    db.exec(`PRAGMA user_version = ${BROWSER_RAW_EVENTS_SCHEMA_VERSION - 1}`);

    // Second "page load" (fresh SqlClient, so the schema ensurer re-runs): the
    // version reset must rewind the cursor, not just drop the table. Before
    // the fix this cursor reported offset 2 over an empty mirror, so the
    // server skipped historical replay — a permanent silent hole in the
    // mirror (the gap-tolerant trigger accepts it).
    const secondLoad = rawEventsLoad(db);
    expect(await secondLoad.runner.snapshot()).toMatchObject({ offset: 0 });
    // The rewind BUMPS the revision (never deletes the row): an in-flight
    // commit from the pre-reset incarnation must fence, not land.
    const [progress] = await readProgressRow(secondLoad.sql, BrowserRawEventsContract.slug);
    expect(progress).toMatchObject({ acknowledged_through_offset: 0, cursor_revision: 1 });

    // Full replay from the server rebuilds the mirror from offset 1.
    await secondLoad.deliver([rawEvent(1), rawEvent(2), rawEvent(3)]);
    expect(await mirroredOffsets(secondLoad.sql)).toEqual([1, 2, 3]);
    const [version] = await secondLoad.sql.exec(`PRAGMA user_version`);
    expect(Number(version?.user_version)).toBe(BROWSER_RAW_EVENTS_SCHEMA_VERSION);
  });

  it("resets before the cursor is read even when frames arrive without a snapshot read", async () => {
    const db = new DatabaseSync(":memory:");

    const firstLoad = rawEventsLoad(db);
    await firstLoad.deliver([rawEvent(1), rawEvent(2)]);

    db.exec(`PRAGMA user_version = ${BROWSER_RAW_EVENTS_SCHEMA_VERSION - 1}`);

    // Straight to a delivered frame, no snapshot() first: the schema ensure
    // must still run the version reset before the stale cursor is memoized.
    // Without that, offsets 1-2 are filtered out against the stale cursor and
    // the mirror keeps a permanent silent hole below offset 3.
    const secondLoad = rawEventsLoad(db);
    await secondLoad.deliver([rawEvent(1), rawEvent(2), rawEvent(3)]);

    expect(await mirroredOffsets(secondLoad.sql)).toEqual([1, 2, 3]);
  });

  it("leaves the mirror and cursor untouched when the version matches", async () => {
    const db = new DatabaseSync(":memory:");

    const firstLoad = rawEventsLoad(db);
    await firstLoad.deliver([rawEvent(1), rawEvent(2)]);

    const secondLoad = rawEventsLoad(db);
    expect(await secondLoad.runner.snapshot()).toMatchObject({ offset: 2 });

    // Resume strictly after the committed scan cursor.
    await secondLoad.deliver([rawEvent(3)]);
    expect(await mirroredOffsets(secondLoad.sql)).toEqual([1, 2, 3]);
  });

  it("the trigger accepts gaps (evicted ephemeral offsets never replay) but rejects out-of-order inserts", async () => {
    const sql = wrap(new DatabaseSync(":memory:"));
    await ensureBrowserRawEventsSchema(sql);

    const insert = (offset: number) =>
      sql.exec(`INSERT INTO events (local_index, raw_jsonb) VALUES (?, jsonb(?))`, [
        offset - 1,
        JSON.stringify(rawEvent(offset)),
      ]);

    await insert(1);
    // Offset 2 was an ephemeral event later evicted server-side: the offset
    // stays consumed but there is no row to replay, so the mirror must accept
    // the gap.
    await insert(3);
    expect(await mirroredOffsets(sql)).toEqual([1, 3]);
    // Order still holds: a new row below the local head is a delivery bug.
    await expect(insert(2)).rejects.toThrow(/offsets must increase/);
  });

  it("advances across offsets omitted by an explicit scan envelope", async () => {
    // Offset 3 was ephemeral and therefore omitted from durable catch-up. The
    // frame's scan coordinates prove that it was examined, so durable rows
    // after the gap can land without replaying the historical ephemeral row.
    const db = new DatabaseSync(":memory:");
    const load = rawEventsLoad(db);
    await load.deliver([rawEvent(1), rawEvent(2)]);

    await load.deliver([rawEvent(4), rawEvent(5)]);
    expect(await mirroredOffsets(load.sql)).toEqual([1, 2, 4, 5]);
    expect(await load.runner.snapshot()).toMatchObject({ offset: 5 });
    const [progress] = await readProgressRow(load.sql, BrowserRawEventsContract.slug);
    expect(progress).toMatchObject({ acknowledged_through_offset: 5 });
  });
});

describe("transactional projection commit", () => {
  it("a fenced commit rolls back the projection writes AND the progress record together", async () => {
    const db = new DatabaseSync(":memory:");
    const load = rawEventsLoad(db);
    await load.deliver([rawEvent(1), rawEvent(2)]);

    // A cursor rewind lands "elsewhere" (another tab's schema reset): the
    // persisted revision moves past the one this runner loaded with.
    await load.sql.exec(
      `UPDATE processor_progress SET cursor_revision = cursor_revision + 1 WHERE processor_slug = ?`,
      [BrowserRawEventsContract.slug],
    );

    // The stale runner's next frame must not land ANY of its transaction:
    // not the mirror row, not the counts, not the cursor.
    await expect(load.deliver([rawEvent(3)])).rejects.toThrow(/fenced/);
    expect(await mirroredOffsets(load.sql)).toEqual([1, 2]);
    const counts = await load.sql.exec(`SELECT n FROM event_type_counts WHERE type = 'test/raw'`);
    expect(Number(counts[0]?.n)).toBe(2);
    const [progress] = await readProgressRow(load.sql, BrowserRawEventsContract.slug);
    expect(progress).toMatchObject({ acknowledged_through_offset: 2, cursor_revision: 1 });
  });

  it("a mid-transaction projection failure rolls back the cursor with it and stays retryable", async () => {
    const db = new DatabaseSync(":memory:");
    const load = rawEventsLoad(db);
    await load.deliver([rawEvent(1), rawEvent(2)]);

    // A conflicting row at offset 3 (same offset, different JSON) makes the
    // mirror trigger ABORT the insert mid-transaction.
    await load.sql.exec(`INSERT INTO events (local_index, raw_jsonb) VALUES (?, jsonb(?))`, [
      2,
      JSON.stringify({ ...rawEvent(3), payload: { tampered: true } }),
    ]);

    await expect(load.deliver([rawEvent(3), rawEvent(4)])).rejects.toThrow(
      /replay changed an existing offset/,
    );
    // Neither event 4's row nor the cursor advanced — the frame is whole.
    expect(await mirroredOffsets(load.sql)).toEqual([1, 2, 3]);
    const [progress] = await readProgressRow(load.sql, BrowserRawEventsContract.slug);
    expect(progress).toMatchObject({ acknowledged_through_offset: 2, cursor_revision: 0 });

    // Clear the conflict; the SAME runner retries the frame and it lands whole.
    await load.sql.exec(`DELETE FROM events WHERE offset = 3`);
    await load.deliver([rawEvent(3), rawEvent(4)]);
    expect(await mirroredOffsets(load.sql)).toEqual([1, 2, 3, 4]);
    const [retried] = await readProgressRow(load.sql, BrowserRawEventsContract.slug);
    expect(retried).toMatchObject({ acknowledged_through_offset: 4, cursor_revision: 0 });
  });

  it("rejects a same-revision backward acknowledgement; a revision bump admits the rewind", async () => {
    const db = new DatabaseSync(":memory:");
    const load = rawEventsLoad(db);
    const record = (
      ack: number,
      cursorRevision: number,
    ): ProcessorProgress<BrowserRawEventsState> => ({
      reduction: {
        reducerVersion: load.processor.contract.version,
        reducedThroughOffset: ack,
        state: {},
      },
      processing: { acknowledgedThroughOffset: ack, cursorRevision },
    });

    await load.progress.commit(record(5, 0), { expectedCursorRevision: 0 });
    // Stale incarnation rolling the cursor back at the same revision: fenced.
    await expect(load.progress.commit(record(3, 0), { expectedCursorRevision: 0 })).rejects.toThrow(
      /backward/,
    );
    // An operator-style rewind (revision bump, committed under the OLD
    // expected revision) is the one legal backward move.
    await load.progress.commit(record(3, 1), { expectedCursorRevision: 0 });
    // And from here the old revision's continuations are fenced out.
    await expect(load.progress.commit(record(9, 0), { expectedCursorRevision: 0 })).rejects.toThrow(
      /cursorRevision/,
    );
    expect(await load.progress.read()).toMatchObject({
      processing: { acknowledgedThroughOffset: 3, cursorRevision: 1 },
    });
  });
});

describe("output-schema reset (fenced rewind)", () => {
  it("clears the projection and rewinds the cursor in one transaction, fencing stale commits", async () => {
    const db = new DatabaseSync(":memory:");
    const load = rawEventsLoad(db);
    await load.deliver([rawEvent(1), rawEvent(2)]);

    await resetBrowserProcessorProjection({
      sql: load.sql,
      processorSlug: BrowserRawEventsContract.slug,
      projectionResetStatements: [
        { sql: `DELETE FROM events` },
        { sql: `DELETE FROM event_type_counts` },
      ],
    });
    expect(await mirroredOffsets(load.sql)).toEqual([]);
    const [progress] = await readProgressRow(load.sql, BrowserRawEventsContract.slug);
    expect(progress).toMatchObject({
      acknowledged_through_offset: 0,
      cursor_revision: 1,
      reducer_version: "",
    });

    // The pre-reset runner incarnation still holds revision 0 in memory: its
    // next commit is fenced, and its projection write rolls back WITH it —
    // nothing from the stale incarnation lands on the rebuilt mirror.
    await expect(load.deliver([rawEvent(3)])).rejects.toThrow(/fenced/);
    expect(await mirroredOffsets(load.sql)).toEqual([]);

    // A fresh load reads the rewound cursor and rebuilds from offset 1.
    const rebuilt = rawEventsLoad(db);
    expect(await rebuilt.runner.snapshot()).toMatchObject({ offset: 0 });
    await rebuilt.deliver([rawEvent(1), rawEvent(2), rawEvent(3)]);
    expect(await mirroredOffsets(rebuilt.sql)).toEqual([1, 2, 3]);
    const [rebuiltProgress] = await readProgressRow(rebuilt.sql, BrowserRawEventsContract.slug);
    expect(rebuiltProgress).toMatchObject({ acknowledged_through_offset: 3, cursor_revision: 1 });
  });

  it("a failing reset statement applies nothing at all", async () => {
    const db = new DatabaseSync(":memory:");
    const load = rawEventsLoad(db);
    await load.deliver([rawEvent(1), rawEvent(2)]);

    await expect(
      resetBrowserProcessorProjection({
        sql: load.sql,
        processorSlug: BrowserRawEventsContract.slug,
        projectionResetStatements: [
          { sql: `DELETE FROM events` },
          { sql: `DELETE FROM no_such_table` },
        ],
      }),
    ).rejects.toThrow();
    // The DELETE that ran before the failure rolled back with it.
    expect(await mirroredOffsets(load.sql)).toEqual([1, 2]);
    const [progress] = await readProgressRow(load.sql, BrowserRawEventsContract.slug);
    expect(progress).toMatchObject({ acknowledged_through_offset: 2, cursor_revision: 0 });
  });
});

describe("discardBrowserProcessorProjection", () => {
  it("resets the COMPLETE owned-table set atomically even when only a subset pre-existed", async () => {
    const db = new DatabaseSync(":memory:");
    const sql = wrap(db);
    // A database caught between another tab's table creations: the counts
    // table exists (with rows) but `events` does not. Deriving the delete set
    // from per-table sqlite_master probes could race a concurrent writer into
    // exactly this shape — probe `events` before the writer created it,
    // probe `event_type_counts` after — and delete only the counts, leaving
    // `events` rows whose replay dedupes into RAISE(IGNORE) without ever
    // re-firing the count trigger: a permanent undercount.
    db.exec(`PRAGMA user_version = ${BROWSER_RAW_EVENTS_SCHEMA_VERSION}`);
    db.exec(
      `CREATE TABLE event_type_counts (type TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID`,
    );
    db.exec(`INSERT INTO event_type_counts (type, n) VALUES ('test/raw', 7)`);
    await ensureBrowserProcessorProgressSchema(sql);
    await sql.exec(
      `INSERT INTO processor_progress (
         processor_slug, subscription_key, reducer_version, reduced_through_offset,
         reduced_state, acknowledged_through_offset, cursor_revision
       ) VALUES (?, '', 'v', 2, '{}', 2, 0)`,
      [BrowserRawEventsContract.slug],
    );

    await discardBrowserProcessorProjection({
      sql,
      processorSlug: BrowserRawEventsContract.slug,
      tables: BROWSER_RAW_EVENTS_TABLES,
      ensureProjectionSchema: (client) => ensureBrowserRawEventsSchema(client),
    });

    // The delete covered the complete owned set: every owned table now exists
    // and is empty, and the cursor rewound with the revision bump.
    for (const table of BROWSER_RAW_EVENTS_TABLES) {
      expect(await sql.exec(`SELECT * FROM ${table}`)).toEqual([]);
    }
    const [progress] = await readProgressRow(sql, BrowserRawEventsContract.slug);
    expect(progress).toMatchObject({ acknowledged_through_offset: 0, cursor_revision: 1 });

    // The rebuilt mirror's replay from offset 1 recounts from zero — nothing
    // stale survived for the count trigger to sit on.
    const load = rawEventsLoad(db);
    await load.deliver([rawEvent(1), rawEvent(2)]);
    expect(await mirroredOffsets(sql)).toEqual([1, 2]);
    expect(await sql.exec(`SELECT type, n FROM event_type_counts`)).toEqual([
      { type: "test/raw", n: 2 },
    ]);
  });
});

// The event_type_counts table replaces the UI's reactive COUNT(*) full scans
// (they starve ingest on deep mirrors — see the schema comment). Its one
// invariant: it always equals what COUNT(*) GROUP BY type would return.
describe("browser raw events incremental type counts", () => {
  const typedEvent = (offset: number, type: string): StreamEvent => rawEvent(offset, type);

  const countsByType = async (sql: SqlClient) =>
    Object.fromEntries(
      (await sql.exec(`SELECT type, n FROM event_type_counts ORDER BY type`)).map((row) => [
        row.type,
        Number(row.n),
      ]),
    );

  it("tracks per-type counts through delivered frames, matching COUNT(*)", async () => {
    const db = new DatabaseSync(":memory:");
    const load = rawEventsLoad(db);

    await load.deliver([typedEvent(1, "a"), typedEvent(2, "b"), typedEvent(3, "a")]);
    await load.deliver([typedEvent(4, "a")]);

    expect(await countsByType(load.sql)).toEqual({ a: 3, b: 1 });
    const scanned = await load.sql.exec(`SELECT type, COUNT(*) AS n FROM events GROUP BY type`);
    expect(Object.fromEntries(scanned.map((row) => [row.type, Number(row.n)]))).toEqual(
      await countsByType(load.sql),
    );
  });

  it("does not double-count a replayed duplicate (cursor dedupe + RAISE IGNORE)", async () => {
    const db = new DatabaseSync(":memory:");
    const firstLoad = rawEventsLoad(db);
    await firstLoad.deliver([typedEvent(1, "a"), typedEvent(2, "a")]);

    // A fresh page load resumes strictly after the committed scan cursor.
    const secondLoad = rawEventsLoad(db);
    await secondLoad.deliver([typedEvent(3, "a")]);
    expect(await countsByType(wrap(db))).toEqual({ a: 3 });

    // And the trigger's own RAISE(IGNORE) arm still swallows a byte-identical
    // replay that reaches the table directly, without firing the count
    // trigger.
    const [stored] = await secondLoad.sql.exec(
      `SELECT json(raw_jsonb) AS raw_json FROM events WHERE offset = 3`,
    );
    await secondLoad.sql.exec(`INSERT INTO events (local_index, raw_jsonb) VALUES (?, jsonb(?))`, [
      2,
      stored!.raw_json,
    ]);
    expect(await countsByType(wrap(db))).toEqual({ a: 3 });
  });

  it("a schema version reset drops the counts with the mirror", async () => {
    const db = new DatabaseSync(":memory:");
    const firstLoad = rawEventsLoad(db);
    await firstLoad.deliver([typedEvent(1, "a")]);
    expect(await countsByType(wrap(db))).toEqual({ a: 1 });

    db.exec(`PRAGMA user_version = ${BROWSER_RAW_EVENTS_SCHEMA_VERSION - 1}`);
    const secondLoad = rawEventsLoad(db);
    await secondLoad.deliver([typedEvent(1, "b"), typedEvent(2, "b")]);

    // Only the rebuilt mirror's counts survive; nothing carried over from the
    // dropped generation.
    expect(await countsByType(wrap(db))).toEqual({ b: 2 });
  });
});

describe("browser feed processor under runner drive", () => {
  function feedLoad(db: DatabaseSync) {
    const sql = wrap(db);
    const processor = new BrowserFeedProcessor({
      stream: stream(),
      path: "/tests/feed",
      projectId: null,
      sql,
    });
    const progress = browserProcessorProgressStore({
      sql,
      processorSlug: BrowserFeedContract.slug,
      ensureProjectionSchema: (client) => processor.ensureProjectionSchema(client),
      projection: processor.projectionBuffer,
    });
    const runner = new StreamProcessorRunner({
      processor: processor as unknown as StreamProcessor<any, any>,
      stream: stream(),
      durability: { progress },
    });
    return {
      sql,
      runner,
      async deliver(events: StreamEvent[]) {
        const opened = await runner.openDelivery();
        await opened.sink({
          events,
          scannedAfterOffset: opened.checkpointOffset,
          scannedThroughOffset: events.at(-1)?.offset ?? opened.checkpointOffset,
          streamMaxOffset: events.at(-1)!.offset,
        });
      },
    };
  }

  it("projects grouped feed items per event, coalesced to one row state per commit", async () => {
    const db = new DatabaseSync(":memory:");
    const load = feedLoad(db);

    // Frame 1 opens a raw group; frame 2 extends it across the frame boundary
    // and then opens a second group — the extension must UPSERT the existing
    // row (a plain UPDATE against a not-yet-committed row would be lost, a
    // duplicate INSERT would conflict; the coalesced upsert handles both).
    await load.deliver([rawEvent(1, "test/a"), rawEvent(2, "test/a")]);
    await load.deliver([rawEvent(3, "test/a"), rawEvent(4, "test/b")]);

    const rows = await load.sql.exec(
      `SELECT local_index, kind, first_offset, last_offset, event_count
       FROM feed_items ORDER BY local_index`,
    );
    expect(rows).toEqual([
      { local_index: 0, kind: "raw.group", first_offset: 1, last_offset: 3, event_count: 3 },
      { local_index: 1, kind: "raw.group", first_offset: 4, last_offset: 4, event_count: 1 },
    ]);

    // The reduced state (the live agent tail's source) is committed onto the
    // progress row in the same transaction — the stream view reads it
    // reactively via `SELECT reduced_state FROM processor_progress ...`.
    const [committed] = await load.sql.exec(
      `SELECT reduced_state, acknowledged_through_offset FROM processor_progress
       WHERE processor_slug = ?`,
      [BrowserFeedContract.slug],
    );
    expect(committed).toMatchObject({ acknowledged_through_offset: 4 });
    const reduced = JSON.parse(String(committed!.reduced_state)) as {
      agent?: unknown;
      nextLocalIndex?: number;
    };
    expect(reduced.agent).toBeDefined();
    expect(reduced.nextLocalIndex).toBe(2);
  });

  it("a failed feed commit rolls back item rows and cursor together", async () => {
    const db = new DatabaseSync(":memory:");
    const load = feedLoad(db);
    await load.deliver([rawEvent(1, "test/a")]);

    await load.sql.exec(
      `UPDATE processor_progress SET cursor_revision = cursor_revision + 1 WHERE processor_slug = ?`,
      [BrowserFeedContract.slug],
    );

    await expect(load.deliver([rawEvent(2, "test/b")])).rejects.toThrow(/fenced/);
    const rows = await load.sql.exec(`SELECT local_index FROM feed_items ORDER BY local_index`);
    expect(rows).toEqual([{ local_index: 0 }]);
    const [progress] = await readProgressRow(load.sql, BrowserFeedContract.slug);
    expect(progress).toMatchObject({ acknowledged_through_offset: 1, cursor_revision: 1 });
  });
});
