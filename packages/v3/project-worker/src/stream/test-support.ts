// stream/test-support.ts — the in-memory stand-ins the unit lane drives the processor engine and
// the inline reduces with. Imported by the `*.test.ts` files, never by production code. ONE copy:
// every test that needs a stream or a facet's storage imports these, so the commit semantics the
// tests assume cannot drift between files.
//
// `memoryStream` mirrors the DO's commit semantics: one shared offset sequence (an ephemeral
// consumes an offset but never lands in the durable log), idempotency at the door (same key + same
// body → the existing event; a different body → the conflict error), the scanned-offset-range proof
// on both pushes and reads, and THE PUMP — a fire-and-forget `processEventBatch` to every processor
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
import type { ProcessorStream, StreamProcessor } from "./processor.ts";

export function memoryStream(path = "/") {
  const events: StreamEvent[] = []; // the durable log — what `read` answers
  const pushed: StreamEvent[] = []; // every committed event, ephemerals included (the pump's view)
  const byKey = new Map<string, StreamEvent>();
  const procs: StreamProcessor<any>[] = [];
  let maxAssigned = 0;
  let reads = 0;
  const stream: ProcessorStream = {
    append: (...inputs: StreamEventInput[]) => {
      const scannedAfterOffset = maxAssigned;
      const committed = inputs.map((input) => {
        if (input.idempotencyKey) {
          const existing = byKey.get(input.idempotencyKey);
          if (existing) {
            if (sameIdempotentEvent(existing, input)) return existing;
            throw new Error(idempotencyConflictMessage(input.idempotencyKey, existing.offset));
          }
        }
        maxAssigned += 1;
        const event: StreamEvent = {
          ...input,
          offset: maxAssigned,
          createdAt: new Date(0).toISOString(),
          path,
        };
        if (!input.ephemeral) {
          events.push(event);
          if (input.idempotencyKey) byKey.set(input.idempotencyKey, event);
        }
        return event;
      });
      pushed.push(...committed);
      if (maxAssigned > scannedAfterOffset) {
        const scannedOffsetRange = { after: scannedAfterOffset, through: maxAssigned };
        for (const p of procs)
          void p.processEventBatch(committed, scannedOffsetRange).catch(() => {});
      }
      return committed;
    },
    read: (afterOffset = 0, limit = 500) => {
      reads += 1;
      const page = events.filter((e) => e.offset > afterOffset).slice(0, limit);
      return Promise.resolve({
        events: page,
        scannedThroughOffset:
          page.length === limit ? page[page.length - 1].offset : Math.max(afterOffset, maxAssigned),
      });
    },
  };
  return {
    stream,
    events,
    pushed,
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
