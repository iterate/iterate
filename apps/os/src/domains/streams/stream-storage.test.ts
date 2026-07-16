import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { StreamEvent } from "./schemas.ts";
import {
  reconcileSubscriptionCursorRows,
  SqliteSubscriptionCursorStore,
} from "./subscription-cursor-store.ts";
import { StreamEventLog } from "./stream-storage.ts";

function wrapSqlStorage(
  db: DatabaseSync,
  onExec?: (sql: string, bindings: readonly SqlStorageValue[]) => void,
  rangeCursor?: {
    onRaw(): void;
    forbidToArray: boolean;
  },
): SqlStorage {
  return {
    exec<T = unknown>(sql: string, ...bindings: (ArrayBuffer | null | number | string)[]) {
      onExec?.(sql, bindings);
      const isRawRowQuery =
        sql.includes("from events") &&
        (sql.includes("order by offset asc") ||
          sql.includes("order by offset desc") ||
          sql.includes("where idempotency_key in"));
      const statement = db.prepare(sql);
      const rows = statement
        .all(
          ...bindings.map((binding) =>
            binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
          ),
        )
        .map((row) => Object.fromEntries(Object.entries(row).map(fromNodeSqlValue)));
      const columnNames = statement.columns().map((column) => column.name);
      const rawRows = rows.map((row) =>
        columnNames.map((name) => row[name]),
      ) as SqlStorageValue[][];
      return {
        toArray: () => {
          if (isRawRowQuery && rangeCursor?.forbidToArray === true) {
            throw new Error("range query used named-object materialization");
          }
          return rows as T[];
        },
        raw: <U extends SqlStorageValue[]>() => {
          if (isRawRowQuery) rangeCursor?.onRaw();
          return (rawRows as U[])[Symbol.iterator]();
        },
        [Symbol.iterator]: () => (rows as T[])[Symbol.iterator](),
      };
    },
  } as unknown as SqlStorage;
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

function transactionRunner(db: DatabaseSync) {
  return {
    transactionSync<T>(callback: () => T): T {
      db.exec("begin");
      try {
        const result = callback();
        db.exec("commit");
        return result;
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },
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
  it("checks the current stream schema once when the event log initializes first", () => {
    const db = new DatabaseSync(":memory:");
    new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    const statements: string[] = [];
    const activationSql = wrapSqlStorage(db, (statement) => statements.push(statement));

    new StreamEventLog(activationSql, "/tests/stream");
    new SqliteSubscriptionCursorStore(activationSql);

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("select version");
    expect(statements[0]).toContain("highestOffset");
  });

  it("reuses the schema snapshot for one activation bounds read", () => {
    const db = new DatabaseSync(":memory:");
    const initial = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    initial.insert([event(1, "events.iterate.com/test/selected")]);
    const statements: string[] = [];
    const reactivated = new StreamEventLog(
      wrapSqlStorage(db, (statement) => statements.push(statement)),
      "/tests/stream",
    );

    expect(reactivated.takeBootstrapOffsetBounds()).toEqual({
      highestOffset: 1,
      highestAssignedOffset: 1,
    });
    expect(statements).toHaveLength(1);

    initial.insert([event(2, "events.iterate.com/test/other")]);
    expect(reactivated.offsetBounds()).toEqual({ highestOffset: 2, highestAssignedOffset: 2 });
    expect(statements).toHaveLength(2);
  });

  it("rejects any event-log schema other than the exact current version", () => {
    const db = new DatabaseSync(":memory:");
    const sql = wrapSqlStorage(db);
    new StreamEventLog(sql, "/tests/stream");
    db.exec("update stream_storage_schema set version = 3 where singleton = 1");
    expect(() => new StreamEventLog(wrapSqlStorage(db), "/tests/stream")).toThrow(
      "Unsupported stream storage schema version: 3",
    );
  });

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

  it("materializes range reads from positional raw rows", () => {
    const db = new DatabaseSync(":memory:");
    let rawReads = 0;
    const log = new StreamEventLog(
      wrapSqlStorage(db, undefined, {
        onRaw: () => {
          rawReads += 1;
        },
        forbidToArray: true,
      }),
      "/tests/stream",
    );
    log.insert([event(1, "selected"), event(2, "selected")]);

    expect(offsets(read(log, { afterOffset: 0, limit: 2 }))).toEqual([1, 2]);
    expect(rawReads).toBe(1);
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

  it("reads a filtered range newest first without changing its bounds", () => {
    const log = createLog();

    expect(
      offsets(
        read(log, {
          afterOffset: 1,
          eventTypes: ["events.iterate.com/test/selected"],
          limit: 2,
          order: "desc",
        }),
      ),
    ).toEqual([5, 3]);
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
      {
        ...event(2, "events.iterate.com/test/sized"),
        payload: { text: "héllo 🌍 Καλημέρα こんにちは" },
      },
    ];

    const inserted = log.insert(committedEvents);
    const insertedByteLengths = inserted.map((entry) => entry.byteLength);
    expect(inserted.map((entry) => entry.event)).toEqual(committedEvents);
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

    expect(
      log.getRangeSizes({
        afterOffset: 0,
        beforeOffset: Number.MAX_SAFE_INTEGER,
        limit: 10,
      }),
    ).toEqual([
      { offset: 1, byteLength: insertedByteLengths[0] },
      { offset: 2, byteLength: insertedByteLengths[1] },
    ]);
  });

  it("scans exact raw progress while materializing only selected event types", () => {
    const db = new DatabaseSync(":memory:");
    let selectedQuery: { statement: string; bindings: readonly SqlStorageValue[] } | undefined;
    const log = new StreamEventLog(
      wrapSqlStorage(db, (statement, bindings) => {
        if (statement.includes("with raw_bounds as materialized")) {
          selectedQuery = { statement, bindings };
        }
      }),
      "/tests/stream",
    );
    const committedEvents = [
      event(1, "ignored"),
      { ...event(2, "selected"), payload: { text: "first" } },
      event(3, "ignored"),
      { ...event(4, "selected"), payload: { text: "second" } },
      event(5, "ignored"),
    ];
    const inserted = log.insert(committedEvents);
    const firstSelectedByteLength = inserted[1]!.byteLength;

    const selected = log.scanPushEventTypesFrame({
      afterOffset: 0,
      throughOffset: 5,
      eventTypes: ["selected"],
      rawLimit: 5,
      selectedByteLimit: firstSelectedByteLength,
    });

    expect(selected).toEqual({
      events: [inserted[1]],
      scannedRawRows: 3,
      rawThroughOffset: 3,
      byteLength: firstSelectedByteLength,
      stoppedByByteLimit: true,
    });
    expect(selectedQuery).toBeDefined();
    const plan = db
      .prepare(`explain query plan ${selectedQuery!.statement}`)
      .all(
        ...selectedQuery!.bindings.map((binding) =>
          binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
        ),
      )
      .map((row) => String(row.detail));
    expect(plan).toContain("SEARCH events USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)");
    expect(
      plan.filter((detail) => detail === "SEARCH events USING INTEGER PRIMARY KEY (rowid=?)"),
    ).not.toHaveLength(0);
  });

  it("advances over selector misses and matching ephemeral rows without parsing them", () => {
    const log = new StreamEventLog(wrapSqlStorage(new DatabaseSync(":memory:")), "/tests/stream");
    log.insert([
      event(1, "ignored"),
      { ...event(2, "selected"), ephemeral: true },
      event(3, "ignored"),
    ]);

    expect(
      log.scanPushEventTypesFrame({
        afterOffset: 0,
        throughOffset: 3,
        eventTypes: ["selected"],
        rawLimit: 3,
        selectedByteLimit: 1,
      }),
    ).toEqual({
      events: [],
      scannedRawRows: 3,
      rawThroughOffset: 3,
      byteLength: 0,
      stoppedByByteLimit: false,
    });
  });

  it("hydrates a selected chunked singleton even when it exceeds the byte cap", () => {
    const log = new StreamEventLog(wrapSqlStorage(new DatabaseSync(":memory:")), "/tests/stream");
    const committed = { ...event(1, "selected"), payload: { text: "x".repeat(1_100 * 1024) } };
    const inserted = log.insert([committed])[0]!;

    expect(
      log.scanPushEventTypesFrame({
        afterOffset: 0,
        throughOffset: 1,
        eventTypes: ["selected"],
        rawLimit: 1,
        selectedByteLimit: 1,
      }),
    ).toEqual({
      events: [inserted],
      scannedRawRows: 1,
      rawThroughOffset: 1,
      byteLength: inserted.byteLength,
      stoppedByByteLimit: false,
    });
  });

  it("advances to the captured head across leading, internal, and trailing eviction gaps", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    log.insert([
      { ...event(1, "selected"), ephemeral: true },
      event(2, "selected"),
      { ...event(3, "selected"), ephemeral: true },
      event(4, "selected"),
      { ...event(5, "selected"), ephemeral: true },
    ]);
    log.evictEphemeralThrough(5, transactionRunner(db));

    expect(
      log.scanPushEventTypesFrame({
        afterOffset: 0,
        throughOffset: 5,
        eventTypes: ["selected"],
        rawLimit: 8,
        selectedByteLimit: Number.MAX_SAFE_INTEGER,
      }),
    ).toMatchObject({
      events: [{ event: event(2, "selected") }, { event: event(4, "selected") }],
      scannedRawRows: 2,
      rawThroughOffset: 5,
      stoppedByByteLimit: false,
    });
  });

  it("advances to the captured head when eviction leaves no surviving rows", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    log.insert([
      { ...event(1, "selected"), ephemeral: true },
      { ...event(2, "selected"), ephemeral: true },
    ]);
    log.evictEphemeralThrough(2, transactionRunner(db));

    expect(
      log.scanPushEventTypesFrame({
        afterOffset: 0,
        throughOffset: 2,
        eventTypes: ["selected"],
        rawLimit: 8,
        selectedByteLimit: 1,
      }),
    ).toEqual({
      events: [],
      scannedRawRows: 0,
      rawThroughOffset: 2,
      byteLength: 0,
      stoppedByByteLimit: false,
    });
  });

  it("stops at exactly the raw row limit before advancing the captured head", () => {
    const log = new StreamEventLog(wrapSqlStorage(new DatabaseSync(":memory:")), "/tests/stream");
    log.insert(Array.from({ length: 8_001 }, (_, index) => event(index + 1, "ignored")));

    expect(
      log.scanPushEventTypesFrame({
        afterOffset: 0,
        throughOffset: 8_001,
        eventTypes: ["selected"],
        rawLimit: 8_000,
        selectedByteLimit: 1,
      }),
    ).toEqual({
      events: [],
      scannedRawRows: 8_000,
      rawThroughOffset: 8_000,
      byteLength: 0,
      stoppedByByteLimit: false,
    });
  });

  it("matches the raw-frame model across gaps, ephemeral rows, selectors, and byte cuts", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    const committed = Array.from(
      { length: 240 },
      (_, index): StreamEvent => ({
        ...event(
          index + 1,
          index % 7 === 0 ? "selected" : index % 11 === 0 ? "alternate" : "ignored",
        ),
        ...(index % 13 === 0 ? { ephemeral: true } : {}),
        payload: { text: "x".repeat((index % 9) * 37 + 1) },
      }),
    );
    const inserted = log.insert(committed);
    const evictedThrough = 120;
    log.evictEphemeralThrough(evictedThrough, transactionRunner(db));
    const surviving = inserted.filter(
      ({ event: stored }) => stored.ephemeral !== true || stored.offset > evictedThrough,
    );
    let randomState = 0x6d2b79f5;
    const random = () => {
      randomState = Math.imul(randomState ^ (randomState >>> 15), randomState | 1);
      randomState ^= randomState + Math.imul(randomState ^ (randomState >>> 7), randomState | 61);
      return ((randomState ^ (randomState >>> 14)) >>> 0) / 4_294_967_296;
    };

    for (let trial = 0; trial < 100; trial += 1) {
      const afterOffset = Math.floor(random() * 250);
      const throughOffset = afterOffset + Math.floor(random() * (260 - afterOffset));
      const rawLimit = 1 + Math.floor(random() * 32);
      const eventTypes = random() < 0.5 ? ["selected"] : ["alternate", "selected"];
      const selectedByteLimit =
        random() < 0.2 ? Number.MAX_SAFE_INTEGER : 1 + Math.floor(random() * 1_200);
      const raw = surviving
        .filter(
          ({ event: stored }) => stored.offset > afterOffset && stored.offset <= throughOffset,
        )
        .slice(0, rawLimit);
      const selected = raw.filter(
        ({ event: stored }) => stored.ephemeral !== true && eventTypes.includes(stored.type),
      );
      let cumulativeBytes = 0;
      let firstExcludedOffset: number | undefined;
      const accepted = selected.filter((entry, index) => {
        cumulativeBytes += entry.byteLength;
        if (index > 0 && cumulativeBytes > selectedByteLimit) {
          firstExcludedOffset ??= entry.event.offset;
          return false;
        }
        return firstExcludedOffset === undefined;
      });
      const consumed =
        firstExcludedOffset === undefined
          ? raw
          : raw.filter(({ event: stored }) => stored.offset < firstExcludedOffset!);

      expect(
        log.scanPushEventTypesFrame({
          afterOffset,
          throughOffset,
          eventTypes,
          rawLimit,
          selectedByteLimit,
        }),
      ).toEqual({
        events: accepted,
        scannedRawRows: consumed.length,
        rawThroughOffset:
          firstExcludedOffset !== undefined
            ? (consumed.at(-1)?.event.offset ?? afterOffset)
            : raw.length < rawLimit
              ? throughOffset
              : raw.at(-1)!.event.offset,
        byteLength: accepted.reduce((total, entry) => total + entry.byteLength, 0),
        stoppedByByteLimit: firstExcludedOffset !== undefined,
      });
    }
  });

  it("binds large exact type sets as one JSON value", () => {
    const log = new StreamEventLog(wrapSqlStorage(new DatabaseSync(":memory:")), "/tests/stream");
    const selectedType = "type-127";
    const inserted = log.insert([event(1, selectedType)])[0]!;

    expect(
      log.scanPushEventTypesFrame({
        afterOffset: 0,
        throughOffset: 1,
        eventTypes: Array.from({ length: 128 }, (_, index) => `type-${index}`),
        rawLimit: 8,
        selectedByteLimit: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({
      events: [inserted],
      scannedRawRows: 1,
      rawThroughOffset: 1,
      byteLength: inserted.byteLength,
      stoppedByByteLimit: false,
    });
  });

  it("round-trips the exact committed source and payload representation", () => {
    const log = new StreamEventLog(wrapSqlStorage(new DatabaseSync(":memory:")), "/tests/stream");
    const committed: StreamEvent = {
      ...event(1, "events.iterate.com/test/sourced"),
      payload: { nested: { value: true } },
      metadata: { traceId: "trace" },
      source: {
        processor: {
          slug: "processor",
          version: "1",
          stream: { projectId: null, path: "/processor" },
          whileProcessing: { offset: 7, type: "events.iterate.com/test/origin" },
        },
      },
    };

    log.insert([committed]);
    const replayed = log.getRangeSized({ afterOffset: 0, beforeOffset: 2, limit: 1 })[0]!.event;

    expect(replayed).toEqual(committed);
    expect(replayed).not.toBe(committed);
    expect(replayed.payload).not.toBe(committed.payload);
  });

  it("fails loudly when stored JSON syntax is corrupt", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    log.insert([event(1, "events.iterate.com/test/corrupt")]);
    db.prepare("update events set event_json = ? where offset = 1").run(
      new TextEncoder().encode('{"type":'),
    );

    expect(() => log.getByOffset(1)).toThrow(SyntaxError);
    expect(() => read(log, { afterOffset: 0, limit: 1 })).toThrow(SyntaxError);
  });

  it("writes a bounded single event inline with one statement", () => {
    const inserts: Array<{ statement: string; bindings: readonly SqlStorageValue[] }> = [];
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(
      wrapSqlStorage(db, (statement, bindings) => {
        if (statement.startsWith("insert into event")) inserts.push({ statement, bindings });
      }),
      "/tests/stream",
    );
    const committed = {
      ...event(1, "events.iterate.com/test/single-insert"),
      payload: { text: "héllo 🌍" },
    };

    const inserted = log.insert([committed]);

    expect(inserts.map(({ bindings }) => bindings.length)).toEqual([3]);
    expect(inserts.every(({ statement }) => !statement.includes("), ("))).toBe(true);
    expect(inserts[0]?.statement).toContain("(offset, type, event_json)");
    expect(inserts[0]?.bindings[2]).toBeInstanceOf(ArrayBuffer);
    expect(db.prepare("select typeof(event_json) as type from events").get()).toEqual({
      type: "blob",
    });
    const stored = JSON.parse(
      new TextDecoder().decode(
        db.prepare("select event_json from events").get()!.event_json as Uint8Array,
      ),
    ) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("path");
    const storedByteLength = db.prepare("select length(event_json) as value from events").get()!
      .value as number;
    const textEncoder = new TextEncoder();
    expect(storedByteLength).toBe(
      textEncoder.encode(JSON.stringify(committed)).byteLength -
        textEncoder.encode(`,"path":${JSON.stringify(committed.path)}`).byteLength,
    );
    expect(db.prepare("select count(*) as count from event_chunks").get()).toEqual({ count: 0 });
    expect(inserted).toEqual([
      {
        event: committed,
        byteLength: new TextEncoder().encode(JSON.stringify(committed)).byteLength,
      },
    ]);
    expect(log.getByOffset(1)).toEqual(committed);
  });

  it("binds explicit metadata columns when a batch contains keyed or ephemeral events", () => {
    const inserts: Array<{ statement: string; bindings: readonly SqlStorageValue[] }> = [];
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(
      wrapSqlStorage(db, (statement, bindings) => {
        if (statement.startsWith("insert into events ")) inserts.push({ statement, bindings });
      }),
      "/tests/stream",
    );

    log.insert([
      { ...event(1, "keyed"), idempotencyKey: "key-1" },
      { ...event(2, "ephemeral"), ephemeral: true },
    ]);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.statement).toContain(
      "(offset, type, idempotency_key, ephemeral, event_json)",
    );
    expect(inserts[0]?.bindings).toHaveLength(10);
    expect(inserts[0]?.bindings.slice(2, 4)).toEqual(["key-1", 0]);
    expect(inserts[0]?.bindings.slice(7, 9)).toEqual([null, 1]);
    expect(log.getByIdempotencyKey("key-1")?.offset).toBe(1);
    expect(log.getByOffset(2)?.ephemeral).toBe(true);
  });

  it("abandons derived metadata when a later event is keyed or ephemeral", () => {
    const inserts: Array<{ sql: string; bindings: number }> = [];
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(
      wrapSqlStorage(db, (statement, bindings) => {
        if (statement.startsWith("insert into events ")) {
          inserts.push({ sql: statement, bindings: bindings.length });
        }
      }),
      "/tests/stream",
    );
    const committedEvents = Array.from({ length: 34 }, (_, index) => ({
      ...event(index + 1, "same-type"),
      ...(index === 17 ? { idempotencyKey: "late-key" } : {}),
      ...(index === 33 ? { ephemeral: true as const } : {}),
    }));

    log.insert(committedEvents, transactionRunner(db));

    expect(inserts.map((insert) => insert.bindings)).toEqual([100, 70]);
    expect(inserts.every((insert) => !insert.sql.includes("select ? + column1"))).toBe(true);
    expect(log.getByIdempotencyKey("late-key")?.offset).toBe(18);
    expect(log.getByOffset(34)?.ephemeral).toBe(true);
  });

  it("rejects an event belonging to another stream", () => {
    const log = new StreamEventLog(wrapSqlStorage(new DatabaseSync(":memory:")), "/tests/stream");
    expect(() => log.insert([{ ...event(1, "wrong-path"), path: "/other" }])).toThrow(
      "Cannot store event for path /other in stream /tests/stream",
    );
  });

  it("keeps medium-large events inline while chunking values beyond the inline ceiling", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");

    log.insert([
      { ...event(1, "inline"), payload: { text: "x".repeat(768 * 1024) } },
      { ...event(2, "chunked"), payload: { text: "x".repeat(1_100 * 1024) } },
    ]);

    expect(
      db
        .prepare("select offset, event_json is not null as is_inline from events order by offset")
        .all(),
    ).toEqual([
      { offset: 1, is_inline: 1 },
      { offset: 2, is_inline: 0 },
    ]);
    expect(
      db.prepare("select offset, count(*) as count from event_chunks group by offset").all(),
    ).toEqual([{ offset: 2, count: 3 }]);
  });

  it("opens transactions only for multi-statement commits", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    let transactions = 0;
    const transactionRunner = {
      transactionSync<T>(callback: () => T): T {
        transactions += 1;
        db.exec("begin");
        try {
          const result = callback();
          db.exec("commit");
          return result;
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      },
    };

    log.insert([event(1, "single")], transactionRunner);
    expect(transactions).toBe(0);

    log.insert([event(2, "batch"), event(3, "batch")], transactionRunner);
    expect(transactions).toBe(0);

    log.insert(
      Array.from({ length: 34 }, (_, index) => event(index + 4, "large-batch")),
      transactionRunner,
    );
    expect(transactions).toBe(0);

    log.insert(
      [{ ...event(38, "large"), payload: { text: "x".repeat(1_100 * 1024) } }],
      transactionRunner,
    );
    expect(transactions).toBe(1);
    expect(offsets(read(log, { afterOffset: 0, limit: 38 }))).toEqual(
      Array.from({ length: 38 }, (_, index) => index + 1),
    );
  });

  it("rolls back oversized metadata when a chunk write fails", () => {
    const db = new DatabaseSync(":memory:");
    let failChunkInsert = true;
    const log = new StreamEventLog(
      wrapSqlStorage(db, (statement) => {
        if (failChunkInsert && statement.startsWith("insert into event_chunks ")) {
          throw new Error("injected chunk failure");
        }
      }),
      "/tests/stream",
    );
    const transactionRunner = {
      transactionSync<T>(callback: () => T): T {
        db.exec("begin");
        try {
          const result = callback();
          db.exec("commit");
          return result;
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      },
    };

    expect(() =>
      log.insert(
        [{ ...event(1, "large"), payload: { text: "x".repeat(1_100 * 1024) } }],
        transactionRunner,
      ),
    ).toThrow("injected chunk failure");
    expect(db.prepare("select count(*) as count from events").get()).toEqual({ count: 0 });
    expect(db.prepare("select count(*) as count from event_chunks").get()).toEqual({ count: 0 });

    failChunkInsert = false;
    log.insert([event(1, "retry")], transactionRunner);
    expect(log.getByOffset(1)?.type).toBe("retry");
  });

  it("scans bounded inline ranges by primary key without a temporary sort", () => {
    const db = new DatabaseSync(":memory:");
    let rangeQuery: { statement: string; bindings: readonly SqlStorageValue[] } | undefined;
    const log = new StreamEventLog(
      wrapSqlStorage(db, (statement, bindings) => {
        if (
          statement.includes(
            "select coalesce(cast(event_json as text), offset) as eventJsonOrOffset\n          from events",
          )
        ) {
          rangeQuery = { statement, bindings };
        }
      }),
      "/tests/stream",
    );
    log.insert(Array.from({ length: 10 }, (_, index) => event(index + 1, "selected")));

    expect(offsets(read(log, { afterOffset: 2, eventTypes: ["selected"], limit: 4 }))).toEqual([
      3, 4, 5, 6,
    ]);
    expect(rangeQuery).toBeDefined();
    const plan = db
      .prepare(`explain query plan ${rangeQuery!.statement}`)
      .all(
        ...rangeQuery!.bindings.map((binding) =>
          binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
        ),
      )
      .map((row) => String(row.detail));
    expect(plan).toContain("SEARCH events USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)");
    expect(plan.some((detail) => detail.includes("USE TEMP B-TREE"))).toBe(false);

    expect(
      offsets(
        read(log, {
          afterOffset: 2,
          eventTypes: ["selected"],
          limit: 4,
          order: "desc",
        }),
      ),
    ).toEqual([10, 9, 8, 7]);
    const descendingPlan = db
      .prepare(`explain query plan ${rangeQuery!.statement}`)
      .all(
        ...rangeQuery!.bindings.map((binding) =>
          binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
        ),
      )
      .map((row) => String(row.detail));
    expect(descendingPlan).toContain(
      "SEARCH events USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)",
    );
    expect(descendingPlan.some((detail) => detail.includes("USE TEMP B-TREE"))).toBe(false);
  });

  it("batches inserts within Durable Object SQL's 100-binding limit", () => {
    const inserts: Array<{ sql: string; bindings: number }> = [];
    const db = new DatabaseSync(":memory:");
    const sql = wrapSqlStorage(db, (statement, bindings) => {
      if (statement.startsWith("insert into event")) {
        inserts.push({ sql: statement, bindings: bindings.length });
      }
    });
    const log = new StreamEventLog(sql, "/tests/stream");
    const committedEvents = Array.from({ length: 100 }, (_, index) =>
      event(index + 1, "events.iterate.com/test/batched"),
    );

    log.insert(committedEvents);

    const eventInserts = inserts.filter((insert) => insert.sql.startsWith("insert into events "));
    const chunkInserts = inserts.filter((insert) =>
      insert.sql.startsWith("insert into event_chunks "),
    );
    expect(eventInserts.map((insert) => insert.bindings)).toEqual([100, 4]);
    expect(eventInserts.every((insert) => insert.sql.includes("select ? + column1"))).toBe(true);
    expect(chunkInserts).toHaveLength(0);
    expect(inserts.every((insert) => insert.bindings <= 100)).toBe(true);
    expect(offsets(read(log, { afterOffset: 0, limit: 100 }))).toEqual(
      committedEvents.map((entry) => entry.offset),
    );
    expect(db.prepare("select offset, type from events order by offset").all()).toEqual(
      committedEvents.map(({ offset, type }) => ({ offset, type })),
    );
  });

  it("pins the 98-row derived binding ceiling and 99-row split", () => {
    for (const [eventCount, expectedBindings] of [
      [98, [100]],
      [99, [100, 3]],
    ] as const) {
      const inserts: Array<{ sql: string; bindings: number }> = [];
      const db = new DatabaseSync(":memory:");
      const log = new StreamEventLog(
        wrapSqlStorage(db, (statement, bindings) => {
          if (statement.startsWith("insert into events ")) {
            inserts.push({ sql: statement, bindings: bindings.length });
          }
        }),
        "/tests/stream",
      );
      const committedEvents = Array.from({ length: eventCount }, (_, index) =>
        event(index + 50, "same-type"),
      );

      log.insert(committedEvents, transactionRunner(db));

      expect(inserts.map((insert) => insert.bindings)).toEqual(expectedBindings);
      expect(inserts.every((insert) => insert.sql.includes("select ? + column1"))).toBe(true);
      expect(db.prepare("select offset, type from events order by offset").all()).toEqual(
        committedEvents.map(({ offset, type }) => ({ offset, type })),
      );
    }
  });

  it("keeps an at-capacity keyless batch on the direct values statement", () => {
    const inserts: Array<{ sql: string; bindings: number }> = [];
    const log = new StreamEventLog(
      wrapSqlStorage(new DatabaseSync(":memory:"), (statement, bindings) => {
        if (statement.startsWith("insert into events ")) {
          inserts.push({ sql: statement, bindings: bindings.length });
        }
      }),
      "/tests/stream",
    );

    log.insert(Array.from({ length: 33 }, (_, index) => event(index + 1, "same-type")));

    expect(inserts.map((insert) => insert.bindings)).toEqual([99]);
    expect(inserts[0]?.sql).toContain(" values ");
    expect(inserts[0]?.sql).not.toContain("select ? + column1");
  });

  it("uses explicit row metadata when a keyless batch is heterogeneous or noncontiguous", () => {
    for (const committedEvents of [
      Array.from({ length: 34 }, (_, index) =>
        event(index + 1, index === 17 ? "different-type" : "same-type"),
      ),
      Array.from({ length: 34 }, (_, index) => event(index === 17 ? 100 : index + 1, "same-type")),
    ]) {
      const inserts: Array<{ sql: string; bindings: number }> = [];
      const log = new StreamEventLog(
        wrapSqlStorage(new DatabaseSync(":memory:"), (statement, bindings) => {
          if (statement.startsWith("insert into events ")) {
            inserts.push({ sql: statement, bindings: bindings.length });
          }
        }),
        "/tests/stream",
      );

      log.insert(committedEvents);

      expect(inserts.map((insert) => insert.bindings)).toEqual([99, 3]);
      expect(inserts.every((insert) => !insert.sql.includes("select ? + column1"))).toBe(true);
    }
  });

  it("rolls back earlier derived-offset statements when a later row conflicts", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    log.insert([event(100, "existing")]);

    expect(() =>
      log.insert(
        Array.from({ length: 100 }, (_, index) => event(index + 1, "same-type")),
        transactionRunner(db),
      ),
    ).toThrow();

    expect(db.prepare("select offset, type from events").all()).toEqual([
      { offset: 100, type: "existing" },
    ]);
  });

  it("rebinds the derived base offset after a byte-bounded metadata flush", () => {
    const db = new DatabaseSync(":memory:");
    const eventInsertBindings: number[] = [];
    const log = new StreamEventLog(
      wrapSqlStorage(db, (statement, bindings) => {
        if (statement.startsWith("insert into events ")) {
          eventInsertBindings.push(bindings.length);
        }
      }),
      "/tests/stream",
    );
    let payloadReads = 0;
    const committedEvents = Array.from({ length: 34 }, (_, index) => {
      const payload: Record<string, unknown> = {};
      Object.defineProperty(payload, "text", {
        enumerable: true,
        get: () => {
          payloadReads += 1;
          return `${index}-${"x".repeat(40 * 1024)}`;
        },
      });
      return { ...event(index + 1, "same-type"), payload };
    });

    log.insert(committedEvents, transactionRunner(db));

    expect(eventInsertBindings).toHaveLength(2);
    expect(eventInsertBindings.every((bindings) => bindings <= 100)).toBe(true);
    expect(payloadReads).toBe(committedEvents.length);
    expect(offsets(read(log, { afterOffset: 0, limit: 34 }))).toEqual(
      committedEvents.map((event) => event.offset),
    );
  });

  it("keeps derived metadata and chunks in one transaction", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    const committedEvents = Array.from({ length: 34 }, (_, index) => ({
      ...event(index + 1, "same-type"),
      ...(index === 17 ? { payload: { text: "x".repeat(1_100 * 1024) } } : {}),
    }));
    let transactions = 0;
    const runner = {
      transactionSync<T>(callback: () => T): T {
        transactions += 1;
        return transactionRunner(db).transactionSync(callback);
      },
    };

    log.insert(committedEvents, runner);

    expect(transactions).toBe(1);
    expect(db.prepare("select count(*) as count from event_chunks").get()).toEqual({ count: 3 });
    expect(offsets(read(log, { afterOffset: 0, limit: 34 }))).toEqual(
      committedEvents.map((event) => event.offset),
    );
  });

  it("serializes a bounded event only once when it crosses an insert batch boundary", () => {
    const log = new StreamEventLog(wrapSqlStorage(new DatabaseSync(":memory:")), "/tests/stream");
    const text = "x".repeat(600 * 1024);
    let payloadReads = 0;
    const committedEvents = Array.from({ length: 3 }, (_, index) => {
      const payload: Record<string, unknown> = {};
      Object.defineProperty(payload, "text", {
        enumerable: true,
        get: () => {
          payloadReads += 1;
          return text;
        },
      });
      return { ...event(index + 1, "events.iterate.com/test/large-batch"), payload };
    });

    log.insert(committedEvents);

    expect(payloadReads).toBe(committedEvents.length);
    expect(offsets(read(log, { afterOffset: 0, limit: 3 }))).toEqual([1, 2, 3]);
  });

  it("serializes an oversized single event only once when the direct path falls back", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    let payloadReads = 0;
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, "text", {
      enumerable: true,
      get: () => {
        payloadReads += 1;
        return "x".repeat(1_100 * 1024);
      },
    });
    const committed = { ...event(1, "events.iterate.com/test/large-single"), payload };

    log.insert([committed]);

    expect(payloadReads).toBe(1);
    expect(db.prepare("select count(*) as count from event_chunks").get()).toEqual({ count: 3 });
    expect(log.getByOffset(1)).toEqual({
      ...committed,
      payload: { text: "x".repeat(1_100 * 1024) },
    });
  });

  it("batches idempotency lookups and returns only durable hits", () => {
    const selects: number[] = [];
    const sql = wrapSqlStorage(new DatabaseSync(":memory:"), (statement, bindings) => {
      if (statement.includes("where idempotency_key in")) selects.push(bindings.length);
    });
    const log = new StreamEventLog(sql, "/tests/stream");
    const committedEvents = Array.from({ length: 120 }, (_, index) => ({
      ...event(index + 1, "events.iterate.com/test/idempotent"),
      idempotencyKey: `existing-${index + 1}`,
    }));
    log.insert(committedEvents);
    const keys = [
      ...committedEvents.map((entry) => entry.idempotencyKey),
      ...Array.from({ length: 100 }, (_, index) => `missing-${index + 1}`),
    ];

    const hits = log.getByIdempotencyKeys(keys);

    expect(selects).toEqual([100, 100, 20]);
    expect(hits.size).toBe(committedEvents.length);
    for (const event of committedEvents) expect(hits.get(event.idempotencyKey)).toEqual(event);
  });

  it("resolves acknowledged idempotency hits without reading event bodies or chunks", () => {
    const statements: string[] = [];
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(
      wrapSqlStorage(db, (statement) => statements.push(statement)),
      "/tests/stream",
    );
    log.insert([
      { ...event(1, "small"), idempotencyKey: "small" },
      {
        ...event(2, "large"),
        payload: { text: "x".repeat(1_100 * 1024) },
        idempotencyKey: "large",
      },
    ]);
    statements.length = 0;

    expect(log.getOffsetByIdempotencyKey("large")).toBe(2);
    expect(log.getOffsetByIdempotencyKey("missing")).toBeUndefined();
    expect(log.getOffsetsByIdempotencyKeys(["missing", "large", "small"])).toEqual(
      new Map([
        ["small", 1],
        ["large", 2],
      ]),
    );
    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      expect(statement).not.toContain("event_json");
      expect(statement).not.toContain("event_chunks");
    }
  });

  it("does not sort batched idempotency hits that callers resolve by key", () => {
    const db = new DatabaseSync(":memory:");
    let lookup: { statement: string; bindings: readonly SqlStorageValue[] } | undefined;
    const log = new StreamEventLog(
      wrapSqlStorage(db, (statement, bindings) => {
        if (statement.includes("where idempotency_key in")) lookup = { statement, bindings };
      }),
      "/tests/stream",
    );
    log.insert([
      { ...event(1, "selected"), idempotencyKey: "first" },
      { ...event(2, "selected"), idempotencyKey: "second" },
    ]);

    expect(log.getByIdempotencyKeys(["second", "first"]).size).toBe(2);
    expect(lookup).toBeDefined();
    const plan = db
      .prepare(`explain query plan ${lookup!.statement}`)
      .all(
        ...lookup!.bindings.map((binding) =>
          binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
        ),
      )
      .map((row) => String(row.detail));
    expect(plan).toContain("SEARCH events USING INDEX events_idempotency_key (idempotency_key=?)");
    expect(plan.some((detail) => detail.includes("USE TEMP B-TREE"))).toBe(false);
  });

  it("materializes batched idempotency hits from positional raw rows", () => {
    const db = new DatabaseSync(":memory:");
    let rawReads = 0;
    const log = new StreamEventLog(
      wrapSqlStorage(db, undefined, {
        onRaw: () => {
          rawReads += 1;
        },
        forbidToArray: true,
      }),
      "/tests/stream",
    );
    const committed = [
      { ...event(1, "selected"), idempotencyKey: "first" },
      { ...event(2, "selected"), idempotencyKey: "second" },
    ];
    log.insert(committed);

    expect([...log.getByIdempotencyKeys(["first", "second"]).values()]).toEqual(committed);
    expect(rawReads).toBe(1);
  });

  it("round-trips UTF-8 whose code point spans event chunk rows", () => {
    const log = new StreamEventLog(wrapSqlStorage(new DatabaseSync(":memory:")), "/tests/stream");
    const empty = { ...event(1, "events.iterate.com/test/large"), payload: { text: "" } };
    const serializedEmpty = JSON.stringify(empty);
    const textStart = serializedEmpty.indexOf('"text":"') + '"text":"'.length;
    const splitText = `${"x".repeat(512 * 1024 - textStart - 1)}\u20ac-after-boundary${"x".repeat(512 * 1024)}`;
    const large = { ...empty, payload: { text: splitText }, idempotencyKey: "large-event" };

    log.insert([large]);

    expect(log.getByOffset(1)).toEqual(large);
    expect(log.getByIdempotencyKey("large-event")).toEqual(large);
    expect(read(log, { afterOffset: 0, limit: 1 })).toEqual([large]);
    expect(
      log.getRangeSized({ afterOffset: 0, beforeOffset: 2, limit: 1 }).map((entry) => entry.event),
    ).toEqual([large]);
  });

  it("preserves order and byte sizes across mixed inline and chunked rows", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    const committedEvents = [
      { ...event(1, "small"), idempotencyKey: "small-1" },
      {
        ...event(2, "large"),
        payload: { text: "x".repeat(1_100 * 1024) },
        idempotencyKey: "large-2",
      },
      { ...event(3, "small"), idempotencyKey: "small-3" },
    ];

    const inserted = log.insert(committedEvents);

    expect(
      db
        .prepare("select offset, event_json is not null as is_inline from events order by offset")
        .all(),
    ).toEqual([
      { offset: 1, is_inline: 1 },
      { offset: 2, is_inline: 0 },
      { offset: 3, is_inline: 1 },
    ]);
    expect(
      db
        .prepare(
          `select offset,
                  chunked_json_byte_length as stored_length,
                  (select sum(length(chunk_bytes))
                   from event_chunks
                   where event_chunks.offset = events.offset) as chunk_length
           from events
           order by offset`,
        )
        .all(),
    ).toEqual([
      { offset: 1, stored_length: null, chunk_length: null },
      { offset: 2, stored_length: expect.any(Number), chunk_length: expect.any(Number) },
      { offset: 3, stored_length: null, chunk_length: null },
    ]);
    const chunkedLengths = db
      .prepare(
        `select chunked_json_byte_length as stored_length,
                (select sum(length(chunk_bytes))
                 from event_chunks
                 where event_chunks.offset = events.offset) as chunk_length
         from events
         where offset = 2`,
      )
      .get();
    expect(chunkedLengths!.stored_length).toBe(chunkedLengths!.chunk_length);
    expect(log.getRangeSized({ afterOffset: 0, beforeOffset: 4, limit: 3 })).toEqual(inserted);
    expect(
      log.getRangeSized({
        afterOffset: 0,
        beforeOffset: 4,
        limit: 3,
        order: "desc",
      }),
    ).toEqual([...inserted].reverse());
    const hits = log.getByIdempotencyKeys(["small-3", "large-2", "small-1"]);
    for (const event of committedEvents) expect(hits.get(event.idempotencyKey)).toEqual(event);
  });

  it("chunks by UTF-8 bytes when character length remains below the threshold", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    const large = {
      ...event(1, "events.iterate.com/test/multibyte-large"),
      payload: { text: "é".repeat(600 * 1024) },
    };

    const [sized] = log.insert([large]);

    expect(db.prepare("select count(*) as count from event_chunks where offset = 1").get()).toEqual(
      { count: 3 },
    );
    expect(sized?.byteLength).toBe(new TextEncoder().encode(JSON.stringify(large)).byteLength);
    expect(log.getByOffset(1)).toEqual(large);
  });

  it("resolves offset hits and misses with one SQL query each", () => {
    const pointReadBindings: SqlStorageValue[][] = [];
    const sql = wrapSqlStorage(new DatabaseSync(":memory:"), (statement, bindings) => {
      if (
        statement.includes(
          "select cast(event_json as text) as eventJson from events where offset = ?",
        )
      ) {
        pointReadBindings.push([...bindings]);
      }
    });
    const log = new StreamEventLog(sql, "/tests/stream");
    const committed = event(1, "events.iterate.com/test/point-read");
    log.insert([committed]);

    expect(log.getByOffset(1)).toEqual(committed);
    expect(log.getByOffset(2)).toBeUndefined();
    expect(pointReadBindings).toEqual([[1], [2]]);
  });

  it("resolves idempotency hits and misses with one direct SQL query each", () => {
    const pointReadBindings: SqlStorageValue[][] = [];
    const sql = wrapSqlStorage(new DatabaseSync(":memory:"), (statement, bindings) => {
      if (statement.includes("from events where idempotency_key = ?")) {
        pointReadBindings.push([...bindings]);
      }
      expect(statement).not.toContain("where events.idempotency_key in (?)");
    });
    const log = new StreamEventLog(sql, "/tests/stream");
    const committed = {
      ...event(1, "events.iterate.com/test/idempotency-point-read"),
      idempotencyKey: "existing",
    };
    log.insert([committed]);

    expect(log.getByIdempotencyKey("existing")).toEqual(committed);
    expect(log.getByIdempotencyKey("missing")).toBeUndefined();
    expect(log.getByIdempotencyKeys(["existing"])).toEqual(new Map([["existing", committed]]));
    expect(log.getByIdempotencyKeys(["missing"])).toEqual(new Map());
    expect(pointReadBindings).toEqual([["existing"], ["missing"], ["existing"], ["missing"]]);
  });

  it("does not resolve orphan chunks as committed events", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    const orphan = event(1, "events.iterate.com/test/point-read");
    log.insert([orphan]);
    db.prepare("insert into event_chunks (offset, chunk_index, chunk_bytes) values (1, 0, ?)").run(
      new TextEncoder().encode(JSON.stringify(orphan)),
    );
    db.prepare("delete from events where offset = 1").run();

    expect(log.getByOffset(1)).toBeUndefined();
  });

  it("omits incomplete chunked rows without disturbing inline range order", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    const committedEvents = [
      event(1, "events.iterate.com/test/inline"),
      {
        ...event(2, "events.iterate.com/test/incomplete"),
        payload: { text: "x".repeat(1_100 * 1024) },
      },
      event(3, "events.iterate.com/test/inline"),
    ];
    log.insert(committedEvents);
    db.exec("delete from event_chunks where offset = 2");

    expect(offsets(read(log, { afterOffset: 0, limit: 3 }))).toEqual([1, 3]);
    expect(
      log
        .getRangeSized({ afterOffset: 0, beforeOffset: 4, limit: 3 })
        .map(({ event: readEvent }) => readEvent.offset),
    ).toEqual([1, 3]);
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

  it("creates only the current event-log schema on a fresh database", () => {
    const db = new DatabaseSync(":memory:");
    const statements: string[] = [];

    new StreamEventLog(
      wrapSqlStorage(db, (statement) => statements.push(statement)),
      "/tests/stream",
    );

    expect(statements.some((statement) => statement.includes("pragma_table_info"))).toBe(false);
    expect(statements.some((statement) => statement.includes("alter table"))).toBe(false);
    expect(
      db
        .prepare("select name from pragma_table_info('events') order by cid")
        .all()
        .map((column) => column.name),
    ).toEqual([
      "offset",
      "type",
      "idempotency_key",
      "ephemeral",
      "event_json",
      "chunked_json_byte_length",
    ]);
    expect(
      db
        .prepare("select name from pragma_table_info('stream_storage_schema') order by cid")
        .all()
        .map((column) => column.name),
    ).toEqual(["singleton", "version", "evicted_offset_floor"]);
    expect(
      String(db.prepare("select sql from sqlite_master where name = 'events'").get()!.sql),
    ).not.toMatch(/autoincrement/i);
    expect(db.prepare("select name from sqlite_master where name = 'sqlite_sequence'").get()).toBe(
      undefined,
    );
    expect(
      db.prepare("select version, evicted_offset_floor as floor from stream_storage_schema").get(),
    ).toEqual({ version: 8, floor: 0 });
    expect(
      db
        .prepare(
          "select name, \"unique\" as isUnique, partial from pragma_index_list('events') order by name",
        )
        .all(),
    ).toEqual([{ name: "events_idempotency_key", isUnique: 1, partial: 1 }]);
  });

  it("indexes only non-null idempotency keys and uses that index for point reads", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    log.insert([
      event(1, "events.iterate.com/test/unkeyed"),
      event(2, "events.iterate.com/test/unkeyed"),
      { ...event(3, "events.iterate.com/test/keyed"), idempotencyKey: "unique-key" },
    ]);

    expect(() =>
      log.insert([{ ...event(4, "events.iterate.com/test/keyed"), idempotencyKey: "unique-key" }]),
    ).toThrow();
    expect(
      db
        .prepare(
          "explain query plan select offset, event_json from events where idempotency_key = ?",
        )
        .all("unique-key")
        .map((row) => row.detail),
    ).toEqual(["SEARCH events USING INDEX events_idempotency_key (idempotency_key=?)"]);
  });

  it("reads both offset bounds once and preserves the allocator floor after eviction", () => {
    const db = new DatabaseSync(":memory:");
    let boundsQueries = 0;
    const log = new StreamEventLog(
      wrapSqlStorage(db, (statement) => {
        if (statement.includes("select highestOffset,")) boundsQueries += 1;
      }),
      "/tests/stream",
    );
    log.insert([
      event(1, "events.iterate.com/test/durable"),
      { ...event(2, "events.iterate.com/test/chunk"), ephemeral: true },
    ]);
    log.evictEphemeralThrough(2, transactionRunner(db));

    expect(log.offsetBounds()).toEqual({ highestOffset: 1, highestAssignedOffset: 2 });
    expect(boundsQueries).toBe(1);
    const reactivated = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    expect(reactivated.offsetBounds()).toEqual({ highestOffset: 1, highestAssignedOffset: 2 });
    reactivated.insert([event(3, "events.iterate.com/test/after-eviction")]);
    expect(reactivated.offsetBounds()).toEqual({ highestOffset: 3, highestAssignedOffset: 3 });
  });

  it("evicts only eligible ephemeral rows and advances the floor atomically", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    log.insert([
      event(1, "events.iterate.com/test/durable"),
      { ...event(2, "events.iterate.com/test/chunk"), ephemeral: true },
      event(3, "events.iterate.com/test/durable"),
      { ...event(4, "events.iterate.com/test/chunk"), ephemeral: true },
    ]);

    log.evictEphemeralThrough(3, transactionRunner(db));

    expect(
      db
        .prepare("select offset from events order by offset")
        .all()
        .map(({ offset }) => offset),
    ).toEqual([1, 3, 4]);
    expect(log.offsetBounds()).toEqual({ highestOffset: 4, highestAssignedOffset: 4 });
    expect(
      db.prepare("select evicted_offset_floor as floor from stream_storage_schema").get(),
    ).toEqual({ floor: 2 });

    log.evictEphemeralThrough(4, transactionRunner(db));
    expect(log.offsetBounds()).toEqual({ highestOffset: 3, highestAssignedOffset: 4 });
  });

  it("rolls back the eviction floor when row deletion fails", () => {
    const db = new DatabaseSync(":memory:");
    let failDelete = false;
    const log = new StreamEventLog(
      wrapSqlStorage(db, (statement) => {
        if (failDelete && statement.startsWith("delete from events")) {
          throw new Error("injected deletion failure");
        }
      }),
      "/tests/stream",
    );
    log.insert([
      event(1, "events.iterate.com/test/durable"),
      {
        ...event(2, "events.iterate.com/test/chunk"),
        ephemeral: true,
        payload: { text: "x".repeat(1_100 * 1024) },
      },
    ]);
    expect(db.prepare("select count(*) as count from event_chunks").get()).toEqual({ count: 3 });
    failDelete = true;

    expect(() => log.evictEphemeralThrough(2, transactionRunner(db))).toThrow(
      "injected deletion failure",
    );
    expect(db.prepare("select offset from events order by offset").all()).toEqual([
      { offset: 1 },
      { offset: 2 },
    ]);
    expect(db.prepare("select count(*) as count from event_chunks").get()).toEqual({ count: 3 });
    expect(
      db.prepare("select evicted_offset_floor as floor from stream_storage_schema").get(),
    ).toEqual({ floor: 0 });
  });

  it("rejects invalid ephemeral eviction offsets before opening a transaction", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    const runner = transactionRunner(db);

    expect(() => log.evictEphemeralThrough(-1, runner)).toThrow(
      "Invalid ephemeral eviction offset: -1",
    );
    expect(() => log.evictEphemeralThrough(1.5, runner)).toThrow(
      "Invalid ephemeral eviction offset: 1.5",
    );
  });

  it("replaces the complete log and continues allocating after the imported offset", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    log.insert([event(1, "events.iterate.com/test/replaced")]);
    const imported = [
      event(1, "events.iterate.com/stream/created"),
      event(9, "events.iterate.com/test/imported"),
    ];

    log.replaceAll(imported, 12, transactionRunner(db));

    expect(offsets(read(log, { afterOffset: 0, limit: 20, includeEphemeral: true }))).toEqual([
      1, 9,
    ]);
    expect(log.highestAssignedOffset()).toBe(12);
    expect(() => log.insert([event(9, "events.iterate.com/test/collision")])).toThrow();
    log.insert([event(13, "events.iterate.com/test/next")]);
    expect(log.highestAssignedOffset()).toBe(13);
  });
});

