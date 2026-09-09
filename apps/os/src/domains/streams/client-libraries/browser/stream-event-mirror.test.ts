import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { StreamEventBatch } from "iterate/processors";
import type { SqlClient, SqlValue } from "./stream-browser-db.ts";
import { openStreamEventMirror } from "./stream-event-mirror.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function database() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql: SqlClient = {
    exec: async (statement, params = []) =>
      db.prepare(statement).all(...(params as Exclude<SqlValue, number[]>[])),
    batch: async (statements, options) => {
      if (options?.transaction) db.exec("BEGIN");
      try {
        for (const statement of statements) {
          db.prepare(statement.sql).run(
            ...((statement.params ?? []) as Exclude<SqlValue, number[]>[]),
          );
        }
        if (options?.transaction) db.exec("COMMIT");
      } catch (error) {
        if (options?.transaction) db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, sql };
}

function batch(offsets: number[], after = 0, through = offsets.at(-1) ?? after): StreamEventBatch {
  return {
    projectId: null,
    path: "/test",
    state: null,
    streamId: "stream-a",
    scannedAfterOffset: after,
    scannedThroughOffset: through,
    streamMaxOffset: through,
    events: offsets.map((offset) => ({
      offset,
      path: "/test",
      type: "test/event",
      createdAt: "2026-09-09T00:00:00.000Z",
      payload: { offset },
    })),
  };
}

describe("stream event mirror", () => {
  it("copies a batch including ephemeral events with dense local positions and exact counts", async () => {
    const { sql } = database();
    const mirror = await openStreamEventMirror(sql, { streamId: "stream-a", streamMaxOffset: 9 });
    const delivery = batch([1, 4, 9]);
    delivery.events[1]!.ephemeral = true;
    await mirror.ingest(delivery);
    expect(
      await sql.exec(
        `SELECT local_index, offset, json_extract(raw_jsonb, '$.ephemeral') AS ephemeral FROM events`,
      ),
    ).toEqual([
      { local_index: 0, offset: 1, ephemeral: null },
      { local_index: 1, offset: 4, ephemeral: 1 },
      { local_index: 2, offset: 9, ephemeral: null },
    ]);
    expect(await sql.exec(`SELECT * FROM event_type_counts`)).toEqual([
      { type: "test/event", n: 3 },
    ]);
    expect(mirror.throughOffset).toBe(9);
  });

  it("deduplicates overlapping replay without gaps in local positions or double-counting", async () => {
    const { sql } = database();
    const mirror = await openStreamEventMirror(sql, { streamId: "stream-a", streamMaxOffset: 9 });
    await mirror.ingest(batch([1, 4]));
    await mirror.ingest(batch([1, 4, 9]));
    expect(await sql.exec(`SELECT local_index, offset FROM events`)).toEqual([
      { local_index: 0, offset: 1 },
      { local_index: 1, offset: 4 },
      { local_index: 2, offset: 9 },
    ]);
    expect(await sql.exec(`SELECT SUM(n) AS n FROM event_type_counts`)).toEqual([{ n: 3 }]);
  });

  it("advances across an empty scan and resumes after reopening", async () => {
    const { sql } = database();
    const mirror = await openStreamEventMirror(sql, { streamId: "stream-a", streamMaxOffset: 12 });
    await mirror.ingest(batch([1, 4]));
    await mirror.ingest(batch([], 4, 12));
    const reopened = await openStreamEventMirror(sql, {
      streamId: "stream-a",
      streamMaxOffset: 12,
    });
    expect(reopened.throughOffset).toBe(12);
    expect(await sql.exec(`SELECT COUNT(*) AS n FROM events`)).toEqual([{ n: 2 }]);
  });

  it("rolls back all new events, counts and cursor on a conflicting replay", async () => {
    const { sql } = database();
    const mirror = await openStreamEventMirror(sql, { streamId: "stream-a", streamMaxOffset: 9 });
    await mirror.ingest(batch([1]));
    const changed = batch([1, 9]);
    changed.events[0]!.payload = { changed: true };
    await expect(mirror.ingest(changed)).rejects.toThrow("changed an existing offset");
    expect(mirror.throughOffset).toBe(1);
    expect(await sql.exec(`SELECT through_offset FROM stream_sync`)).toEqual([
      { through_offset: 1 },
    ]);
    expect(await sql.exec(`SELECT SUM(n) AS n FROM event_type_counts`)).toEqual([{ n: 1 }]);
  });

  it("rolls back inserted events when the cursor write fails", async () => {
    const { sql, db } = database();
    const mirror = await openStreamEventMirror(sql, { streamId: "stream-a", streamMaxOffset: 9 });
    db.exec(
      `CREATE TRIGGER fail_cursor BEFORE UPDATE ON stream_sync BEGIN SELECT RAISE(ABORT, 'disk failure'); END`,
    );
    await expect(mirror.ingest(batch([1, 9]))).rejects.toThrow("disk failure");
    expect(await sql.exec(`SELECT COUNT(*) AS n FROM events`)).toEqual([{ n: 0 }]);
    expect(await sql.exec(`SELECT COUNT(*) AS n FROM event_type_counts`)).toEqual([{ n: 0 }]);
    expect(mirror.throughOffset).toBe(0);
  });

  it("clears recreated streams atomically and fences callbacks from the previous owner", async () => {
    const { sql } = database();
    const old = await openStreamEventMirror(sql, { streamId: "stream-a", streamMaxOffset: 9 });
    await old.ingest(batch([1, 9]));
    const replacement = await openStreamEventMirror(sql, {
      streamId: "stream-b",
      streamMaxOffset: 1,
    });
    expect(replacement.throughOffset).toBe(0);
    await expect(old.ingest(batch([12], 9))).rejects.toThrow("fenced");
    await replacement.ingest({ ...batch([1]), streamId: "stream-b" });
    expect(await sql.exec(`SELECT local_index, offset FROM events`)).toEqual([
      { local_index: 0, offset: 1 },
    ]);
    expect(await sql.exec(`SELECT SUM(n) AS n FROM event_type_counts`)).toEqual([{ n: 1 }]);
  });

  it("fences a replaced connection even when the stream lifetime is unchanged", async () => {
    const { sql } = database();
    const old = await openStreamEventMirror(sql, { streamId: "stream-a", streamMaxOffset: 9 });
    await openStreamEventMirror(sql, { streamId: "stream-a", streamMaxOffset: 9 });
    await expect(old.ingest(batch([1]))).rejects.toThrow("fenced");
  });

  it("rejects unproven scan gaps, out-of-order events and a foreign stream", async () => {
    const { sql } = database();
    const mirror = await openStreamEventMirror(sql, { streamId: "stream-a", streamMaxOffset: 9 });
    await expect(mirror.ingest(batch([9], 4))).rejects.toThrow("boundary");
    await expect(mirror.ingest(batch([4, 1], 0, 9))).rejects.toThrow("ordered scan");
    await expect(mirror.ingest({ ...batch([1]), streamId: "stream-b" })).rejects.toThrow(
      "boundary",
    );
  });
});

