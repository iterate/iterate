import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { StreamEvent } from "iterate/processors";
import {
  reconcileSubscriptionCursorRows,
  SqliteSubscriptionCursorStore,
  StreamEventLog,
} from "./stream-storage.ts";

function wrapSqlStorage(db: DatabaseSync): SqlStorage {
  return {
    exec<T = unknown>(sql: string, ...bindings: (ArrayBuffer | null | number | string)[]) {
      const rows = db
        .prepare(sql)
        .all(
          ...bindings.map((binding) =>
            binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
          ),
        )
        .map((row) => Object.fromEntries(Object.entries(row).map(fromNodeSqlValue)));
      return { toArray: () => rows as T[] };
    },
  } as SqlStorage;
}

function event(offset: number, type: string): StreamEvent {
  return {
    type,
    payload: { offset },
    createdAt: new Date(offset).toISOString(),
    offset,
    path: "/tests/stream",
  };
}

function createLog() {
  const log = new StreamEventLog(wrapSqlStorage(new DatabaseSync(":memory:")), "/tests/stream");
  log.insert([
    event(1, "events.iterate.com/test/selected"),
    event(2, "events.iterate.com/test/other"),
    event(3, "events.iterate.com/test/selected"),
    event(4, "events.iterate.com/test/other"),
    event(5, "events.iterate.com/test/selected"),
  ]);
  return log;
}

function read(
  log: StreamEventLog,
  args: Omit<Parameters<StreamEventLog["getRange"]>[0], "beforeOffset">,
) {
  return log.getRange({ beforeOffset: Number.MAX_SAFE_INTEGER, ...args });
}

function offsets(events: readonly StreamEvent[]) {
  return events.map((readEvent) => readEvent.offset);
}