function fromNodeSqlValue([key, value]: [string, unknown]) {
  if (value instanceof Uint8Array) {
    return [key, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)];
  }
  return [key, value];
}

describe("reconcileSubscriptionCursorRows", () => {
  it("drops orphans, clears unclaimed failures, and preserves exact retry claims", () => {
    const db = new DatabaseSync(":memory:");
    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    store.ensure("survivor-clean", 5);
    const unclaimed = store.ensure("survivor-unclaimed-failure", 4);
    store.nack("survivor-unclaimed-failure", {
      attempt: 2,
      nextAttemptAt: 77_777,
      error: "obsolete failure",
      epoch: unclaimed.epoch,
    });
    const survivor = store.ensure("survivor-backing-off", 3);
    store.claimPushFrame("survivor-backing-off", 8, 10, 40_000, survivor.epoch);
    store.nack("survivor-backing-off", {
      attempt: 7,
      nextAttemptAt: 99_999,
      error: "old-code bug",
      epoch: survivor.epoch,
    });
    store.claimPushFrame("survivor-clean", 8, 10, 50_000, store.get("survivor-clean")!.epoch);
    const orphan = store.ensure("orphan", 2);
    store.nack("orphan", {
      attempt: 14,
      nextAttemptAt: 88_888,
      error: "config no longer folds",
      epoch: orphan.epoch,
    });

    reconcileSubscriptionCursorRows(
      store,
      new Set(["survivor-clean", "survivor-unclaimed-failure", "survivor-backing-off"]),
    );

    // The orphan is gone entirely — its next_attempt_at must not arm alarms forever.
    expect(store.get("orphan")).toBeUndefined();
    expect(store.minNextAttemptAt()).toBe(50_000);
    // Progress survives (ackedOffset is monotonic truth about the same log)...
    expect(store.get("survivor-clean")?.ackedOffset).toBe(5);
    expect(store.get("survivor-unclaimed-failure")?.ackedOffset).toBe(4);
    expect(store.get("survivor-backing-off")?.ackedOffset).toBe(3);
    // ...and an unclaimed failure gets a fresh try under the rebuilt fold.
    expect(store.get("survivor-unclaimed-failure")).toMatchObject({
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
    });
    expect(store.get("survivor-clean")).toMatchObject({
      pendingThroughOffset: 8,
      pendingStreamMaxOffset: 10,
      pendingAttempt: 1,
      pendingRecoveryAt: 50_000,
    });
    expect(store.get("survivor-backing-off")).toMatchObject({
      attempt: 7,
      nextAttemptAt: 99_999,
      lastError: "old-code bug",
      pendingThroughOffset: 8,
      pendingStreamMaxOffset: 10,
      pendingAttempt: 1,
      pendingRecoveryAt: null,
    });
    const reloaded = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    expect(reloaded.get("survivor-clean")).toEqual(store.get("survivor-clean"));
    expect(reloaded.get("survivor-backing-off")).toEqual(store.get("survivor-backing-off"));
  });
});

