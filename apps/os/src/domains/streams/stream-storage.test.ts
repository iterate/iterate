import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { StreamEvent } from "iterate/processors";
import { SqliteSubscriptionCursorStore, StreamEventLog } from "./stream-storage.ts";
import { CrossPostListRetryStore } from "./cross-post-list-retry-store.ts";

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

describe("StreamEventLog schema", () => {
  it("rejects old stream storage with an explicit recreation instruction", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      create table events (
        offset integer primary key autoincrement,
        type text not null,
        created_at text not null,
        idempotency_key text unique,
        ephemeral integer not null default 0
      )
    `);

    try {
      expect(() => new StreamEventLog(wrapSqlStorage(db), "/legacy-stream")).toThrow(
        'stream storage at "/legacy-stream" predates the cross-post subscription schema' +
          " (missing events columns: cross_post_list_source_path, " +
          "cross_post_list_source_created_at_ms, cross_post_list_source_stream_id, " +
          "cross_post_list_source_offset, cross_post_list_confirmed_receiving_stream_path, " +
          "cross_post_list_confirmed_source_offset); erase and recreate this stream before " +
          "deploying this version",
      );
    } finally {
      db.close();
    }
  });
});

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

  it("highestAssignedOffset survives deletion of the highest row (the eviction allocator floor)", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    log.insert([event(1, "events.iterate.com/test/durable")]);
    log.insert([{ ...event(2, "events.iterate.com/test/chunk"), ephemeral: true }]);
    db.prepare("delete from events where offset = 2").run();
    expect(log.highestOffset()).toBe(1);
    expect(log.highestAssignedOffset()).toBe(2);
  });

  it("indexes the latest cross-post list by creation time, stream ID, and then source offset", () => {
    const log = new StreamEventLog(wrapSqlStorage(new DatabaseSync(":memory:")), "/receiver");
    const received = (
      offset: number,
      sourceOffset: number,
      streamCreatedAt = "2026-07-21T10:00:00.000Z",
      streamId = "11111111-1111-4111-8111-111111111111",
    ): StreamEvent => ({
      type: "events.iterate.com/stream/cross-post-list-recorded",
      payload: {
        source: { projectId: "project", path: "/source", streamId, streamCreatedAt },
        sourceOffset,
        subscriptionsByKey: {},
      },
      createdAt: new Date(offset).toISOString(),
      offset,
      path: "/receiver",
    });
    log.insert([
      received(1, 10),
      received(2, 12),
      received(3, 11),
      received(4, 1, "2026-07-22T10:00:00.000Z"),
      received(5, 100, "2026-07-21T10:00:00.000Z"),
      received(6, 1, "2026-07-22T10:00:00.000Z", "22222222-2222-4222-8222-222222222222"),
    ]);

    expect(log.getLatestCrossPostListFromSource("/source")).toMatchObject({
      offset: 6,
      payload: {
        source: {
          streamId: "22222222-2222-4222-8222-222222222222",
          streamCreatedAt: "2026-07-22T10:00:00.000Z",
        },
        sourceOffset: 1,
      },
    });
    expect(log.getLatestCrossPostListFromSource("/other")).toBeUndefined();
  });

  it("indexes the latest receiver-recorded list by source offset, not source-event order", () => {
    const log = new StreamEventLog(wrapSqlStorage(new DatabaseSync(":memory:")), "/source");
    const recorded = (offset: number, sourceOffset: number): StreamEvent => ({
      type: "events.iterate.com/stream/cross-post-list-confirmed",
      payload: {
        receivingStreamPath: "/receiver",
        sourceOffset,
        receivingStreamEvent: {
          type: "events.iterate.com/stream/cross-post-list-recorded",
          payload: {
            source: {
              projectId: "project",
              path: "/source",
              streamId: "11111111-1111-4111-8111-111111111111",
              streamCreatedAt: "2026-07-21T10:00:00.000Z",
            },
            sourceOffset,
            subscriptionsByKey: {},
          },
          createdAt: new Date(sourceOffset).toISOString(),
          offset: sourceOffset,
          path: "/receiver",
        },
      },
      createdAt: new Date(offset).toISOString(),
      offset,
      path: "/source",
    });
    log.insert([recorded(1, 10), recorded(2, 12), recorded(3, 11)]);

    expect(log.getLatestCrossPostListConfirmationForReceivingStream("/receiver")).toMatchObject({
      offset: 2,
      payload: { sourceOffset: 12 },
    });
    expect(log.getLatestCrossPostListConfirmationForReceivingStream("/other")).toBeUndefined();
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

describe("CrossPostListRetryStore latest-list retry", () => {
  function createStore() {
    const sql = wrapSqlStorage(new DatabaseSync(":memory:"));
    return new CrossPostListRetryStore(sql);
  }

  it("keeps the newest source offset per receiving stream and resets its retry ladder", () => {
    const store = createStore();
    store.ensure("/receivers/a", 5);
    store.fail("/receivers/a", {
      sourceOffset: 5,
      attempt: 3,
      nextAttemptAt: 9_000,
      error: "receiver unavailable",
    });

    expect(store.ensure("/receivers/a", 4)).toMatchObject({
      sourceOffset: 5,
      attempt: 3,
      nextAttemptAt: 9_000,
    });
    expect(store.ensure("/receivers/a", 6)).toMatchObject({
      sourceOffset: 6,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
    });
    expect(store.list()).toHaveLength(1);
  });

  it("ignores stale failures and deletes after a newer source offset replaces them", () => {
    const store = createStore();
    store.ensure("/receivers/a", 10);
    store.ensure("/receivers/a", 11);

    store.fail("/receivers/a", {
      sourceOffset: 10,
      attempt: 8,
      nextAttemptAt: 12_000,
      error: "late failure",
    });
    store.delete("/receivers/a", 10);
    expect(store.get("/receivers/a")).toMatchObject({
      sourceOffset: 11,
      attempt: 0,
    });

    store.delete("/receivers/a", 11);
    expect(store.get("/receivers/a")).toBeUndefined();
  });

  it("prunes receiver paths that no longer have source-side records", () => {
    const store = createStore();
    store.ensure("/receivers/a", 1);
    store.ensure("/receivers/b", 2);

    store.prune(new Set(["/receivers/b"]));

    expect(store.list()).toEqual([
      expect.objectContaining({ receivingStreamPath: "/receivers/b", sourceOffset: 2 }),
    ]);
  });

  it("does not report or rewrite an unchanged pending row", () => {
    const sql = wrapSqlStorage(new DatabaseSync(":memory:"));
    let mutations = 0;
    const store = new CrossPostListRetryStore(sql, {
      onMutation: () => {
        mutations += 1;
      },
    });

    store.ensure("/receivers/a", 4);
    expect(mutations).toBe(1);
    store.ensure("/receivers/a", 4);
    expect(mutations).toBe(1);
  });
});

function fromNodeSqlValue([key, value]: [string, unknown]) {
  if (value instanceof Uint8Array) {
    return [key, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)];
  }
  return [key, value];
}