describe("StreamEventLog.getRange", () => {
  it("pages by offset and limit", () => {
    const log = createLog();

    const firstPage = read(log, {
      afterOffset: 0,
      limit: 2,
    });
    expect(offsets(firstPage)).toEqual([1, 2]);

    const secondPage = read(log, {
      afterOffset: firstPage.at(-1)!.offset,
      limit: 2,
    });
    expect(offsets(secondPage)).toEqual([3, 4]);
  });

  it("filters by event type before applying the limit", () => {
    const log = createLog();

    const selectedEvents = read(log, {
      afterOffset: 0,
      eventTypes: ["events.iterate.com/test/selected"],
      limit: 2,
    });

    expect(offsets(selectedEvents)).toEqual([1, 3]);
    expect(
      selectedEvents.every((readEvent) => readEvent.type === "events.iterate.com/test/selected"),
    ).toBe(true);
  });

  it("handles wildcard and empty event type filters", () => {
    const log = createLog();

    expect(offsets(read(log, { afterOffset: 0, eventTypes: ["*"], limit: 3 }))).toEqual([1, 2, 3]);
    expect(read(log, { afterOffset: 0, eventTypes: [], limit: 3 })).toEqual([]);
  });

  it("insert and range metadata report the stored serialized byte lengths", () => {
    const log = new StreamEventLog(wrapSqlStorage(new DatabaseSync(":memory:")), "/tests/stream");
    const committedEvents = [
      event(1, "events.iterate.com/test/sized"),
      event(2, "events.iterate.com/test/sized"),
    ];

    const insertedByteLengths = log.insert(committedEvents);
    expect(insertedByteLengths).toEqual(
      committedEvents.map((entry) => new TextEncoder().encode(JSON.stringify(entry)).byteLength),
    );

    // The sized read sums the chunk rows already in hand — no re-stringify —
    // and must agree exactly with what insert serialized.
    const sized = log.getRangeSized({
      afterOffset: 0,
      beforeOffset: Number.MAX_SAFE_INTEGER,
      limit: 10,
    });
    expect(sized.map((entry) => entry.byteLength)).toEqual(insertedByteLengths);
    expect(sized.map((entry) => entry.event)).toEqual(committedEvents);
  });

  it("excludes ephemeral rows from range reads unless asked; point reads always return them", () => {
    const log = new StreamEventLog(wrapSqlStorage(new DatabaseSync(":memory:")), "/tests/stream");
    const chunk: StreamEvent = {
      ...event(2, "events.iterate.com/test/chunk"),
      ephemeral: true,
      idempotencyKey: "chunk-2",
    };
    log.insert([event(1, "events.iterate.com/test/durable")]);
    log.insert([chunk]);
    log.insert([event(3, "events.iterate.com/test/durable")]);

    expect(log.highestOffset()).toBe(3);
    expect(offsets(read(log, { afterOffset: 0, limit: 10 }))).toEqual([1, 3]);
    expect(offsets(read(log, { afterOffset: 0, limit: 10, includeEphemeral: true }))).toEqual([
      1, 2, 3,
    ]);
    // Both interpolated WHERE clauses at once (ephemeral + type filter).
    expect(
      offsets(
        read(log, {
          afterOffset: 0,
          limit: 10,
          eventTypes: ["events.iterate.com/test/chunk"],
          includeEphemeral: true,
        }),
      ),
    ).toEqual([2]);
    expect(
      offsets(
        read(log, { afterOffset: 0, limit: 10, eventTypes: ["events.iterate.com/test/chunk"] }),
      ),
    ).toEqual([]);
    // Point reads are an explicit request — no flag needed.
    expect(log.getByOffset(2)).toEqual(chunk);
    expect(log.getByIdempotencyKey("chunk-2")).toEqual(chunk);
  });

  it("adopts a pre-ephemeral events table in place (the live-stream deploy path)", () => {
    const db = new DatabaseSync(":memory:");
    // The exact table shape every live stream's constructor DDL created
    // before the ephemeral column existed, with a row already in it.
    db.exec(`
      create table events (
        offset integer primary key autoincrement,
        type text not null,
        created_at text not null,
        idempotency_key text unique
      );
      create table event_chunks (
        offset integer not null,
        chunk_index integer not null,
        chunk_bytes blob not null,
        primary key (offset, chunk_index),
        foreign key (offset) references events(offset) on delete cascade
      ) without rowid;
    `);
    db.prepare("insert into events (offset, type, created_at) values (1, 'legacy', '1970')").run();

    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    log.insert([{ ...event(2, "events.iterate.com/test/chunk"), ephemeral: true }]);
    log.insert([event(3, "events.iterate.com/test/durable")]);
    // Legacy row reads as durable (default 0 backfill); the filter works.
    expect(
      log.getRange({ afterOffset: 1, beforeOffset: 100, limit: 10 }).map((entry) => entry.offset),
    ).toEqual([3]);
  });

  it("highestAssignedOffset survives deletion of the highest row (the eviction allocator floor)", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    log.insert([event(1, "events.iterate.com/test/durable")]);
    log.insert([{ ...event(2, "events.iterate.com/test/chunk"), ephemeral: true }]);
    db.prepare("delete from events where offset = 2").run();
    expect(log.highestOffset()).toBe(1);
    expect(log.highestAssignedOffset()).toBe(2);
  });

  it("adds the stream path when reading legacy stored events", () => {
    const sql = wrapSqlStorage(new DatabaseSync(":memory:"));
    const log = new StreamEventLog(sql, "/legacy/stream");

    const legacyEvent = {
      type: "events.iterate.com/test/legacy",
      createdAt: new Date(1).toISOString(),
      offset: 1,
    };
    sql.exec(
      "insert into events (offset, type, created_at, idempotency_key) values (?, ?, ?, ?)",
      legacyEvent.offset,
      legacyEvent.type,
      legacyEvent.createdAt,
      null,
    );
    sql.exec(
      "insert into event_chunks (offset, chunk_index, chunk_bytes) values (?, ?, ?)",
      legacyEvent.offset,
      0,
      new TextEncoder().encode(JSON.stringify(legacyEvent)).buffer,
    );

    expect(log.getByOffset(1)).toEqual({ ...legacyEvent, path: "/legacy/stream" });
  });
});

function fromNodeSqlValue([key, value]: [string, unknown]) {
  if (value instanceof Uint8Array) {
    return [key, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)];
  }
  return [key, value];
}

