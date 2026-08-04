import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { StreamEvent } from "iterate/processors";
import { SqliteSubscriptionCursorStore, StreamEventLog } from "./stream-storage.ts";

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

  it("fails loudly when an indexed event has no stored body", () => {
    const log = createLog();
    log.sql.exec("delete from event_chunks where offset = ?", 2);

    expect(() => read(log, { afterOffset: 0, limit: 5 })).toThrow(
      'stream event at path "/tests/stream", offset 2 has no body',
    );
  });

  it("rejects ephemeral events at the durable storage boundary", () => {
    const log = new StreamEventLog(wrapSqlStorage(new DatabaseSync(":memory:")), "/tests/stream");
    const chunk: StreamEvent = {
      ...event(2, "events.iterate.com/test/chunk"),
      ephemeral: true,
    };
    log.insert([event(1, "events.iterate.com/test/durable")]);
    expect(() => log.insert([chunk])).toThrow(
      "ephemeral events must not be written to the durable event log",
    );
    expect(log.highestOffset()).toBe(1);
    expect(log.getByOffset(2)).toBeUndefined();
  });

  it("persists a highest-assigned offset with no event row", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    log.insert([event(1, "events.iterate.com/test/durable")]);
    expect(log.highestAssignedOffset()).toBe(1);
    log.advanceHighestAssignedOffset(2);

    const reopened = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    expect(log.highestOffset()).toBe(1);
    expect(reopened.highestAssignedOffset()).toBe(2);
    expect(reopened.getByOffset(2)).toBeUndefined();
  });

  it("removes legacy ephemeral rows while preserving their assigned offsets", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      create table events (
        offset integer primary key autoincrement,
        type text not null,
        created_at text not null,
        idempotency_key text unique,
        ephemeral integer not null default 0
      );
      create table event_chunks (
        offset integer not null,
        chunk_index integer not null,
        chunk_bytes blob not null,
        primary key (offset, chunk_index),
        foreign key (offset) references events(offset) on delete cascade
      ) without rowid;
    `);
    const durable = event(1, "events.iterate.com/test/durable");
    const ephemeral = { ...event(2, "events.iterate.com/test/ephemeral"), ephemeral: true };
    for (const legacyEvent of [durable, ephemeral]) {
      db.prepare(
        `insert into events (offset, type, created_at, idempotency_key, ephemeral)
         values (?, ?, ?, null, ?)`,
      ).run(
        legacyEvent.offset,
        legacyEvent.type,
        legacyEvent.createdAt,
        legacyEvent.ephemeral === true ? 1 : 0,
      );
      db.prepare(
        "insert into event_chunks (offset, chunk_index, chunk_bytes) values (?, 0, ?)",
      ).run(legacyEvent.offset, new TextEncoder().encode(JSON.stringify(legacyEvent)));
    }

    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");

    expect(log.getByOffset(1)).toEqual(durable);
    expect(log.getByOffset(2)).toBeUndefined();
    expect(log.highestOffset()).toBe(1);
    expect(log.highestAssignedOffset()).toBe(2);
    expect(db.prepare("select count(*) as count from event_chunks where offset = 2").get()).toEqual(
      {
        count: 0,
      },
    );
    expect(
      db
        .prepare("pragma table_info('events')")
        .all()
        .map((column) => column.name),
    ).not.toContain("ephemeral");
  });
});

describe("SqliteSubscriptionCursorStore hosted delivery watchdog", () => {
  it("persists one in-flight deadline and rejects an older connection clearing it", () => {
    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(new DatabaseSync(":memory:")));
    store.ensure("processor", 4, 12);
    const cursorChangedAtOffset = store.get("processor")!.cursorChangedAtOffset;
    store.nack("processor", {
      attempt: 14,
      nextAttemptAt: 19_000,
      error: "previous hosted batch failed",
      failingEvent: { offset: 5, attempt: 3 },
    });

    store.markInFlight("processor", {
      deadlineAt: 20_000,
      connectionGeneration: 7,
      cursorChangedAtOffset,
    });
    expect(store.get("processor")).toMatchObject({
      attempt: 14,
      nextAttemptAt: 19_000,
      lastError: "previous hosted batch failed",
      inFlightDeadlineAt: 20_000,
      inFlightConnectionGeneration: 7,
    });

    store.clearInFlight("processor", { connectionGeneration: 6, cursorChangedAtOffset });
    expect(store.get("processor")).toMatchObject({
      attempt: 14,
      nextAttemptAt: 19_000,
      lastError: "previous hosted batch failed",
      inFlightDeadlineAt: 20_000,
      inFlightConnectionGeneration: 7,
    });

    store.clearInFlight("processor", { connectionGeneration: 7, cursorChangedAtOffset });
    expect(store.get("processor")).toMatchObject({
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
      failingEventOffset: null,
      failingEventAttempt: 0,
      failingEventSkipsSinceLastSuccess: 0,
      inFlightDeadlineAt: null,
      inFlightConnectionGeneration: null,
    });
  });

  it("keeps the failure streak when a successful wake reports no checkpoint progress", () => {
    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(new DatabaseSync(":memory:")));
    store.ensure("processor", 4, 12);
    const cursorChangedAtOffset = store.get("processor")!.cursorChangedAtOffset;
    store.nack("processor", {
      attempt: 14,
      nextAttemptAt: 19_000,
      error: "hosted batch failed",
      failingEvent: { offset: 5, attempt: 3 },
    });
    store.markInFlight("processor", {
      deadlineAt: 20_000,
      connectionGeneration: 7,
      cursorChangedAtOffset,
    });

    store.recordReportedCheckpoint("processor", 4);

    expect(store.get("processor")).toMatchObject({
      acknowledgedOffset: 4,
      attempt: 14,
      nextAttemptAt: null,
      lastError: "hosted batch failed",
      failingEventOffset: 5,
      failingEventAttempt: 3,
      inFlightDeadlineAt: null,
      inFlightConnectionGeneration: null,
    });
  });

  it("keeps a replacement or seek from inheriting an old delivery watchdog", () => {
    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(new DatabaseSync(":memory:")));
    store.ensure("processor", 4, 12);
    const firstCursorChangedAtOffset = store.get("processor")!.cursorChangedAtOffset;
    store.markInFlight("processor", {
      deadlineAt: 20_000,
      connectionGeneration: 7,
      cursorChangedAtOffset: firstCursorChangedAtOffset,
    });

    store.setCursor("processor", 2, 20);
    const afterSeek = store.get("processor")!;
    expect(afterSeek.cursorChangedAtOffset).toBe(20);
    expect(afterSeek).toMatchObject({
      acknowledgedOffset: 2,
      inFlightDeadlineAt: null,
      inFlightConnectionGeneration: null,
    });

    store.markInFlight("processor", {
      deadlineAt: 30_000,
      connectionGeneration: 8,
      cursorChangedAtOffset: afterSeek.cursorChangedAtOffset,
    });
    store.ensure("processor", 9, 13);
    expect(store.get("processor")).toMatchObject({
      acknowledgedOffset: 9,
      configuredAtOffset: 13,
      inFlightDeadlineAt: null,
      inFlightConnectionGeneration: null,
    });
  });

  it("rejects a stale acknowledgement whose cursor-changing event moved, leaving the row untouched", () => {
    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(new DatabaseSync(":memory:")));
    store.ensure("processor", 4, 12);
    store.nack("processor", { attempt: 3, nextAttemptAt: 19_000, error: "receiver failed" });
    const before = store.get("processor")!;

    // The SQL-level dual of the sender's in-memory delivery-still-matches
    // guard: an acknowledgement naming a superseded configuration/cursor-set
    // event must not advance the cursor or clear failure state.
    store.ack("processor", 9, { cursorChangedAtOffset: 11 });
    expect(store.get("processor")).toEqual(before);

    // The same acknowledgement naming the live cursor generation lands.
    store.ack("processor", 9, { cursorChangedAtOffset: 12 });
    expect(store.get("processor")).toMatchObject({
      acknowledgedOffset: 9,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
    });
  });

  it("turns a failed dispatch into ordinary retry state and clears its watchdog", () => {
    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(new DatabaseSync(":memory:")));
    store.ensure("processor", 4, 12);
    const cursorChangedAtOffset = store.get("processor")!.cursorChangedAtOffset;
    store.markInFlight("processor", {
      deadlineAt: 20_000,
      connectionGeneration: 7,
      cursorChangedAtOffset,
    });

    store.nack("processor", {
      attempt: 1,
      nextAttemptAt: 25_000,
      error: "batch did not acknowledge",
    });

    expect(store.get("processor")).toMatchObject({
      attempt: 1,
      nextAttemptAt: 25_000,
      lastError: "batch did not acknowledge",
      inFlightDeadlineAt: null,
      inFlightConnectionGeneration: null,
    });
  });
});

function fromNodeSqlValue([key, value]: [string, unknown]) {
  if (value instanceof Uint8Array) {
    return [key, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)];
  }
  return [key, value];
}
