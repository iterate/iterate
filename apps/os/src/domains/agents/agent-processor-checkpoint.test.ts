import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { StreamProcessorSnapshot } from "../streams/stream-processor.ts";
import { AgentProcessorCheckpointStore } from "./agent-processor-checkpoint.ts";
import { AgentProcessorContract, type AgentProcessorState } from "./agent-processor-contract.ts";

function wrapSqlStorage(
  db: DatabaseSync,
  onExec?: (sql: string, bindings: readonly SqlStorageValue[]) => void,
): SqlStorage {
  return {
    exec<T = unknown>(sql: string, ...bindings: (ArrayBuffer | null | number | string)[]) {
      onExec?.(sql, bindings);
      const statement = db.prepare(sql);
      const rows = statement
        .all(
          ...bindings.map((binding) =>
            binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
          ),
        )
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Uint8Array
                ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
                : value,
            ]),
          ),
        );
      return {
        toArray: () => rows as T[],
        [Symbol.iterator]: () => (rows as T[])[Symbol.iterator](),
      };
    },
  } as unknown as SqlStorage;
}

function storage(db: DatabaseSync, onExec?: Parameters<typeof wrapSqlStorage>[1]) {
  return {
    sql: wrapSqlStorage(db, onExec),
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

function checkpoint(
  offset: number,
  history: AgentProcessorState["history"],
): StreamProcessorSnapshot<AgentProcessorState> {
  return {
    offset,
    state: AgentProcessorContract.stateSchema.parse({ history }),
  };
}

function appendHistory(
  snapshot: StreamProcessorSnapshot<AgentProcessorState>,
  content: string,
): StreamProcessorSnapshot<AgentProcessorState> {
  return {
    offset: snapshot.offset + 1,
    state: {
      ...snapshot.state,
      history: [...snapshot.state.history, { role: "user", content }],
    },
  };
}

describe("AgentProcessorCheckpointStore", () => {
  it("round-trips append-only history and non-history state", () => {
    const db = new DatabaseSync(":memory:");
    const first = checkpoint(7, [{ role: "user", content: "first" }]);
    first.state.systemPrompt = "checkpoint prompt";
    const store = new AgentProcessorCheckpointStore(storage(db), AgentProcessorContract.version);

    expect(store.read()).toBeUndefined();
    store.write(first);
    const second = appendHistory(first, "second");
    second.state.autonomousTurnCount = 3;
    store.write(second);

    expect(
      new AgentProcessorCheckpointStore(storage(db), AgentProcessorContract.version).read(),
    ).toEqual(second);
  });

  it("seals bounded history chunks and garbage-collects the old generation on reset", () => {
    const db = new DatabaseSync(":memory:");
    const store = new AgentProcessorCheckpointStore(storage(db), AgentProcessorContract.version);
    store.read();
    const initial = checkpoint(1, [
      { role: "user", content: "a".repeat(100_000) },
      { role: "assistant", content: "b".repeat(100_000) },
      { role: "user", content: "c".repeat(100_000) },
    ]);
    store.write(initial);
    store.write(appendHistory(initial, "small tail append"));

    expect(
      Number(
        db.prepare("select count(*) as count from agent_processor_history_chunks_v1").get()!.count,
      ),
    ).toBeGreaterThan(0);

    const reset = checkpoint(3, [{ role: "user", content: "replacement" }]);
    store.write(reset);
    expect(
      db.prepare("select count(*) as count from agent_processor_history_chunks_v1").get(),
    ).toEqual({ count: 0 });
    expect(
      new AgentProcessorCheckpointStore(storage(db), AgentProcessorContract.version).read(),
    ).toEqual(reset);
  });

  it("rotates history when an earlier item changes even if the final old item is identical", () => {
    const db = new DatabaseSync(":memory:");
    const store = new AgentProcessorCheckpointStore(storage(db), AgentProcessorContract.version);
    store.read();
    const initial = checkpoint(1, [
      { role: "user", content: "first" },
      { role: "assistant", content: "stable final item" },
    ]);
    store.write(initial);
    const replacement: StreamProcessorSnapshot<AgentProcessorState> = {
      offset: 2,
      state: {
        ...initial.state,
        history: [{ role: "user", content: "replaced first item" }, initial.state.history[1]!],
      },
    };
    store.write(replacement);

    expect(
      new AgentProcessorCheckpointStore(storage(db), AgentProcessorContract.version).read(),
    ).toEqual(replacement);
  });

  it("treats missing sealed history as a cache miss", () => {
    const db = new DatabaseSync(":memory:");
    const store = new AgentProcessorCheckpointStore(storage(db), AgentProcessorContract.version);
    store.read();
    store.write(
      checkpoint(1, [
        { role: "user", content: "a".repeat(100_000) },
        { role: "assistant", content: "b".repeat(100_000) },
      ]),
    );
    db.exec("delete from agent_processor_history_chunks_v1 where chunk_index = 0");

    expect(
      new AgentProcessorCheckpointStore(storage(db), AgentProcessorContract.version).read(),
    ).toBeUndefined();
  });

  it("treats structurally malformed checkpoint JSON as a cache miss", () => {
    const db = new DatabaseSync(":memory:");
    const store = new AgentProcessorCheckpointStore(storage(db), AgentProcessorContract.version);
    store.read();
    store.write(checkpoint(1, [{ role: "user", content: "valid" }]));

    db.prepare("update agent_processor_checkpoint_v1 set tail_bytes = ?").run(
      new TextEncoder().encode('[{"role":"system","content":"invalid"}]'),
    );
    expect(
      new AgentProcessorCheckpointStore(storage(db), AgentProcessorContract.version).read(),
    ).toBeUndefined();

    db.prepare("update agent_processor_checkpoint_v1 set tail_bytes = ?, state_json = ?").run(
      new TextEncoder().encode('[{"role":"user","content":"valid"}]'),
      JSON.stringify({ autonomousTurnCount: -1 }),
    );
    expect(
      new AgentProcessorCheckpointStore(storage(db), AgentProcessorContract.version).read(),
    ).toBeUndefined();
  });

  it("invalidates a mismatched contract version and replaces it on the next write", () => {
    const db = new DatabaseSync(":memory:");
    const oldStore = new AgentProcessorCheckpointStore(storage(db), "old-contract");
    oldStore.read();
    oldStore.write(checkpoint(4, [{ role: "user", content: "old" }]));

    const currentStore = new AgentProcessorCheckpointStore(
      storage(db),
      AgentProcessorContract.version,
    );
    expect(currentStore.read()).toBeUndefined();
    const current = checkpoint(9, [{ role: "assistant", content: "current" }]);
    currentStore.write(current);

    expect(
      new AgentProcessorCheckpointStore(storage(db), AgentProcessorContract.version).read(),
    ).toEqual(current);
  });

  it("rebuilds after checkpoint metadata is deleted without its history rows", () => {
    const db = new DatabaseSync(":memory:");
    const oldStore = new AgentProcessorCheckpointStore(storage(db), AgentProcessorContract.version);
    oldStore.read();
    oldStore.write(checkpoint(1, [{ role: "user", content: "x".repeat(200_000) }]));
    db.exec("delete from agent_processor_checkpoint_v1");

    const recovered = checkpoint(2, [{ role: "assistant", content: "recovered" }]);
    const recoveredStore = new AgentProcessorCheckpointStore(
      storage(db),
      AgentProcessorContract.version,
    );
    expect(recoveredStore.read()).toBeUndefined();
    recoveredStore.write(recovered);

    expect(
      new AgentProcessorCheckpointStore(storage(db), AgentProcessorContract.version).read(),
    ).toEqual(recovered);
  });

  it("splits one oversized history item into bounded SQL BLOB rows", () => {
    const db = new DatabaseSync(":memory:");
    const store = new AgentProcessorCheckpointStore(storage(db), AgentProcessorContract.version);
    store.read();
    const oversized = checkpoint(1, [{ role: "user", content: "x".repeat(1_200_000) }]);
    store.write(oversized);

    expect(
      db.prepare("select count(*) as count from agent_processor_history_chunks_v1").get(),
    ).toEqual({ count: 3 });
    expect(
      new AgentProcessorCheckpointStore(storage(db), AgentProcessorContract.version).read(),
    ).toEqual(oversized);
  });

  it("rolls back append and reset chunks when checkpoint metadata publication fails", () => {
    const db = new DatabaseSync(":memory:");
    let rejectCheckpointWrite = false;
    const store = new AgentProcessorCheckpointStore(
      storage(db, (sql) => {
        if (rejectCheckpointWrite && sql.includes("insert into agent_processor_checkpoint_v1")) {
          throw new Error("injected checkpoint failure");
        }
      }),
      AgentProcessorContract.version,
    );
    store.read();
    const initial = checkpoint(1, [{ role: "user", content: "x".repeat(120_000) }]);
    store.write(initial);

    rejectCheckpointWrite = true;
    expect(() => store.write(appendHistory(initial, "y".repeat(20_000)))).toThrow(
      "injected checkpoint failure",
    );
    expect(
      new AgentProcessorCheckpointStore(storage(db), AgentProcessorContract.version).read(),
    ).toEqual(initial);

    expect(() =>
      store.write(checkpoint(2, [{ role: "assistant", content: "reset".repeat(40_000) }])),
    ).toThrow("injected checkpoint failure");
    expect(
      new AgentProcessorCheckpointStore(storage(db), AgentProcessorContract.version).read(),
    ).toEqual(initial);
  });
});