describe("reconcileSubscriptionCursorRows", () => {
  it("drops orphaned rows, keeps progress, clears failure state (version-mismatch rebuild)", () => {
    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(new DatabaseSync(":memory:")));
    store.ensure("survivor-clean", 5);
    store.ensure("survivor-backing-off", 3);
    store.nack("survivor-backing-off", {
      attempt: 7,
      nextAttemptAt: 99_999,
      error: "old-code bug",
    });
    store.ensure("orphan", 2);
    store.nack("orphan", { attempt: 14, nextAttemptAt: 88_888, error: "config no longer folds" });

    reconcileSubscriptionCursorRows(store, new Set(["survivor-clean", "survivor-backing-off"]));

    // The orphan is gone entirely — its next_attempt_at must not arm alarms forever.
    expect(store.get("orphan")).toBeUndefined();
    expect(store.minNextAttemptAt()).toBeNull();
    // Progress survives (ackedOffset is monotonic truth about the same log)...
    expect(store.get("survivor-clean")?.ackedOffset).toBe(5);
    expect(store.get("survivor-backing-off")?.ackedOffset).toBe(3);
    // ...but backoff state is cleared: the new fold gets an immediate fresh try.
    expect(store.get("survivor-backing-off")).toMatchObject({
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
    });
  });
});

describe("SqliteSubscriptionCursorStore schema migration", () => {
  it("adds the epoch column to a pre-epoch subscriptions table without losing rows", () => {
    // A live DO that created the table under #1784 (no epoch column) and then
    // received #1792 code: construction must upgrade the table in place
    // instead of leaving every subsequent select throwing "no such column".
    const db = new DatabaseSync(":memory:");
    db.exec(`
      create table subscriptions (
        subscription_key text primary key,
        acked_offset integer not null,
        attempt integer not null default 0,
        next_attempt_at integer,
        last_error text,
        updated_at text not null
      )
    `);
    db.prepare(
      "insert into subscriptions (subscription_key, acked_offset, updated_at) values (?, ?, ?)",
    ).run("pre-existing", 7, new Date(0).toISOString());

    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));

    // The old row reads back with the fence value fresh #1784 rows had.
    expect(store.get("pre-existing")).toMatchObject({ ackedOffset: 7, epoch: 0 });
    expect(store.list()).toHaveLength(1);
    // Post-migration writes behave like any other row.
    store.ensure("fresh", 0);
    expect(store.get("fresh")!.epoch).toBeGreaterThan(0);
  });

  it("adopts a with-epoch table that predates sqlfu ownership (post-#1792 constructor DDL)", () => {
    // DOs created between #1792 and this fix got the epoch column from raw
    // constructor DDL, so they have the current shape but an empty
    // sqlfu_migrations table. The migration chain must pass over them without
    // throwing (a bare `alter table add column epoch` would die with
    // "duplicate column name") and without losing rows. Epochs reset to 0 —
    // acceptable because no in-flight delivery survives the DO restart that
    // reruns the constructor.
    const db = new DatabaseSync(":memory:");
    db.exec(`
      create table subscriptions (
        subscription_key text primary key,
        acked_offset integer not null,
        attempt integer not null default 0,
        next_attempt_at integer,
        last_error text,
        epoch integer not null default 0,
        updated_at text not null
      )
    `);
    db.prepare(
      "insert into subscriptions (subscription_key, acked_offset, epoch, updated_at) values (?, ?, ?, ?)",
    ).run("pre-existing", 7, Date.now(), new Date(0).toISOString());

    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));

    expect(store.get("pre-existing")).toMatchObject({ ackedOffset: 7, epoch: 0 });
    expect(store.list()).toHaveLength(1);
    store.ensure("fresh", 0);
    expect(store.get("fresh")!.epoch).toBeGreaterThan(0);
  });

  it("is idempotent on an already-current table", () => {
    const db = new DatabaseSync(":memory:");
    const first = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    first.ensure("k", 3);
    const again = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    expect(again.get("k")).toMatchObject({ ackedOffset: 3 });
    // Second construction re-ran migrate() against recorded history: the
    // epoch minted by the first store must survive (no re-rebuild).
    expect(again.get("k")!.epoch).toBeGreaterThan(0);
  });
});

