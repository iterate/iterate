import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../../types.ts";
import { StreamEventLog } from "./stream-storage.ts";

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
  };
}

function createLog() {
  const log = new StreamEventLog(wrapSqlStorage(new DatabaseSync(":memory:")));
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
});

function fromNodeSqlValue([key, value]: [string, unknown]) {
  if (value instanceof Uint8Array) {
    return [key, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)];
  }
  return [key, value];
}