describe("SqliteSubscriptionCursorStore schema", () => {
  it("creates only the current subscription schema on a fresh database", () => {
    const db = new DatabaseSync(":memory:");
    const statements: string[] = [];

    new SqliteSubscriptionCursorStore(
      wrapSqlStorage(db, (statement) => statements.push(statement)),
    );

    expect(statements.some((statement) => statement.includes("alter table"))).toBe(false);
    expect(
      db
        .prepare("select name from pragma_table_info('subscriptions') order by cid")
        .all()
        .map((column) => column.name),
    ).toEqual([
      "subscription_key",
      "acked_offset",
      "attempt",
      "next_attempt_at",
      "last_error",
      "epoch",
      "pending_through_offset",
      "pending_stream_max_offset",
      "pending_attempt",
      "pending_recovery_at",
    ]);
    expect(db.prepare("select version from stream_storage_schema").get()).toEqual({
      version: 8,
    });
    db.exec("insert into subscriptions (subscription_key, acked_offset, epoch) values ('k', 0, 1)");
    expect(() =>
      db.exec("update subscriptions set pending_through_offset = 1 where subscription_key = 'k'"),
    ).toThrow();
    expect(() =>
      db.exec(
        "update subscriptions set pending_through_offset = 2, pending_stream_max_offset = 1, pending_attempt = 1 where subscription_key = 'k'",
      ),
    ).toThrow();
    expect(() =>
      db.exec("update subscriptions set pending_recovery_at = 1 where subscription_key = 'k'"),
    ).toThrow();
  });

  it("is idempotent on an already-current table", () => {
    const db = new DatabaseSync(":memory:");
    const first = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    first.ensure("k", 3);
    const again = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    expect(again.get("k")).toMatchObject({ ackedOffset: 3 });
    expect(again.get("k")!.epoch).toBeGreaterThan(0);
  });

  it("checks the current stream schema once when the cursor store initializes first", () => {
    const db = new DatabaseSync(":memory:");
    new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    let sqlCalls = 0;
    const activationSql = wrapSqlStorage(db, () => {
      sqlCalls += 1;
    });

    new SqliteSubscriptionCursorStore(activationSql);
    new StreamEventLog(activationSql, "/tests/stream");

    expect(sqlCalls).toBe(1);
  });

  it("rejects any subscription schema other than the exact current version", () => {
    const db = new DatabaseSync(":memory:");
    const sql = wrapSqlStorage(db);
    new SqliteSubscriptionCursorStore(sql);
    db.exec("update stream_storage_schema set version = 6 where singleton = 1");

    expect(() => new SqliteSubscriptionCursorStore(wrapSqlStorage(db))).toThrow(
      "Unsupported stream storage schema version: 6",
    );
  });
});

