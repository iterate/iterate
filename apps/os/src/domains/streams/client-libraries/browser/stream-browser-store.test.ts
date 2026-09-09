import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "iterate/processors";
import { compileEventFilter } from "../../event-filter.ts";
import { acquireDatabase } from "./stream-database-registry.ts";
import { acquireStreamRuntime, type StreamBrowserStore } from "./stream-browser-store.ts";
import type { StreamBrowserDatabase, SqlValue } from "./stream-browser-db.ts";
import type { BrowserStreamClient } from "./stream-transport.ts";

vi.mock("./stream-database-registry.ts", () => ({ acquireDatabase: vi.fn() }));

const stores: StreamBrowserStore[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store[Symbol.dispose]();
  // Disposal waits for the synchronization task before releasing SQLite.
  await vi.waitFor(() => {
    for (const result of vi.mocked(acquireDatabase).mock.results) {
      if (result.type === "return") expect(result.value.release).toHaveBeenCalled();
    }
  });
  databases.splice(0).forEach((db) => db.close());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(events: StreamEvent[]) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const changes = new Set<Parameters<StreamBrowserDatabase["onChange"]>[0]>();
  const release = vi.fn();
  let holdWrites: Promise<void> | undefined;
  const writing = vi.fn();
  const database = {
    databasePath: `test/${crypto.randomUUID()}.sqlite3`,
    exec: async (statement: string, params: SqlValue[] = []) =>
      // Tests use only scalar SQLite bindings.
      db.prepare(statement).all(...(params as Exclude<SqlValue, number[]>[])),
    batch: async (
      statements: { sql: string; params?: SqlValue[] }[],
      options?: { transaction?: boolean },
    ) => {
      if (
        holdWrites &&
        statements.some(({ sql }) => sql.includes("INSERT INTO events(local_index"))
      ) {
        writing();
        await holdWrites;
      }
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
    onChange(listener: Parameters<StreamBrowserDatabase["onChange"]>[0]) {
      changes.add(listener);
      return () => changes.delete(listener);
    },
    notifyChanged(change: Parameters<StreamBrowserDatabase["notifyChanged"]>[0]) {
      for (const listener of changes)
        listener(change ?? { kind: "append", minOffset: 0, maxOffset: 0 });
    },
    info: vi.fn().mockResolvedValue({}),
  };
  // The runtime uses only this SQL/change surface; query rendering is tested separately.
  vi.mocked(acquireDatabase).mockReturnValue({
    db: database as unknown as StreamBrowserDatabase,
    release,
  });
  vi.stubGlobal("navigator", {
    locks: {
      request: async (_name: string, _options: unknown, callback: () => Promise<void>) =>
        callback(),
    },
  });
  let callback:
    | Parameters<BrowserStreamClient["openConnection"]>[0]["processEventBatch"]
    | undefined;
  const getEventPage = vi.fn(
    async (input: Parameters<BrowserStreamClient["getEventPage"]>[0] = {}) => ({
      streamId: "stream-a",
      streamMaxOffset: events.at(-1)?.offset ?? 0,
      events: events
        .filter(
          (event) =>
            event.offset > (input.afterOffset ?? 0) &&
            event.offset < (input.beforeOffset ?? Infinity) &&
            (!event.ephemeral || input.includeEphemeral),
        )
        .slice(0, input.limit ?? 500),
    }),
  );
  const close = vi.fn();
  const openConnection = vi.fn(
    async (input: Parameters<BrowserStreamClient["openConnection"]>[0]) => {
      callback = input.processEventBatch;
      return {
        connectionKey: input.connectionKey,
        streamMaxOffset: events.at(-1)?.offset ?? 0,
        close,
        ping: () => true,
        [Symbol.dispose]() {},
      };
    },
  );
  // No domain methods are used by the copier; absent methods fail loudly if accessed.
  const client = {
    getEventPage,
    openConnection,
    [Symbol.dispose]() {},
  } as unknown as BrowserStreamClient;
  const store = acquireStreamRuntime({
    projectId: crypto.randomUUID(),
    streamPath: "/test",
    createStreamClient: async () => client,
    subscriberUser: { id: "user-a", email: "a@example.com" },
  });
  stores.push(store);
  store.subscribe(() => {});
  return {
    db,
    store,
    release,
    getEventPage,
    openConnection,
    close,
    writing,
    holdWrites: (work: Promise<void>) => {
      holdWrites = work;
    },
    resetFromAnotherTab: () => database.notifyChanged({ kind: "reset" }),
    deliver: async (event: StreamEvent) => {
      if (!callback) throw new Error("callback is not open");
      await callback({
        events: [event],
        projectId: null,
        path: "/test",
        streamId: "stream-a",
        scannedAfterOffset: event.offset - 1,
        scannedThroughOffset: event.offset,
        streamMaxOffset: event.offset,
        state: null,
      });
    },
  };
}

function event(offset: number, ephemeral = false): StreamEvent {
  return {
    offset,
    path: "/test",
    type: "test/event",
    payload: {},
    createdAt: new Date(0).toISOString(),
    ...(ephemeral && { ephemeral: true }),
  };
}

describe("browser durable event synchronization", () => {
  it("copies durable history and opens a durable-only callback with the initial user identity", async () => {
    const h = setup([event(1), event(2, true), event(3)]);
    await vi.waitFor(() => expect(h.store.getSnapshot().connectionStatus).toBe("receiving-events"));
    expect(h.db.prepare("SELECT offset FROM events ORDER BY offset").all()).toEqual([
      { offset: 1 },
      { offset: 3 },
    ]);
    const input = h.openConnection.mock.calls[0]![0];
    expect(input.openedBy).toMatchObject({ user: { id: "user-a" } });
    expect(compileEventFilter(input.filter).matches(event(4, true))).toBe(false);
    expect(compileEventFilter(input.filter).matches(event(4))).toBe(true);
    await h.deliver(event(4));
    expect(h.db.prepare("SELECT through_offset FROM stream_sync").get()).toEqual({
      through_offset: 4,
    });
  });

  it("keeps SQLite alive until an in-flight transaction finishes during disposal", async () => {
    const h = setup([event(1)]);
    await vi.waitFor(() => expect(h.store.getSnapshot().connectionStatus).toBe("receiving-events"));
    const held = deferred();
    h.holdWrites(held.promise);
    const delivery = h.deliver(event(2));
    await vi.waitFor(() => expect(h.writing).toHaveBeenCalled());
    h.store[Symbol.dispose]();
    expect(h.release).not.toHaveBeenCalled();
    held.resolve();
    await delivery;
    await vi.waitFor(() => expect(h.release).toHaveBeenCalledOnce());
    expect(h.db.prepare("SELECT offset FROM events ORDER BY offset").all()).toEqual([
      { offset: 1 },
      { offset: 2 },
    ]);
  });

  it("re-copies history after another tab resets the shared database", async () => {
    const h = setup([event(1)]);
    await vi.waitFor(() => expect(h.store.getSnapshot().connectionStatus).toBe("receiving-events"));
    h.db.exec(
      "DELETE FROM events; DELETE FROM event_type_counts; UPDATE stream_sync SET through_offset = 0, owner = 'reset'",
    );
    h.resetFromAnotherTab();
    await vi.waitFor(() => expect(h.openConnection).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(h.db.prepare("SELECT offset FROM events").all()).toEqual([{ offset: 1 }]);
  });
});