describe("SqliteSubscriptionCursorStore epoch fencing", () => {
  function makeStore() {
    return new SqliteSubscriptionCursorStore(wrapSqlStorage(new DatabaseSync(":memory:")));
  }

  it("migrates existing subscription tables that predate epoch fencing", () => {
    const sql = wrapSqlStorage(new DatabaseSync(":memory:"));
    sql.exec(`
      create table subscriptions (
        subscription_key text primary key,
        acked_offset integer not null,
        attempt integer not null default 0,
        next_attempt_at integer,
        last_error text,
        updated_at text not null
      )
    `);
    sql.exec(
      "insert into subscriptions (subscription_key, acked_offset, attempt, next_attempt_at, last_error, updated_at) values (?, ?, ?, ?, ?, ?)",
      "legacy",
      4,
      2,
      123,
      "old failure",
      new Date(0).toISOString(),
    );

    const store = new SqliteSubscriptionCursorStore(sql);

    expect(store.get("legacy")).toMatchObject({
      ackedOffset: 4,
      attempt: 2,
      epoch: 0,
      lastError: "old failure",
      nextAttemptAt: 123,
    });

    store.setCursor("legacy", 7);

    expect(store.get("legacy")).toMatchObject({
      ackedOffset: 7,
      attempt: 0,
      lastError: null,
      nextAttemptAt: null,
    });
    expect(store.get("legacy")!.epoch).toBeGreaterThan(0);
  });

  it("acks fenced on a stale epoch no-op; unfenced acks still land", () => {
    const store = makeStore();
    store.ensure("k", 0);
    const before = store.get("k")!;

    store.setCursor("k", 2); // the seek bumps the epoch
    const after = store.get("k")!;
    expect(after.epoch).toBeGreaterThan(before.epoch);

    // The in-flight delivery captured the PRE-seek epoch: its ack must not
    // clobber the seek.
    store.ack("k", 100, before.epoch);
    expect(store.get("k")!.ackedOffset).toBe(2);

    // A delivery that read the post-seek row acks normally.
    store.ack("k", 5, after.epoch);
    expect(store.get("k")!.ackedOffset).toBe(5);
  });

  it("remove+recreate mints a fresh epoch, so a dead subscription's ack cannot land", () => {
    const store = makeStore();
    store.ensure("k", 0);
    const oldEpoch = store.get("k")!.epoch;
    store.delete("k");
    store.ensure("k", 0); // recreate with deliver:"all" semantics
    expect(store.get("k")!.epoch).toBeGreaterThan(oldEpoch);

    store.ack("k", 100, oldEpoch); // the removed receiver's in-flight ack
    expect(store.get("k")!.ackedOffset).toBe(0); // full history still owed
  });

  it("advanceWatermark keeps the failure streak but clears the retry schedule", () => {
    const store = makeStore();
    store.ensure("k", 0);
    store.nack("k", { attempt: 3, nextAttemptAt: 12345, error: "ingest failing" });

    store.advanceWatermark("k", 7);
    const row = store.get("k")!;
    expect(row.ackedOffset).toBe(7);
    expect(row.attempt).toBe(3); // a reachable host is not a healthy one
    expect(row.lastError).toBe("ingest failing");
    expect(row.nextAttemptAt).toBeNull(); // the poke consumed the retry
  });

  it("fences watchdog, nack, and wake watermark writes against a replaced row", () => {
    const store = makeStore();
    store.ensure("k", 0);
    const oldEpoch = store.get("k")!.epoch;
    store.delete("k");
    store.ensure("k", 0);
    const replacement = store.get("k")!;

    store.armWatchdog("k", 100, oldEpoch);
    store.nack("k", { attempt: 7, nextAttemptAt: 200, error: "old failure" }, oldEpoch);
    store.advanceWatermark("k", 99, oldEpoch);

    expect(store.get("k")).toEqual(replacement);
  });
});
