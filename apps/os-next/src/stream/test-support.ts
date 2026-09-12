/// <reference types="node" />
// stream/test-support.ts — the in-memory stand-ins the unit lane drives the processor engine with.
// Imported by the `*.test.ts` files, never by production code — ONE copy, so the commit semantics
// the tests assume cannot drift between files.
//
// `memoryStream` mirrors the Stream's commit semantics (one shared offset sequence, idempotency at
// the door, the scanned-range proof) plus THE PUMP — a fire-and-forget `processEventBatch` to every
// engine in `engines` after each append (awaited, it would deadlock a processor that appends during
// its own batch). A short page's proof is the in-memory head, so the engine's stale-push and
// ephemeral-window rules are exercised directly; the real Stream stops at the DURABLE mark
// (stream.test.ts pins that against real SQL).
//   node:sqlite durable object storage — `nodeSqliteDurableObjectStorage`, the `DurableObjectStorageSlice` over
//   node:sqlite, so the REAL Stream runs in plain Node
import { DatabaseSync } from "node:sqlite";
import {
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type StreamEvent,
  type StreamEventInput,
  type ProcessorContract,
  type ProcessorEngine,
  type ProcessorStream,
  ReduceCheckpointTable,
} from "./processor.ts";
import type { DurableObjectStorageSlice } from "./stream.ts";

/** THE PROCESSOR HARNESS: fold `inputs` through a processor's pure `reduce`, exactly as the engine
 *  does — start from the contract's initial state, validate each payload against the contract (a
 *  malformed KNOWN payload is SKIPPED, never reduced), reduce, thread the state — for a declarative
 *  `{ events → state }` processor spec (apps/os shape, no engine/storage/effects). Construct the
 *  processor with `new` and hand it the events; the offsets are the input order. Ephemeral inputs are
 *  reduced like any other — the reduce decides what it folds (presence's `poke` returns undefined). */
export function reduceProcessor<State>(
  processor: {
    contract: ProcessorContract<State>;
    // Method syntax (bivariant params) so a processor whose reduce narrows `event` to its own
    // contract's union is accepted — the harness only ever hands it events its contract consumes.
    reduce(args: { event: StreamEvent; state: State }): State | null | undefined;
  },
  inputs: readonly { type: string; payload?: unknown }[],
): State {
  let state = processor.contract.initialState();
  inputs.forEach((input, index) => {
    const parsed = processor.contract
      .payloadSchemaFor?.(input.type)
      ?.safeParse(input.payload ?? {});
    if (parsed && !parsed.success) return; // the engine skips a malformed known payload
    const event = {
      type: input.type,
      payload: parsed?.success ? parsed.data : input.payload,
      offset: index + 1,
      createdAt: new Date((index + 1) * 1000).toISOString(),
      path: "/",
    } as StreamEvent;
    state = processor.reduce({ event, state }) ?? state;
  });
  return state;
}

export function memoryStream(path = "/") {
  const durableEvents: StreamEvent[] = []; // the durable log — what `read` answers
  const pushedEvents: StreamEvent[] = []; // every committed event, ephemerals included (the pump's view)
  const eventsByIdempotencyKey = new Map<string, StreamEvent>();
  const engines: ProcessorEngine<any>[] = []; // the pump only needs `processEventBatch`
  let maxAssigned = 0;
  let reads = 0;
  const stream: ProcessorStream = {
    append: (...events: StreamEventInput[]) => {
      const scannedAfterOffset = maxAssigned;
      const committedEvents = events.map((event) => {
        if (event.idempotencyKey) {
          const existingEvent = eventsByIdempotencyKey.get(event.idempotencyKey);
          if (existingEvent) {
            if (sameIdempotentEvent(existingEvent, event)) return existingEvent;
            throw new Error(idempotencyConflictMessage(event.idempotencyKey, existingEvent.offset));
          }
        }
        maxAssigned += 1;
        const committedEvent: StreamEvent = {
          ...event,
          offset: maxAssigned,
          createdAt: new Date(0).toISOString(),
          path,
        };
        if (!event.ephemeral) {
          durableEvents.push(committedEvent);
          if (event.idempotencyKey)
            eventsByIdempotencyKey.set(event.idempotencyKey, committedEvent);
        }
        return committedEvent;
      });
      pushedEvents.push(...committedEvents);
      if (maxAssigned > scannedAfterOffset) {
        const scannedOffsetRange = { after: scannedAfterOffset, through: maxAssigned };
        for (const engine of engines)
          void engine.processEventBatch(committedEvents, scannedOffsetRange).catch(() => {});
      }
      return committedEvents;
    },
    read: (afterOffset = 0, limit = 500) => {
      reads += 1;
      const page = durableEvents.filter((event) => event.offset > afterOffset).slice(0, limit);
      return Promise.resolve({
        events: page,
        scannedThroughOffset:
          page.length === limit ? page[page.length - 1].offset : Math.max(afterOffset, maxAssigned),
        // Short page, or a full page whose last row is the durable head (the real Stream's rule).
        atHead:
          page.length < limit ||
          page[page.length - 1].offset === durableEvents[durableEvents.length - 1].offset,
      });
    },
  };
  return {
    stream,
    events: durableEvents,
    pushedEvents,
    engines,
    get reads() {
      return reads;
    },
  };
}

/** A facet's checkpoint table (processor.ts `ReduceCheckpointTable`) over an in-memory
 *  node:sqlite database — the real table, so the unit lane checkpoints exactly as a facet does —
 *  with `writes` counting every write: rule 4 ("one durable commit per batch") and the ephemeral
 *  zero-write rule are pinned by counting it. */
class WriteCountingReduceCheckpointTable extends ReduceCheckpointTable {
  writes = 0;
  override write<State>(
    slug: string,
    cursor: { reducerVersion: string; reducedThroughOffset: number },
    state: State,
    stateChanged: boolean,
  ): void {
    this.writes++;
    super.write(slug, cursor, state, stateChanged);
  }
}

export function memoryStorage(): WriteCountingReduceCheckpointTable {
  return new WriteCountingReduceCheckpointTable(nodeSqliteDurableObjectStorage().sql);
}

/** Let fire-and-forget pushes land. */
export const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// ── node:sqlite durable object storage ── the `DurableObjectStorageSlice` over node:sqlite, so the
// REAL Stream runs in plain Node (the memory pins: local workerd enforces no isolate memory limit,
// a capped V8 does). Faithful where memory is concerned: `exec` hands back node:sqlite's LAZY row
// iterator, as workerd's cursor is, and `transactionSync` is a real BEGIN/ROLLBACK, so a throw
// inside a commit undoes its rows. The cell ceiling workerd enforces (2 MB, SQLITE_TOOBIG) is not
// reproduced here: the typed modules refuse before it, coded (processor.ts `ReduceCheckpointTable`).

export function nodeSqliteDurableObjectStorage(): DurableObjectStorageSlice {
  const db = new DatabaseSync(":memory:");
  return {
    sql: {
      exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) {
        const statement = db.prepare(query);
        const bound = bindings as (string | number | null)[];
        // A write runs NOW (an un-consumed `iterate()` never executes); a read stays lazy.
        if (statement.columns().length === 0) {
          statement.run(...bound);
          return Object.assign([] as T[], { toArray: () => [] as T[] });
        }
        const rows = statement.iterate(...bound) as IterableIterator<T>;
        return Object.assign(rows, { toArray: () => [...rows] });
      },
    },
    transactionSync: <T>(closure: () => T): T => {
      db.exec("BEGIN");
      try {
        const result = closure();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    setAlarm: async () => {},
  };
}
