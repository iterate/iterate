/// <reference types="node" />
// stream/test-support.ts — the in-memory stand-ins a processor's unit tests drive the engine with
// (`iterate/stream/test-support`, Node only: node:sqlite). The SDK's own engine tests use them
// (processor.test.ts, processor-rules.test.ts), and so does every processor author, first-party or
// not, so the commit semantics the tests assume are ONE copy.
//
//   reduceProcessor — fold events through a processor's pure `reduce`, as the engine does
//   memoryStream    — the Stream's commit semantics in memory (one offset sequence, idempotency on
//                     append, the scanned-range proof) plus THE PUMP: a fire-and-forget
//                     `processEventBatch` to every engine in `engines` after each append (awaited, it
//                     would deadlock a processor that appends during its own batch). A short page's
//                     proof is the in-memory head, so the engine's stale-push and ephemeral-window
//                     rules are exercised directly; the platform's real Stream stops at the DURABLE
//                     mark
//   memoryStorage   — the real `ReduceCheckpointTable` over node:sqlite, counting writes
//   nodeSqliteDurableObjectStorage — a Durable Object's `sql` + `transactionSync` over node:sqlite
//   settle          — wait for fire-and-forget pushes to land
import { DatabaseSync } from "node:sqlite";
import type { SqlStorageValue } from "@cloudflare/workers-types";
import {
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type StreamEvent,
  type StreamEventInput,
  type ProcessorContract,
  type ProcessorEngine,
  type ProcessorStream,
  ReduceCheckpointTable,
  type SqlStorageHandle,
} from "./processor.ts";

/** THE PROCESSOR HARNESS: fold `inputs` through a processor's pure `reduce`, exactly as the engine
 *  does — start from the contract's initial state, validate each payload against the contract (a
 *  malformed KNOWN payload is SKIPPED, never reduced), reduce, thread the state — for a declarative
 *  `{ events → state }` processor spec with no engine, storage, or effects. Construct the
 *  processor with `new` and hand it the events; the offsets are the input order. Ephemeral inputs are
 *  reduced like any other — the reduce decides what it folds (presence's `poke` returns undefined). */
export function reduceProcessor<State>(
  processor: {
    contract: ProcessorContract<State>;
    // Method syntax (bivariant params) so a processor whose reduce narrows `event` to its own
    // contract's union is accepted — the harness only ever hands it events its contract consumes.
    reduce(args: { event: StreamEvent; state: State }): State | null | undefined;
  },
  inputs: readonly { type: string; payload?: unknown; source?: StreamEvent["source"] }[],
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
      source: input.source,
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
  // The engine's claims on the context's alarm, RECORDED in order (a time, or null = released); a
  // test that wants the revive calls `engine.revive()` itself.
  const claims: (number | null)[] = [];
  let maxAssigned = 0;
  let reads = 0;
  const stream: ProcessorStream = {
    claim: (at) => {
      claims.push(at);
      return Promise.resolve();
    },
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
    claims,
    get reads() {
      return reads;
    },
  };
}

/** A facet's checkpoint table (processor.ts `ReduceCheckpointTable`) over an in-memory
 *  node:sqlite database — the real table, so the unit tests checkpoint exactly as a facet does —
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

/** Wait `ms` on a timer — long enough, by default, for fire-and-forget pushes to land. */
export const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// ── node:sqlite durable object storage ── a Durable Object's `sql` and `transactionSync` over
// node:sqlite, so the REAL checkpoint table, and anything else written against a Durable Object's
// storage, runs in plain Node, where a capped V8 enforces the isolate memory limit local workerd
// does not. Faithful where memory is concerned: `exec` hands back node:sqlite's LAZY row
// iterator, as workerd's cursor is, and `transactionSync` is a real BEGIN/ROLLBACK, so a throw
// inside a commit undoes its rows. The cell ceiling workerd enforces (2 MB, SQLITE_TOOBIG) is not
// reproduced here: the typed modules refuse before it, coded (processor.ts `ReduceCheckpointTable`).

export function nodeSqliteDurableObjectStorage(): {
  sql: SqlStorageHandle;
  transactionSync<T>(closure: () => T): T;
} {
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
  };
}