describe("SqliteSubscriptionCursorStore epoch fencing", () => {
  function makeStore() {
    return new SqliteSubscriptionCursorStore(wrapSqlStorage(new DatabaseSync(":memory:")));
  }

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

    store.skip("k", 100, before.epoch);
    expect(store.get("k")!.ackedOffset).toBe(5);

    store.stageAck("k", 100, before.epoch);
    expect(store.get("k")!.ackedOffset).toBe(5);
  });

  it("batches contiguous cursor sets at the SQL binding limit with exact last-seek state", () => {
    const db = new DatabaseSync(":memory:");
    const cursorSetBindings: number[] = [];
    const store = new SqliteSubscriptionCursorStore(
      wrapSqlStorage(db, (statement, bindings) => {
        if (statement.includes("with cursor_updates")) cursorSetBindings.push(bindings.length);
      }),
    );
    for (let index = 0; index < 100; index += 1) store.ensure(`k-${index}`, 0);
    store.claimPushFrame("k-0", 10, 10, 100, store.get("k-0")!.epoch);
    store.claimPushFrame("k-99", 10, 10, 100, store.get("k-99")!.epoch);
    const stagedEpoch = store.get("k-50")!.epoch;
    store.stageAck("k-50", 500, stagedEpoch);

    store.setCursors([
      ...Array.from({ length: 100 }, (_, index) => ({
        subscriptionKey: `k-${index}`,
        ackedOffset: index + 1,
      })),
      { subscriptionKey: "missing", ackedOffset: 1_000 },
      { subscriptionKey: "k-0", ackedOffset: 999 },
    ]);
    store.flushPending("all");

    expect(cursorSetBindings).toEqual([99, 99, 99, 3]);
    expect(store.get("k-0")).toMatchObject({ ackedOffset: 999, attempt: 0 });
    expect(store.get("k-50")).toMatchObject({ ackedOffset: 51, attempt: 0 });
    expect(store.get("k-0")?.pendingThroughOffset).toBeNull();
    expect(store.get("k-99")?.pendingThroughOffset).toBeNull();
    expect(store.get("k-0")!.epoch).toBeGreaterThan(store.get("k-99")!.epoch);
    expect(store.get("missing")).toBeUndefined();

    const reloaded = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    expect(reloaded.get("k-0")).toEqual(store.get("k-0"));
    expect(reloaded.get("k-50")).toEqual(store.get("k-50"));
  });

  it("keeps a singleton cursor set on the cached one-row update", () => {
    const db = new DatabaseSync(":memory:");
    const statements: string[] = [];
    const store = new SqliteSubscriptionCursorStore(
      wrapSqlStorage(db, (statement) => statements.push(statement)),
    );
    store.ensure("k", 0);
    store.claimPushFrame("k", 5, 5, 100, store.get("k")!.epoch);
    statements.length = 0;

    store.setCursors([{ subscriptionKey: "k", ackedOffset: 7 }]);

    expect(store.get("k")?.ackedOffset).toBe(7);
    expect(store.get("k")?.pendingThroughOffset).toBeNull();
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain("with cursor_updates");
  });

  it("persists monotonic fenced and unfenced acknowledgements", () => {
    const db = new DatabaseSync(":memory:");
    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    const fenced = store.ensure("fenced", 0);
    store.ensure("unfenced", 0);

    store.ack("fenced", 10, fenced.epoch);
    store.ack("fenced", 5, fenced.epoch);
    store.ack("unfenced", 10);
    store.ack("unfenced", 5);

    const reloaded = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    expect(reloaded.get("fenced")!.ackedOffset).toBe(10);
    expect(reloaded.get("unfenced")!.ackedOffset).toBe(10);
  });

  it("persists an exact push frame and advances its attempt across retries", () => {
    const db = new DatabaseSync(":memory:");
    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    const epoch = store.ensure("k", 0).epoch;

    expect(store.claimPushFrame("k", 5, 9, 50, epoch)).toEqual({
      streamMaxOffset: 9,
      attempt: 1,
    });
    store.nack("k", {
      attempt: 1,
      nextAttemptAt: 100,
      error: "receiver down",
      epoch,
    });

    let claimWrites = 0;
    const reloaded = new SqliteSubscriptionCursorStore(
      wrapSqlStorage(db, (statement) => {
        if (
          statement.includes("pending_through_offset =") &&
          !statement.includes("with progress(subscription_key")
        ) {
          claimWrites += 1;
        }
      }),
    );
    expect(reloaded.get("k")).toMatchObject({
      ackedOffset: 0,
      attempt: 1,
      nextAttemptAt: 100,
      pendingThroughOffset: 5,
      pendingStreamMaxOffset: 9,
      pendingAttempt: 1,
      pendingRecoveryAt: null,
    });
    claimWrites = 0;
    expect(reloaded.claimPushFrame("k", 5, 20, 200, epoch)).toEqual({
      streamMaxOffset: 9,
      attempt: 2,
    });
    expect(claimWrites).toBe(1);
    expect(reloaded.claimPushFrame("k", 2, 20, 300, epoch)).toEqual({
      streamMaxOffset: 20,
      attempt: 1,
    });
    expect(claimWrites).toBe(2);
    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")).toMatchObject({
      ackedOffset: 0,
      attempt: 1,
      pendingThroughOffset: 2,
      pendingStreamMaxOffset: 20,
      pendingAttempt: 1,
      pendingRecoveryAt: 300,
    });
  });

  it("checkpoints the prior push ack atomically with the next frame claim", () => {
    const db = new DatabaseSync(":memory:");
    let claimWrites = 0;
    let progressWrites = 0;
    const store = new SqliteSubscriptionCursorStore(
      wrapSqlStorage(db, (statement) => {
        if (
          statement.includes("pending_through_offset =") &&
          !statement.includes("with progress(subscription_key")
        ) {
          claimWrites += 1;
        }
        if (statement.includes("with progress(subscription_key")) progressWrites += 1;
      }),
    );
    const epoch = store.ensure("k", 0).epoch;

    store.claimPushFrame("k", 10, 10, 100, epoch);
    store.stageAck("k", 10, epoch);
    expect({ claimWrites, progressWrites }).toEqual({ claimWrites: 1, progressWrites: 0 });
    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")).toMatchObject({
      ackedOffset: 0,
      pendingThroughOffset: 10,
      pendingStreamMaxOffset: 10,
      pendingAttempt: 1,
      pendingRecoveryAt: 100,
    });

    store.claimPushFrame("k", 20, 20, 200, epoch);
    expect({ claimWrites, progressWrites }).toEqual({ claimWrites: 2, progressWrites: 0 });
    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")).toMatchObject({
      ackedOffset: 10,
      pendingThroughOffset: 20,
      pendingStreamMaxOffset: 20,
      pendingAttempt: 1,
      pendingRecoveryAt: 200,
    });

    store.stageAck("k", 20, epoch);
    store.flushPending("all");
    expect({ claimWrites, progressWrites }).toEqual({ claimWrites: 2, progressWrites: 1 });
    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")).toMatchObject({
      ackedOffset: 20,
      pendingThroughOffset: null,
      pendingStreamMaxOffset: null,
      pendingAttempt: null,
      pendingRecoveryAt: null,
    });
  });

  it("fences push claims and clears them on explicit acknowledgement", () => {
    const db = new DatabaseSync(":memory:");
    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    const epoch = store.ensure("k", 3).epoch;

    expect(store.claimPushFrame("k", 5, 7, 100, epoch - 1)).toBeUndefined();
    expect(store.claimPushFrame("k", 5, 7, 100, epoch)).toEqual({
      streamMaxOffset: 7,
      attempt: 1,
    });
    store.ack("k", 3, epoch);

    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")).toMatchObject({
      ackedOffset: 3,
      pendingThroughOffset: null,
      pendingStreamMaxOffset: null,
      pendingAttempt: null,
      pendingRecoveryAt: null,
    });
  });

  it("elides only acknowledgements that cannot change durable cursor state", () => {
    const db = new DatabaseSync(":memory:");
    let writes = 0;
    const store = new SqliteSubscriptionCursorStore(
      wrapSqlStorage(db, (statement) => {
        if (statement.trimStart().startsWith("update subscriptions")) writes += 1;
      }),
    );
    const row = store.ensure("k", 3);
    writes = 0;

    store.ack("k", 3, row.epoch);
    store.ack("k", 2);
    store.advanceWatermark("k", 3, row.epoch);
    expect(writes).toBe(0);

    store.nack("k", { attempt: 1, nextAttemptAt: 10, error: "retry", epoch: row.epoch });
    writes = 0;
    store.ack("k", 3, row.epoch);
    expect(writes).toBe(1);
    expect(store.get("k")).toMatchObject({
      ackedOffset: 3,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
    });
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

  it("rejects a stale delivery nack after a seek or remove+recreate", () => {
    const store = makeStore();
    const oldEpoch = store.ensure("k", 0).epoch;

    store.setCursor("k", 2);
    store.nack("k", {
      attempt: 4,
      nextAttemptAt: 123,
      error: "old target failed",
      epoch: oldEpoch,
    });
    expect(store.get("k")).toMatchObject({
      ackedOffset: 2,
      attempt: 0,
      nextAttemptAt: null,
    });

    const seekEpoch = store.get("k")!.epoch;
    store.delete("k");
    store.ensure("k", 0);
    store.nack("k", {
      attempt: 4,
      nextAttemptAt: 123,
      error: "removed target failed",
      epoch: seekEpoch,
    });
    expect(store.get("k")).toMatchObject({
      ackedOffset: 0,
      attempt: 0,
      nextAttemptAt: null,
    });
  });

  it("advanceWatermark keeps the failure streak but clears the retry schedule", () => {
    const store = makeStore();
    const ensured = store.ensure("k", 0);
    store.nack("k", {
      attempt: 3,
      nextAttemptAt: 12345,
      error: "ingest failing",
      epoch: ensured.epoch,
    });

    store.advanceWatermark("k", 7, ensured.epoch);
    const row = store.get("k")!;
    expect(row.ackedOffset).toBe(7);
    expect(row.attempt).toBe(3); // a reachable host is not a healthy one
    expect(row.lastError).toBe("ingest failing");
    expect(row.nextAttemptAt).toBeNull(); // the poke consumed the retry
  });

  it("rejects an observational watermark fenced on a stale epoch", () => {
    const store = makeStore();
    const oldEpoch = store.ensure("k", 0).epoch;
    store.setCursor("k", 2);

    store.advanceWatermark("k", 100, oldEpoch);

    expect(store.get("k")!.ackedOffset).toBe(2);
  });

  it("serves cursor reads and repeated ensures from its write-through cache", () => {
    const db = new DatabaseSync(":memory:");
    let sqlCalls = 0;
    const store = new SqliteSubscriptionCursorStore(
      wrapSqlStorage(db, () => {
        sqlCalls += 1;
      }),
    );
    sqlCalls = 0;

    const ensured = store.ensure("k", 2);
    const callsAfterInsert = sqlCalls;
    ensured.ackedOffset = 998;
    const returned = store.get("k")!;
    returned.ackedOffset = 999;
    store.get("k");
    store.list();
    store.minNextAttemptAt();
    store.ensure("k", 0);

    expect(callsAfterInsert).toBeGreaterThan(0);
    expect(sqlCalls).toBe(callsAfterInsert);
    expect(store.get("k")!.ackedOffset).toBe(2);

    store.nack("k", { attempt: 3, nextAttemptAt: 123, error: "retry", epoch: ensured.epoch });
    expect(sqlCalls).toBeGreaterThan(callsAfterInsert);
    const callsAfterWrite = sqlCalls;
    expect(store.get("k")).toMatchObject({ attempt: 3, nextAttemptAt: 123 });
    expect(store.minNextAttemptAt()).toBe(123);
    expect(sqlCalls).toBe(callsAfterWrite);

    const reloaded = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    expect(reloaded.get("k")).toMatchObject({
      ackedOffset: 2,
      attempt: 3,
      nextAttemptAt: 123,
      lastError: "retry",
    });
  });

  it("reconciles existing cursor rows with one cold query and no warm queries", () => {
    const db = new DatabaseSync(":memory:");
    const seed = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    for (let index = 0; index < 100; index += 1) seed.ensure(`k-${index}`, index);

    let sqlCalls = 0;
    const store = new SqliteSubscriptionCursorStore(
      wrapSqlStorage(db, () => {
        sqlCalls += 1;
      }),
    );
    sqlCalls = 0;

    for (let index = 0; index < 100; index += 1) {
      store.ensure(`k-${index}`, 0);
      expect(store.get(`k-${index}`)?.ackedOffset).toBe(index);
    }
    expect(sqlCalls).toBe(1);

    for (let index = 0; index < 100; index += 1) {
      store.ensure(`k-${index}`, 0);
      store.get(`k-${index}`);
    }
    expect(sqlCalls).toBe(1);
  });

  it("batches bounded skip-only cursor checkpoints under the SQL binding limit", () => {
    const db = new DatabaseSync(":memory:");
    const skippedUpdateBindings: number[] = [];
    const store = new SqliteSubscriptionCursorStore(
      wrapSqlStorage(db, (statement, bindings) => {
        if (statement.includes("with progress(subscription_key")) {
          skippedUpdateBindings.push(bindings.length);
        }
      }),
    );
    for (let index = 0; index < 100; index += 1) store.ensure(`k-${index}`, 0);
    const epochs = Array.from({ length: 100 }, (_, index) => store.get(`k-${index}`)!.epoch);
    skippedUpdateBindings.length = 0;

    for (let offset = 1; offset < 64; offset += 1) {
      for (let index = 0; index < 100; index += 1) {
        store.skip(`k-${index}`, offset, epochs[index]!);
      }
      store.flushPending();
    }
    expect(skippedUpdateBindings).toEqual([]);
    expect(store.get("k-0")!.ackedOffset).toBe(63);

    for (let index = 0; index < 100; index += 1) {
      store.skip(`k-${index}`, 64, epochs[index]!);
    }
    store.flushPending();

    // 33 rows * 3 bindings = 99, below Cloudflare's 100-binding maximum.
    expect(skippedUpdateBindings).toEqual([99, 99, 99, 3]);
    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k-99")!.ackedOffset).toBe(64);
  });

  it("force-flushes a quiet stream's sub-threshold skip checkpoint", () => {
    const db = new DatabaseSync(":memory:");
    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    store.ensure("k", 0);
    store.skip("k", 1, store.get("k")!.epoch);
    store.flushPending();

    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")!.ackedOffset).toBe(0);

    store.flushPending("all");
    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")!.ackedOffset).toBe(1);
  });

  it("does not flush quiet progress after the only due row is deleted", () => {
    const db = new DatabaseSync(":memory:");
    let progressWrites = 0;
    const store = new SqliteSubscriptionCursorStore(
      wrapSqlStorage(db, (statement) => {
        if (statement.includes("with progress(subscription_key")) progressWrites += 1;
      }),
    );
    store.ensure("due", 0);
    store.ensure("quiet", 0);
    store.skip("due", 64, store.get("due")!.epoch);
    store.skip("quiet", 1, store.get("quiet")!.epoch);

    store.delete("due");
    store.flushPending();

    expect(progressWrites).toBe(0);
    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("quiet")!.ackedOffset).toBe(0);
    store.flushPending("all");
    expect(progressWrites).toBe(1);
  });

  it("holds a quiet successful push tail until an explicit lifecycle flush", () => {
    const db = new DatabaseSync(":memory:");
    let progressWrites = 0;
    const store = new SqliteSubscriptionCursorStore(
      wrapSqlStorage(db, (statement) => {
        if (statement.includes("with progress(subscription_key")) progressWrites += 1;
      }),
    );
    const epoch = store.ensure("k", 0).epoch;

    store.stageAck("k", 1_000, epoch);
    // wake() offers this due-only flush after every separate drain; delivered
    // progress is instead checkpointed by the next claim or recovery alarm.
    store.flushPending();
    expect(progressWrites).toBe(0);
    expect(store.get("k")!.ackedOffset).toBe(1_000);
    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")!.ackedOffset).toBe(0);

    store.flushPending("all");
    expect(progressWrites).toBe(1);
    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")!.ackedOffset).toBe(1_000);
  });

  it("keeps skip and delivery checkpoint bounds independent in a mixed run", () => {
    const db = new DatabaseSync(":memory:");
    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    const epoch = store.ensure("k", 0).epoch;
    store.stageAck("k", 100, epoch);
    for (let offset = 101; offset < 164; offset += 1) store.skip("k", offset, epoch);
    store.flushPending();

    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")!.ackedOffset).toBe(0);
    store.skip("k", 164, epoch);
    store.flushPending();
    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")!.ackedOffset).toBe(164);
  });

  it("resolves staged push progress before failure and lets a seek supersede it", () => {
    const db = new DatabaseSync(":memory:");
    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    let epoch = store.ensure("k", 0).epoch;
    store.stageAck("k", 100, epoch);
    store.nack("k", { attempt: 1, nextAttemptAt: 10, error: "retry", epoch });
    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")).toMatchObject({
      ackedOffset: 100,
      attempt: 1,
    });

    store.setCursor("k", 2);
    epoch = store.get("k")!.epoch;
    store.stageAck("k", 200, epoch);
    store.setCursor("k", 3);
    store.flushPending("all");
    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")).toMatchObject({
      ackedOffset: 3,
      attempt: 0,
    });
  });

  it("retains uncommitted skip progress when a later checkpoint batch fails", () => {
    const db = new DatabaseSync(":memory:");
    let checkpointCalls = 0;
    let failSecondCheckpoint = false;
    const store = new SqliteSubscriptionCursorStore(
      wrapSqlStorage(db, (statement) => {
        if (!statement.includes("with progress(subscription_key")) return;
        checkpointCalls += 1;
        if (!failSecondCheckpoint || checkpointCalls !== 2) return;
        failSecondCheckpoint = false;
        throw new Error("injected checkpoint failure");
      }),
    );
    for (let index = 0; index < 100; index += 1) store.ensure(`k-${index}`, 0);
    const epochs = Array.from({ length: 100 }, (_, index) => store.get(`k-${index}`)!.epoch);
    for (let index = 0; index < 100; index += 1) {
      store.skip(`k-${index}`, 64, epochs[index]!);
    }

    checkpointCalls = 0;
    failSecondCheckpoint = true;
    expect(() => store.flushPending()).toThrow("injected checkpoint failure");
    const partiallyReloaded = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    expect(partiallyReloaded.get("k-32")!.ackedOffset).toBe(64);
    expect(partiallyReloaded.get("k-33")!.ackedOffset).toBe(0);

    store.flushPending();
    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k-99")!.ackedOffset).toBe(64);
  });

  it("lets an immediate delivery ack subsume pending skip progress", () => {
    const db = new DatabaseSync(":memory:");
    let progressUpdates = 0;
    const store = new SqliteSubscriptionCursorStore(
      wrapSqlStorage(db, (statement) => {
        if (statement.includes("with progress(subscription_key")) progressUpdates += 1;
      }),
    );
    store.ensure("k", 0);
    const epoch = store.get("k")!.epoch;
    store.skip("k", 1, epoch);

    store.ack("k", 2, epoch);
    store.flushPending("all");

    expect(progressUpdates).toBe(0);
    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")!.ackedOffset).toBe(2);
  });

  it("persists a skip immediately when it consumes an existing backoff", () => {
    const db = new DatabaseSync(":memory:");
    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    const ensured = store.ensure("k", 0);
    store.claimPushFrame("k", 1, 1, 100, ensured.epoch);
    store.nack("k", {
      attempt: 2,
      nextAttemptAt: 1,
      error: "receiver was down",
      epoch: ensured.epoch,
    });

    store.skip("k", 1, store.get("k")!.epoch);

    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")).toMatchObject({
      ackedOffset: 1,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
      pendingThroughOffset: null,
      pendingStreamMaxOffset: null,
      pendingAttempt: null,
      pendingRecoveryAt: null,
    });
  });
});