describe("feed queries over immutable events", () => {
  it("selects the latest revision at the original position and keeps every publication visible in Raw", async () => {
    const { sql } = database();
    const mirror = await openStreamEventMirror(sql, { streamId: "stream-a", streamMaxOffset: 6 });
    const delivery = batch([1, 2, 3, 4, 5, 6]);
    for (const [position, id, firstOffset, revisionOffset, text] of [
      [1, "user-1", 1, 1, "original"],
      [3, "user-3", 3, 3, "second"],
      [5, "user-1", 1, 5, "corrected"],
    ] as const) {
      delivery.events[position] = {
        ...delivery.events[position]!,
        type: "events.iterate.com/feed/item-published",
        payload: {
          item: { kind: "user", id, text, timestampMs: 0 },
          firstOffset,
          ordinal: 0,
          revisionOffset,
        },
      };
    }
    await mirror.ingest(delivery);
    expect(
      await sql.exec(
        `SELECT local_index, json_extract(data, '$.text') AS text FROM feed_items WHERE kind = 'agent.user' ORDER BY local_index, ordinal`,
      ),
    ).toEqual([
      { local_index: 2, text: "corrected" },
      { local_index: 4, text: "second" },
    ]);
    expect(await sql.exec(`SELECT COUNT(*) AS n FROM feed_items WHERE kind LIKE 'raw.%'`)).toEqual([
      { n: 6 },
    ]);
    expect(
      await sql.exec(
        `SELECT json_extract(raw_jsonb, '$.payload.item.text') AS text FROM events WHERE offset = 2`,
      ),
    ).toEqual([{ text: "original" }]);
  });

  it("appends delayed publications after visible history and keeps revisions in place", async () => {
    const { sql } = database();
    const mirror = await openStreamEventMirror(sql, { streamId: "stream-a", streamMaxOffset: 6 });
    await mirror.ingest(batch([1, 2, 3]));
    const publish = (offset: number, text: string) => ({
      ...batch([offset]).events[0]!,
      type: "events.iterate.com/feed/item-published",
      payload: {
        item: { kind: "user", id: "user-1", text, timestampMs: 0 },
        firstOffset: 1,
        ordinal: 0,
        revisionOffset: 1,
      },
    });
    await mirror.ingest({ ...batch([4], 3), events: [publish(4, "original")] });
    const positions = () =>
      sql.exec(`SELECT local_index, kind FROM feed_items ORDER BY local_index, ordinal`);
    const before = await positions();
    expect(before.slice(0, 4)).toEqual([
      { local_index: 1, kind: "raw.group" },
      { local_index: 2, kind: "raw.group" },
      { local_index: 3, kind: "raw.group" },
      { local_index: 4, kind: "agent.user" },
    ]);
    await mirror.ingest({ ...batch([5], 4), events: [publish(5, "corrected")] });
    expect((await positions()).slice(0, before.length)).toEqual(before);
    expect(
      await sql.exec(
        `SELECT json_extract(data, '$.text') AS text FROM feed_items WHERE kind = 'agent.user'`,
      ),
    ).toEqual([{ text: "corrected" }]);
  });

  it("reports a reset only when opening a new lifetime or invalid cursor", async () => {
    const { sql } = database();
    const first = await openStreamEventMirror(sql, { streamId: "stream-a", streamMaxOffset: 3 });
    expect(first.reset).toBe(true);
    await first.ingest(batch([1, 3]));
    expect(
      (await openStreamEventMirror(sql, { streamId: "stream-a", streamMaxOffset: 3 })).reset,
    ).toBe(false);
    expect(
      (await openStreamEventMirror(sql, { streamId: "stream-b", streamMaxOffset: 3 })).reset,
    ).toBe(true);
  });
});
