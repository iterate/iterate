// stream/test-support.ts — the in-memory stand-ins the unit lane drives the processor engine and
// the inline reduces with. Imported by the `*.test.ts` files, never by production code. ONE copy:
// every test that needs a stream or a facet's storage imports these, so the commit semantics the
// tests assume cannot drift between files.
//
// `memoryStream` mirrors the DO's commit semantics: one shared offset sequence (an ephemeral
// consumes an offset but never lands in the durable log), idempotency at the door (same key + same
// body → the existing event; a different body → the conflict error), the scanned-offset-range proof
// on both pushes and reads, and THE PUMP — a fire-and-forget `processEventBatch` to every engine
// registered in `procs` after each append (awaited, it would deadlock a processor that appends
// during its own batch). A short page's proof is the in-memory head (`Math.max(after, head)`), so
// the engine's stale-push and ephemeral-window rules are exercised directly; the real Stream stops
// at the DURABLE mark (__workers-tests__/stream.test.ts pins that against real storage).
import {
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type StreamEvent,
  type StreamEventInput,
} from "./events.ts";
import type { ProcessorEngine, ProcessorStream } from "./processor.ts";

export function memoryStream(path = "/") {
  const durableEvents: StreamEvent[] = []; // the durable log — what `read` answers
  const pushedEvents: StreamEvent[] = []; // every committed event, ephemerals included (the pump's view)
  const eventsByKey = new Map<string, StreamEvent>();
  const procs: ProcessorEngine<any>[] = []; // the pump only needs `processEventBatch`
  let maxAssigned = 0;
  let reads = 0;
  const stream: ProcessorStream = {
    append: (...events: StreamEventInput[]) => {
      const scannedAfterOffset = maxAssigned;
      const committedEvents = events.map((event) => {
        if (event.idempotencyKey) {
          const existingEvent = eventsByKey.get(event.idempotencyKey);
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
          if (event.idempotencyKey) eventsByKey.set(event.idempotencyKey, committedEvent);
        }
        return committedEvent;
      });
      pushedEvents.push(...committedEvents);
      if (maxAssigned > scannedAfterOffset) {
        const scannedOffsetRange = { after: scannedAfterOffset, through: maxAssigned };
        for (const p of procs)
          void p.processEventBatch(committedEvents, scannedOffsetRange).catch(() => {});
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
      });
    },
  };
  return {
    stream,
    events: durableEvents,
    pushedEvents,
    procs,
    get reads() {
      return reads;
    },
  };
}

/** A facet's own kv, in memory. `writes` counts every put — rule 4 ("one durable commit per
 *  batch") and the ephemeral zero-write rule are pinned by counting it. */
export function memoryStorage() {
  const map = new Map<string, unknown>();
  let writes = 0;
  return {
    get: <T>(k: string) => map.get(k) as T | undefined,
    put: (k: string, v: unknown) => {
      writes++;
      map.set(k, structuredClone(v));
    },
    get writes() {
      return writes;
    },
  };
}

/** Let fire-and-forget pushes land. */
export const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));
