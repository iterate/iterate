import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { StreamEvent } from "./schemas.ts";
import {
  reconcileSubscriptionCursorRows,
  SqliteSubscriptionCursorStore,
  StreamEventLog,
} from "./stream-storage.ts";

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
      const isRangeQuery = sql.includes("from events") && sql.includes("order by offset asc");
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
          if (isRangeQuery && rangeCursor?.forbidToArray === true) {
            throw new Error("range query used named-object materialization");
          }
          return rows as T[];
        },
        raw: <U extends SqlStorageValue[]>() => {
          if (isRangeQuery) rangeCursor?.onRaw();
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

    expect(statements).toEqual(["select version from stream_storage_schema where singleton = 1"]);
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

  it("handles wildcard and empty event type filters", () => {
    const log = createLog();

    expect(offsets(read(log, { afterOffset: 0, eventTypes: ["*"], limit: 3 }))).toEqual([1, 2, 3]);
    expect(read(log, { afterOffset: 0, eventTypes: [], limit: 3 })).toEqual([]);
  });

  it("insert reports serialized byte lengths and getRangeSized reads the same sizes back", () => {
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

    expect(inserts.map(({ bindings }) => bindings.length)).toEqual([5]);
    expect(inserts.every(({ statement }) => !statement.includes("), ("))).toBe(true);
    expect(inserts[0]?.bindings[4]).toBeInstanceOf(ArrayBuffer);
    expect(db.prepare("select typeof(event_json) as type from events").get()).toEqual({
      type: "blob",
    });
    expect(db.prepare("select count(*) as count from event_chunks").get()).toEqual({ count: 0 });
    expect(inserted).toEqual([
      {
        event: committed,
        byteLength: new TextEncoder().encode(JSON.stringify(committed)).byteLength,
      },
    ]);
    expect(log.getByOffset(1)).toEqual(committed);
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
      Array.from({ length: 21 }, (_, index) => event(index + 4, "large-batch")),
      transactionRunner,
    );
    expect(transactions).toBe(1);

    log.insert(
      [{ ...event(25, "large"), payload: { text: "x".repeat(600 * 1024) } }],
      transactionRunner,
    );
    expect(transactions).toBe(2);
    expect(offsets(read(log, { afterOffset: 0, limit: 25 }))).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
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
        [{ ...event(1, "large"), payload: { text: "x".repeat(600 * 1024) } }],
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
  });

  it("batches inserts within Durable Object SQL's 100-binding limit", () => {
    const inserts: Array<{ sql: string; bindings: number }> = [];
    const sql = wrapSqlStorage(new DatabaseSync(":memory:"), (statement, bindings) => {
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
    expect(eventInserts).toHaveLength(5);
    expect(chunkInserts).toHaveLength(0);
    expect(inserts.every((insert) => insert.bindings <= 100)).toBe(true);
    expect(offsets(read(log, { afterOffset: 0, limit: 100 }))).toEqual(
      committedEvents.map((entry) => entry.offset),
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
        return "x".repeat(600 * 1024);
      },
    });
    const committed = { ...event(1, "events.iterate.com/test/large-single"), payload };

    log.insert([committed]);

    expect(payloadReads).toBe(1);
    expect(db.prepare("select count(*) as count from event_chunks").get()).toEqual({ count: 2 });
    expect(log.getByOffset(1)).toEqual({
      ...committed,
      payload: { text: "x".repeat(600 * 1024) },
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
    expect([...hits.keys()]).toEqual(committedEvents.map((entry) => entry.idempotencyKey));
    expect([...hits.values()]).toEqual(committedEvents);
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
        payload: { text: "x".repeat(600 * 1024) },
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
    expect(log.getRangeSized({ afterOffset: 0, beforeOffset: 4, limit: 3 })).toEqual(inserted);
    expect([...log.getByIdempotencyKeys(["small-3", "large-2", "small-1"]).values()]).toEqual(
      committedEvents,
    );
  });

  it("chunks by UTF-8 bytes when character length remains below the threshold", () => {
    const db = new DatabaseSync(":memory:");
    const log = new StreamEventLog(wrapSqlStorage(db), "/tests/stream");
    const large = {
      ...event(1, "events.iterate.com/test/multibyte-large"),
      payload: { text: "é".repeat(300 * 1024) },
    };

    const [sized] = log.insert([large]);

    expect(db.prepare("select count(*) as count from event_chunks where offset = 1").get()).toEqual(
      { count: 2 },
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
        payload: { text: "x".repeat(600 * 1024) },
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
    ).toEqual(["offset", "type", "idempotency_key", "ephemeral", "event_json"]);
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
    ).toEqual({ version: 5, floor: 0 });
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
        if (statement.includes("with event_bounds as")) boundsQueries += 1;
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
        payload: { text: "x".repeat(600 * 1024) },
      },
    ]);
    expect(db.prepare("select count(*) as count from event_chunks").get()).toEqual({ count: 2 });
    failDelete = true;

    expect(() => log.evictEphemeralThrough(2, transactionRunner(db))).toThrow(
      "injected deletion failure",
    );
    expect(db.prepare("select offset from events order by offset").all()).toEqual([
      { offset: 1 },
      { offset: 2 },
    ]);
    expect(db.prepare("select count(*) as count from event_chunks").get()).toEqual({ count: 2 });
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
    ]);
    expect(db.prepare("select version from stream_storage_schema").get()).toEqual({
      version: 5,
    });
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
    db.exec("update stream_storage_schema set version = 4 where singleton = 1");

    expect(() => new SqliteSubscriptionCursorStore(wrapSqlStorage(db))).toThrow(
      "Unsupported stream storage schema version: 4",
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
    store.advanceWatermark("k", 3);
    expect(writes).toBe(0);

    store.nack("k", { attempt: 1, nextAttemptAt: 10, error: "retry" });
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

    store.nack("k", { attempt: 3, nextAttemptAt: 123, error: "retry" });
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
        if (statement.includes("with skipped(subscription_key")) {
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
      store.flushSkipped();
    }
    expect(skippedUpdateBindings).toEqual([]);
    expect(store.get("k-0")!.ackedOffset).toBe(63);

    for (let index = 0; index < 100; index += 1) {
      store.skip(`k-${index}`, 64, epochs[index]!);
    }
    store.flushSkipped();

    // 33 rows * 3 bindings = 99, below Cloudflare's 100-binding maximum.
    expect(skippedUpdateBindings).toEqual([99, 99, 99, 3]);
    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k-99")!.ackedOffset).toBe(64);
  });

  it("force-flushes a quiet stream's sub-threshold skip checkpoint", () => {
    const db = new DatabaseSync(":memory:");
    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    store.ensure("k", 0);
    store.skip("k", 1, store.get("k")!.epoch);
    store.flushSkipped();

    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")!.ackedOffset).toBe(0);

    store.flushSkipped(true);
    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")!.ackedOffset).toBe(1);
  });

  it("retains uncommitted skip progress when a later checkpoint batch fails", () => {
    const db = new DatabaseSync(":memory:");
    let checkpointCalls = 0;
    let failSecondCheckpoint = false;
    const store = new SqliteSubscriptionCursorStore(
      wrapSqlStorage(db, (statement) => {
        if (!statement.includes("with skipped(subscription_key")) return;
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
    expect(() => store.flushSkipped()).toThrow("injected checkpoint failure");
    const partiallyReloaded = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    expect(partiallyReloaded.get("k-32")!.ackedOffset).toBe(64);
    expect(partiallyReloaded.get("k-33")!.ackedOffset).toBe(0);

    store.flushSkipped();
    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k-99")!.ackedOffset).toBe(64);
  });

  it("lets an immediate delivery ack subsume pending skip progress", () => {
    const db = new DatabaseSync(":memory:");
    let skippedUpdates = 0;
    const store = new SqliteSubscriptionCursorStore(
      wrapSqlStorage(db, (statement) => {
        if (statement.includes("with skipped(subscription_key")) skippedUpdates += 1;
      }),
    );
    store.ensure("k", 0);
    const epoch = store.get("k")!.epoch;
    store.skip("k", 1, epoch);

    store.ack("k", 2, epoch);
    store.flushSkipped(true);

    expect(skippedUpdates).toBe(0);
    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")!.ackedOffset).toBe(2);
  });

  it("persists a skip immediately when it consumes an existing backoff", () => {
    const db = new DatabaseSync(":memory:");
    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(db));
    store.ensure("k", 0);
    store.nack("k", { attempt: 2, nextAttemptAt: 1, error: "receiver was down" });

    store.skip("k", 1, store.get("k")!.epoch);

    expect(new SqliteSubscriptionCursorStore(wrapSqlStorage(db)).get("k")).toMatchObject({
      ackedOffset: 1,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
    });
  });
});
