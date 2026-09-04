/// <reference types="node" />
// memory-budget-scenarios.ts — THE MEMORY PROOFS: each scenario drives the REAL classes (`Stream`
// over node:sqlite, `ProcessorEngine`, `SubscriptionDelivery`) through one workload that must fit a
// 128 MiB Durable Object isolate and prints its facts as ONE JSON line. memory-budget.test.ts
// runs each in a Node CHILD PROCESS capped with `--max-old-space-size` — the stand-in for the
// production cap, which local workerd does not enforce (NullIsolateLimitEnforcer); a child that
// dies of V8's heap limit is the local spelling of "Durable Object's isolate exceeded its memory
// limit and was reset". A process, not a worker thread, on purpose: a heap death inside
// `JSON.parse` or `v8.serialize` aborts the whole process, and a thread would take the test runner
// with it (measured: two rows vanished). By hand: `node memory-budget-scenarios.ts <scenario>
// '<json args>'`.
//
// The two platform copies a real read pays are reproduced deliberately: the Workers-RPC result
// serialization (`v8.serialize` — the same ValueSerializer bytes workerd caps at 32 MiB,
// worker-rpc.h MAX_JS_RPC_MESSAGE_SIZE) and, for a facet's loopback read, the deserialization of
// the page on the receiving side. A Loader-loaded facet runs in the dynamic worker's own isolate,
// so in production that copy lands in the FACET's heap while the parent still pays the rows, the
// parse and the serialization; charging both to the one heap here is the conservative stand-in.

import { memoryUsage } from "node:process";
import { deserialize, serialize } from "node:v8";
import { FacetHandle } from "../context/invoke-handle.ts";
import { errorCode } from "../lib/errors.ts";
import { CoreContract } from "./core-processor.ts";
import type { StreamEvent } from "./events.ts";
import { nodeSqliteDurableObjectStorage } from "./node-sqlite-durable-object-storage.ts";
import { ProcessorEngine, StreamProcessor, type ReduceArgs } from "./processor.ts";
import { ReduceCheckpointTable } from "./reduce-checkpoint.ts";
import { Stream } from "./stream.ts";
import type { DurableObjectStorageSlice } from "./stream-storage.ts";
import { SubscriptionDelivery } from "./subscription-delivery.ts";
import { subscriptionConfiguredEvent } from "./subscriptions.ts";

/** The Workers-RPC ceiling on one serialized argument list or return value (workerd, hard). */
const WORKERS_RPC_MESSAGE_MAX_BYTES = 32 * 1024 * 1024;
const MiB = 1024 * 1024;

/** What a scenario reports back — numbers and strings only (they cross the thread boundary). */
export type ScenarioFacts = Record<string, number | string>;
const facts: ScenarioFacts = {};
const fact = (key: string, value: number | string) => {
  facts[key] = value;
};
let peakHeapBytes = 0;
const notePeakHeap = () => {
  peakHeapBytes = Math.max(peakHeapBytes, memoryUsage().heapUsed);
};
/** A FLAT, V8-HEAP-RESIDENT one-byte string of `chars` — what a payload IS after RPC
 *  deserialization or a SQLite read. Two traps, both measured: `"x".repeat(n)` is a cons tree that
 *  costs almost nothing until flattened (200 × 1 MiB = 3 MB), and a large `Buffer#toString` is an
 *  EXTERNAL string Node keeps off the V8 heap, invisible to `--max-old-space-size`. `JSON.parse`
 *  allocates a fresh sequential heap string (60 × 1 MiB = 75 MB), so every scenario pays what the
 *  isolate would. `fill` is the one byte it repeats — vary it where two payloads must DIFFER (a
 *  diff compares strings by value, so two same-fill strings are one string to it). */
const flatHeapString = (chars: number, fill = 0x78): string =>
  JSON.parse(JSON.stringify(Buffer.alloc(chars, fill).toString("latin1"))) as string;

const bareStream = (
  storage: DurableObjectStorageSlice,
  onCommit: (
    freshEvents: StreamEvent[],
    afterOffset: number,
    throughOffset: number,
  ) => void = () => {},
) => new Stream({ storage, path: "/", projectId: "prj_memory", onCommit });

/** `eventCount` durable events, each carrying a `eventChars`-char string — appended ONE PER CALL so
 *  the append path itself stays within the budget; the scenarios are about what happens after. */
function seedLog(stream: Stream, args: { eventCount: number; eventChars: number }): void {
  for (let i = 0; i < args.eventCount; i++) {
    stream.append({ type: "blob", payload: { n: i, blob: flatHeapString(args.eventChars) } });
    notePeakHeap();
  }
  fact("seededDurableOffset", stream.highestDurableOffset());
}

/** Page the whole log through `read` the way a client does — chaining `scannedThroughOffset` —
 *  paying the RPC result serialization per page, and report the largest page. Returns the number
 *  of events read and the largest serialized page in bytes. */
function pageThroughLog(read: (afterOffset: number, limit: number) => ReturnType<Stream["read"]>) {
  let after = 0;
  let eventsRead = 0;
  let maxPageBytes = 0;
  let pages = 0;
  for (;;) {
    const page = read(after, 500);
    const bytes = serialize(page).byteLength; // what the DO→edge hop would carry
    maxPageBytes = Math.max(maxPageBytes, bytes);
    notePeakHeap();
    eventsRead += page.events.length;
    pages++;
    if (page.scannedThroughOffset <= after) break;
    after = page.scannedThroughOffset;
  }
  fact("pages", pages);
  fact("eventsRead", eventsRead);
  fact("maxPageBytes", maxPageBytes);
  return { eventsRead, maxPageBytes };
}

const scenarios: Record<string, (args: Record<string, number>) => Promise<void>> = {
  /** A client reads the whole log page by page: every page must fit the isolate AND the RPC cap. */
  async "read-whole-log"(args) {
    const storage = nodeSqliteDurableObjectStorage();
    const stream = bareStream(storage);
    seedLog(stream, { eventCount: args.eventCount, eventChars: args.eventChars });
    const { eventsRead, maxPageBytes } = pageThroughLog((after, limit) =>
      stream.read(after, limit),
    );
    if (eventsRead !== args.eventCount)
      throw new Error(`read ${eventsRead} events, seeded ${args.eventCount}`);
    if (maxPageBytes > WORKERS_RPC_MESSAGE_MAX_BYTES)
      throw new Error(`RPC_RESULT_TOO_LARGE: a page serialized to ${maxPageBytes} bytes`);
  },

  /** A facet catches up from the log over its loopback read — the page crosses Workers RPC into the
   *  same heap (serialize + deserialize), then the engine reduces it. */
  async "facet-catch-up"(args) {
    const storage = nodeSqliteDurableObjectStorage();
    const stream = bareStream(storage);
    seedLog(stream, { eventCount: args.eventCount, eventChars: args.eventChars });
    class Tally extends StreamProcessor<{ count: number; chars: number }> {
      readonly contract = {
        slug: "tally",
        version: "1",
        consumes: ["blob"],
        emits: [],
        initialState: () => ({ count: 0, chars: 0 }),
      };
      override reduce({ event, state }: ReduceArgs<{ count: number; chars: number }>) {
        const blob = (event.payload as { blob: string }).blob;
        return { count: state.count + 1, chars: state.chars + blob.length };
      }
    }
    const engine = new ProcessorEngine(new Tally(), {
      stream: {
        append: (...events) => stream.append(...events),
        read: async (after, limit) => {
          const page = stream.read(after, limit);
          const bytes = serialize(page);
          if (bytes.byteLength > WORKERS_RPC_MESSAGE_MAX_BYTES)
            throw new Error(`RPC_RESULT_TOO_LARGE: the loopback page is ${bytes.byteLength} bytes`);
          const copy = deserialize(bytes) as typeof page; // the facet's own copy, same isolate
          notePeakHeap();
          return copy;
        },
      },
      storage: new ReduceCheckpointTable(nodeSqliteDurableObjectStorage().sql),
    });
    await engine.catchUpFromLog();
    const { state, offset } = await engine.snapshot();
    fact("reducedThroughOffset", offset);
    fact("reducedCount", state.count);
    if (state.count !== args.eventCount)
      throw new Error(`reduced ${state.count} events, seeded ${args.eventCount}`);
  },

  /** A core-version bump re-reduces the log INSIDE THE CONSTRUCTOR — the shape that becomes a reboot
   *  loop if it dies: the next wake runs the same constructor over the same log. */
  async "constructor-rereduce"(args) {
    const storage = nodeSqliteDurableObjectStorage();
    const stream = bareStream(storage);
    seedLog(stream, { eventCount: args.eventCount, eventChars: args.eventChars });
    // A checkpoint written under another core version: the raw cursor still names the durable
    // head, so the next constructor re-reduces the whole log from offset 0 to reach it.
    stream.storage.reduceCheckpoints.write(
      CoreContract.slug,
      { reducerVersion: "0.0.0-previous", reducedThroughOffset: stream.highestDurableOffset() },
      undefined,
      false,
    );
    const rebuilt = bareStream(storage);
    notePeakHeap();
    fact("rebuiltDurableOffset", rebuilt.highestDurableOffset());
    fact("rebuiltIncarnation", rebuilt.currentIncarnation());
    if (rebuilt.coreReducedStateSnapshot().offset !== stream.highestDurableOffset())
      throw new Error("the re-reduce did not reach the durable head");
  },

  /** A facet subscriber that never answers while commits keep landing: the delivery loop must not
   *  retain every undelivered batch (a facet owns its progress and heals durables from the log). */
  async "delivery-backlog"(args) {
    const storage = nodeSqliteDurableObjectStorage();
    let delivery!: SubscriptionDelivery;
    const stream = bareStream(storage, (fresh, after, through) =>
      delivery.onCommit(fresh, after, through),
    );
    let pushesStarted = 0;
    // The calls a real stuck facet leaves IN FLIGHT: a Workers-RPC call is referenced by the runtime
    // until it settles, so its promise — and every delivery chained behind it — stays reachable. An
    // unreferenced never-resolving promise would be garbage-collected together with the chain
    // (measured: the backlog vanished), which is not what a hung facet does.
    const callsInFlight: ((value: unknown) => void)[] = [];
    delivery = new SubscriptionDelivery({
      stream,
      // The row's target evaluates to a facet whose every call hangs — a stuck processor.
      evaluateItxExpression: async () =>
        new FacetHandle(() => {
          pushesStarted++;
          return new Promise((resolve) => callsInFlight.push(resolve));
        }),
      recordActivityForQuietClock: () => {},
    });
    stream.append(
      subscriptionConfiguredEvent({
        name: "stuck",
        target: ["itx", "facets", ["get", "stuck"], "processEventBatch"],
        consumes: ["blob"],
      }),
    );
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < args.batchCount; i++) {
      // Ephemeral: zero storage — pure fan-out memory, exactly what a backlog retains.
      stream.append({
        type: "blob",
        ephemeral: true,
        payload: { blob: flatHeapString(args.batchChars) },
      });
      if (i % 10 === 0) await new Promise((r) => setImmediate(r));
      notePeakHeap();
    }
    fact("pushesStarted", pushesStarted);
    fact("appended", args.batchCount);
  },

  /** One event past the platform's own ceiling must be REFUSED at the door with a coded error —
   *  never accepted into a log it can then never be read back out of. */
  async "append-oversize"(args) {
    const storage = nodeSqliteDurableObjectStorage();
    const stream = bareStream(storage);
    try {
      const [event] = stream.append({
        type: "blob",
        payload: { blob: flatHeapString(args.eventChars) },
      });
      fact("accepted", event.offset);
      fact("refusedCode", "none");
    } catch (error) {
      fact("accepted", "no");
      fact("refusedCode", errorCode(error) ?? "uncoded");
      fact(
        "refusedMessage",
        JSON.stringify(error instanceof Error ? error.message : String(error)),
      );
    }
    notePeakHeap();
  },

  // ── THE HUNT (2026-09-04, round 2): the paths above are bounded now; these are the next ones ──

  /** N keyed events already in the log, then ONE batch retrying all N under the same keys: the
   *  dedupe path materializes every EXISTING body (chunk cells → joined → parsed) before anything
   *  commits, keeps each for the echo, and the caller's inputs are live the whole time — retained
   *  ≈ 2 × the batch, transient +2 × one body. The batch itself is bounded by the 32 MiB RPC args
   *  cap, so N ≤ 4 at the ceiling; `argsBytes` proves the batch legal, `echoBytes` is the reply. */
  async "idempotency-dedupe-retry"(args) {
    const storage = nodeSqliteDurableObjectStorage();
    const stream = bareStream(storage);
    for (let i = 0; i < args.eventCount; i++) {
      stream.append({
        type: "blob",
        idempotencyKey: `k${i}`,
        payload: { n: i, blob: flatHeapString(args.eventChars) },
      });
      notePeakHeap();
    }
    fact("seededDurableOffset", stream.highestDurableOffset());
    // The retry as the DO receives it: the same N events, freshly deserialized (heap-resident).
    const retryBatch = Array.from({ length: args.eventCount }, (_, i) => ({
      type: "blob",
      idempotencyKey: `k${i}`,
      payload: { n: i, blob: flatHeapString(args.eventChars) },
    }));
    fact("argsBytes", serialize(retryBatch).byteLength);
    notePeakHeap();
    const echoed = stream.append(...retryBatch);
    notePeakHeap();
    fact("dedupedCount", echoed.filter((event) => event.offset <= args.eventCount).length);
    fact("echoBytes", serialize(echoed).byteLength);
    fact("durableOffsetAfterRetry", stream.highestDurableOffset());
  },

  /** A LEGAL batch — every event under the ceiling, the args under the 32 MiB RPC cap — whose ECHO
   *  (the same events plus offset, createdAt and path each) serializes PAST the RPC result cap: the
   *  commit LANDED, the caller gets an RPC error, and a retry without keys doubles the events. The
   *  cap is emulated as the reply's v8 bytes (what workerd measures) against the constant. */
  async "append-echo-over-rpc-cap"(args) {
    const storage = nodeSqliteDurableObjectStorage();
    const stream = bareStream(storage);
    const batch = Array.from({ length: args.eventCount }, () => ({
      type: "blob",
      payload: { blob: flatHeapString(args.eventChars) },
    }));
    notePeakHeap();
    const argsBytes = serialize(batch).byteLength;
    fact("argsBytes", argsBytes);
    if (argsBytes > WORKERS_RPC_MESSAGE_MAX_BYTES)
      throw new Error(
        `fixture: the args are ${argsBytes} bytes, over the RPC cap — not a legal batch`,
      );
    const echoed = stream.append(...batch);
    notePeakHeap();
    fact("committed", echoed.length);
    fact("durableOffset", stream.highestDurableOffset());
    fact("echoBytes", serialize(echoed).byteLength);
  },

  /** A processor whose reduce KEEPS every event's payload in state (an apps/os agent keeps its
   *  context items), pushed one commit at a time the way the DO drives a facet (each push awaited):
   *  the state grows with the log until its checkpoint no longer fits ONE storage cell — that batch
   *  is refused (coded, before any write), and every later push gap-repairs from the checkpoint (a
   *  page read, the same reduce, the same refusal), as does every wake. Measures where it wedges,
   *  what each failed push and each wake retry costs, whether the big state stays resident, and
   *  whether the persisted checkpoint stays CONSISTENT (cursor and state written as one row). */
  async "accumulating-reducer"(args) {
    const storage = nodeSqliteDurableObjectStorage();
    const facetCheckpoints = new ReduceCheckpointTable(nodeSqliteDurableObjectStorage().sql); // the facet's OWN storage: same cell ceiling
    type Hoard = { items: string[] };
    class Hoarder extends StreamProcessor<Hoard> {
      readonly contract = {
        slug: "hoarder",
        version: "1",
        consumes: ["blob"],
        emits: [],
        initialState: (): Hoard => ({ items: [] }),
      };
      override reduce({ event, state }: ReduceArgs<Hoard>) {
        return { items: [...state.items, (event.payload as { blob: string }).blob] };
      }
    }
    let engine!: ProcessorEngine<Hoard>;
    let pushInFlight: Promise<void> = Promise.resolve();
    const pushErrors: string[] = [];
    const pushErrorCodes: string[] = [];
    let readCalls = 0;
    const stream = bareStream(storage, (fresh, after, through) => {
      // The push crosses Workers RPC into the facet: the facet's own copy of the batch.
      const copy = deserialize(serialize(fresh)) as StreamEvent[];
      pushInFlight = engine.processEventBatch(copy, { after, through }).catch((error) => {
        pushErrors.push(error instanceof Error ? error.message : String(error));
        pushErrorCodes.push(errorCode(error) ?? "uncoded");
      });
    });
    engine = new ProcessorEngine(new Hoarder(), {
      stream: {
        append: (...events) => stream.append(...events),
        read: async (after, limit) => {
          readCalls++;
          return deserialize(serialize(stream.read(after, limit)));
        },
      },
      storage: facetCheckpoints,
    });
    const reducedThroughOffset = () =>
      facetCheckpoints.read<Hoard>("hoarder")?.reducedThroughOffset ?? 0;
    let failedPushMs = 0;
    for (let i = 0; i < args.eventCount; i++) {
      stream.append({ type: "blob", payload: { n: i, blob: flatHeapString(args.eventChars) } });
      const failedBefore = pushErrors.length;
      const t0 = performance.now();
      await pushInFlight; // the DO awaits a facet push
      if (pushErrors.length > failedBefore) failedPushMs += performance.now() - t0;
      notePeakHeap();
    }
    fact("seededDurableOffset", stream.highestDurableOffset());
    fact("reducedThroughOffset", reducedThroughOffset());
    fact("failedPushes", pushErrors.length);
    fact("failedPushMsEach", Math.round(failedPushMs / Math.max(1, pushErrors.length)));
    fact("firstPushError", JSON.stringify(pushErrors[0] ?? "none"));
    fact("firstPushErrorCode", pushErrorCodes[0] ?? "none");
    // The next wakes: each re-reads from the checkpoint, re-reduces, re-throws.
    let wakeRetriesFailed = 0;
    let wakeRetryMs = 0;
    const readsBeforeWakes = readCalls;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await engine.catchUpFromLog().catch(() => wakeRetriesFailed++);
      wakeRetryMs += performance.now() - t0;
      notePeakHeap();
    }
    fact("wakeRetriesFailed", `${wakeRetriesFailed}/3`);
    fact("wakeRetryMsEach", Math.round(wakeRetryMs / 3));
    fact("readsDuringWakes", readCalls - readsBeforeWakes);
    fact("reducedThroughOffsetAfterWakes", reducedThroughOffset());
    fact("heapAfterWakesMB", Math.round(memoryUsage().heapUsed / MiB));
    // What the NEXT incarnation would read: the checkpoint as persisted — ONE row, so the cursor and
    // the state it names can never disagree (born torn: the cursor landed, the state did not).
    const persisted = facetCheckpoints.read<Hoard>("hoarder");
    fact("persistedReducedThroughOffset", persisted?.reducedThroughOffset ?? "none");
    fact("persistedItems", persisted?.state?.items.length ?? "none");
    // The durable blobs at or below the persisted offset (ephemeral live-state deltas take offsets
    // too, so offsets are not item counts): what a consistent checkpoint must hold, exactly.
    let persistedBlobsThrough = 0;
    for (let after = 0; ; ) {
      const page = stream.read(after, 500);
      for (const event of page.events)
        if (event.type === "blob" && event.offset <= (persisted?.reducedThroughOffset ?? 0))
          persistedBlobsThrough++;
      if (page.atHead) break;
      after = page.scannedThroughOffset;
    }
    fact("persistedBlobsThrough", persistedBlobsThrough);
    notePeakHeap();
  },

  /** A processor whose live-state PROJECTION is large and changes every batch — a runtime buffer it
   *  projects, which nothing caps but the delta's append ceiling (the checkpoint stays tiny). Every
   *  set stringifies AND parses both sides (lib/patch.ts) and a one-item edit in an array replaces
   *  the WHOLE array in the delta, which then rides every watcher's queue (bounded per row). Measures
   *  the transient per set and whether the delta still fits the append door. */
  async "live-state-large-projection"(args) {
    const storage = nodeSqliteDurableObjectStorage();
    let delivery!: SubscriptionDelivery;
    let engine!: ProcessorEngine<{ count: number }>;
    let pushInFlight: Promise<void> = Promise.resolve();
    let deltasCommitted = 0;
    let deltasRefused = 0;
    const stream = bareStream(storage, (fresh, after, through) => {
      for (const event of fresh)
        if (event.type === "events.iterate.com/live-state/changed") deltasCommitted++;
        else if (event.type === "blob")
          pushInFlight = engine.processEventBatch([event], { after, through });
      delivery.onCommit(fresh, after, through);
    });
    class Projector extends StreamProcessor<{ count: number }> {
      items = Array.from({ length: args.itemCount }, () => flatHeapString(args.itemChars));
      edits = 0;
      readonly contract = {
        slug: "projector",
        version: "1",
        consumes: ["blob"],
        emits: [],
        initialState: () => ({ count: 0 }),
      };
      override reduce({ state }: ReduceArgs<{ count: number }>) {
        return { count: state.count + 1 };
      }
      override processEvent(): undefined {
        // A one-item edit at the head of the array, each time a DIFFERENT string (a new fill byte).
        this.edits++;
        this.items = [
          flatHeapString(args.itemChars, 0x61 + (this.edits % 26)),
          ...this.items.slice(1),
        ];
      }
      override projectLiveState(state: { count: number }) {
        return { count: state.count, items: this.items };
      }
    }
    const projector = new Projector();
    fact("projectionChars", JSON.stringify(projector.projectLiveState({ count: 0 })).length);
    engine = new ProcessorEngine(projector, {
      stream: {
        append: (...events) => {
          try {
            return stream.append(...events);
          } catch (error) {
            if (errorCode(error) === "EVENT_TOO_LARGE") deltasRefused++;
            throw error;
          }
        },
        read: async (after, limit) => stream.read(after, limit),
      },
      storage: new ReduceCheckpointTable(nodeSqliteDurableObjectStorage().sql),
    });
    // A watcher of the projection that never answers — a stuck mirror facet — so its queue holds
    // the deltas it was pushed (bounded per row by the backlog budget).
    const callsInFlight: ((value: unknown) => void)[] = [];
    delivery = new SubscriptionDelivery({
      stream,
      evaluateItxExpression: async () =>
        new FacetHandle(() => new Promise((resolve) => callsInFlight.push(resolve))),
      recordActivityForQuietClock: () => {},
    });
    stream.append(
      subscriptionConfiguredEvent({
        name: "watcher",
        target: ["itx", "facets", ["get", "watcher"], "processEventBatch"],
        consumes: ["events.iterate.com/live-state/changed"],
      }),
    );
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < args.batchCount; i++) {
      stream.append({ type: "blob", payload: { n: i } });
      await pushInFlight;
      notePeakHeap();
    }
    fact("batches", args.batchCount);
    fact("deltasCommitted", deltasCommitted);
    fact("deltasRefused", deltasRefused);
  },

  /** MANY facet rows stuck at once. The backlog budget is PER ROW (8 MiB each). Rows that consume
   *  the SAME events share the StreamEvent objects, so N stuck rows retain about one page between
   *  them; rows that consume DISJOINT types — N processors each on its own event type — retain a
   *  page EACH: N × 8 MiB. `disjointTypes` picks which; the producer round-robins the types. */
  async "stuck-facet-rows"(args) {
    const storage = nodeSqliteDurableObjectStorage();
    let delivery!: SubscriptionDelivery;
    const stream = bareStream(storage, (fresh, after, through) =>
      delivery.onCommit(fresh, after, through),
    );
    let callsStarted = 0;
    const callsInFlight: ((value: unknown) => void)[] = [];
    delivery = new SubscriptionDelivery({
      stream,
      evaluateItxExpression: async () =>
        new FacetHandle(() => {
          callsStarted++;
          return new Promise((resolve) => callsInFlight.push(resolve));
        }),
      recordActivityForQuietClock: () => {},
    });
    const typeOf = (i: number) => (args.disjointTypes ? `blob-${i % args.rowCount}` : "blob");
    stream.append(
      ...Array.from({ length: args.rowCount }, (_, i) =>
        subscriptionConfiguredEvent({
          name: `p${i}`,
          target: ["itx", "facets", ["get", `p${i}`], "processEventBatch"],
          consumes: [typeOf(i)],
        }),
      ),
    );
    await new Promise((r) => setImmediate(r));
    let appendMs = 0;
    for (let i = 0; i < args.batchCount; i++) {
      const blob = flatHeapString(args.batchChars);
      const t0 = performance.now();
      stream.append({ type: typeOf(i), ephemeral: true, payload: { blob } });
      appendMs += performance.now() - t0;
      if (i % 10 === 0) await new Promise((r) => setImmediate(r));
      notePeakHeap();
    }
    fact("rows", args.rowCount);
    fact("appended", args.batchCount);
    fact("callsStarted", callsStarted);
    fact("appendMsEach", (appendMs / args.batchCount).toFixed(1));
  },

  /** N CURSOR rows — plain-function targets: a loader entrypoint, a sibling context — all behind
   *  after an eviction (a first cursor is memory-only, so a fresh incarnation's rows are behind by
   *  everything committed since they were configured), then ONE commit. The COMMIT path drains
   *  every row, each reading a budgeted page and holding it across its awaited call (`callMs`, a
   *  slow callee) — under the in-flight ledger only as many as fit run at once (born red: every
   *  row at once, a page each). `calleeCopy` charges the callee's deserialized copy to this heap too
   *  (the conservative stand-in for a loader isolate or a sibling DO, which pay it in their own). */
  async "cursor-rows-behind-one-commit"(args) {
    const storage = nodeSqliteDurableObjectStorage();
    let delivery: SubscriptionDelivery | undefined;
    const stream = bareStream(storage, (fresh, after, through) =>
      delivery?.onCommit(fresh, after, through),
    );
    // The previous incarnation: rows configured, then the log they will be behind — no delivery
    // loop ran, so no cursor was ever acked into kv.
    stream.append(
      ...Array.from({ length: args.rowCount }, (_, i) =>
        subscriptionConfiguredEvent({
          name: `sink${i}`,
          target: ["itx", "sink"],
          consumes: ["blob"],
        }),
      ),
    );
    seedLog(stream, { eventCount: args.eventCount, eventChars: args.eventChars });
    // This incarnation: the same rows, cursors born at their configuration offset.
    let callsStarted = 0;
    let callsInFlightNow = 0;
    let maxCallsInFlight = 0;
    const calleeCopies: unknown[] = [];
    delivery = new SubscriptionDelivery({
      stream,
      evaluateItxExpression: async () => (events: StreamEvent[], range: unknown) => {
        callsStarted++;
        callsInFlightNow++;
        maxCallsInFlight = Math.max(maxCallsInFlight, callsInFlightNow);
        if (args.calleeCopy) calleeCopies.push(deserialize(serialize([events, range])));
        notePeakHeap();
        return new Promise((resolve) =>
          setTimeout(() => {
            callsInFlightNow--;
            resolve(undefined);
          }, args.callMs ?? 250),
        );
      },
      recordActivityForQuietClock: () => {},
    });
    stream.append({ type: "blob", payload: { n: -1 } }); // ONE commit
    // Every row gets its first call — how many at once is the ledger's decision, measured.
    const deadline = Date.now() + 30_000;
    while (callsStarted < args.rowCount && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    notePeakHeap();
    fact("rows", args.rowCount);
    fact("callsStarted", callsStarted);
    fact("maxCallsInFlight", maxCallsInFlight);
  },

  /** `waitForEvent` with an explicit `afterOffset: 0` and a type the log never carries: the history
   *  scan pages the WHOLE log synchronously inside one call. Budgeted pages keep the memory flat; the
   *  actor is blocked for the scan's duration — a CPU stall per call, measured here. */
  async "wait-for-event-history-scan"(args) {
    const storage = nodeSqliteDurableObjectStorage();
    const stream = bareStream(storage);
    seedLog(stream, { eventCount: args.eventCount, eventChars: args.eventChars });
    const t0 = performance.now();
    const wait = stream.waitForEvent({ type: "never", afterOffset: 0, timeoutMs: 1 });
    fact("scanMs", Math.round(performance.now() - t0));
    notePeakHeap();
    await wait.then(
      () => fact("waitOutcome", "resolved"),
      (error) => fact("waitOutcome", errorCode(error) ?? "uncoded"),
    );
  },

  /** The core checkpoint is ONE kv cell: subscription rows fill it until the configure that would
   *  grow it past the cap throws inside the commit — the control plane's ceiling, refused with the
   *  platform's own uncoded SQLITE_TOOBIG where every other door refusal is coded. Rows land
   *  `rowsPerAppend` at a time (one core diff per commit; one at a time the Nth configure also pays
   *  an O(N) live-state diff — `configureMsAtCap` is that cost). Then a core-version bump: the
   *  constructor re-reduces every configure, each spreading the whole table — O(rows²) — timed. */
  async "core-rows-until-cell-cap"(args) {
    const storage = nodeSqliteDurableObjectStorage();
    const stream = bareStream(storage);
    const configure = (name: string) =>
      subscriptionConfiguredEvent({
        name,
        target: ["itx", "facets", ["get", name], "processEventBatch"],
        consumes: ["blob"],
      });
    let rows = 0;
    let refused: unknown;
    while (rows < args.maxRows) {
      try {
        stream.append(
          ...Array.from({ length: args.rowsPerAppend }, (_, i) => configure(`row${rows + i}`)),
        );
        rows += args.rowsPerAppend;
      } catch (error) {
        refused = error;
        break;
      }
      notePeakHeap();
    }
    fact("rowsConfigured", rows);
    fact("coreStateChars", JSON.stringify(stream.coreReducedState).length);
    fact("refusedCode", refused === undefined ? "none" : (errorCode(refused) ?? "uncoded"));
    fact(
      "refusedMessage",
      JSON.stringify(refused instanceof Error ? refused.message : String(refused ?? "none")),
    );
    // An un-configure still lands (the state shrinks), and the cost of ONE configure at this size.
    stream.append(subscriptionConfiguredEvent({ name: "row0", target: null }));
    const t0 = performance.now();
    stream.append(configure("row0"));
    fact("configureMsAtCap", (performance.now() - t0).toFixed(1));
    fact("durableOffset", stream.highestDurableOffset());
    // A core-version bump: the next constructor re-reduces every configure from offset 0.
    stream.storage.reduceCheckpoints.write(
      CoreContract.slug,
      { reducerVersion: "0.0.0-previous", reducedThroughOffset: stream.highestDurableOffset() },
      undefined,
      false,
    );
    const t1 = performance.now();
    const rebuilt = bareStream(storage);
    fact("rereduceMs", Math.round(performance.now() - t1));
    fact("rebuiltRows", Object.keys(rebuilt.coreReducedState.subscriptions).length);
    notePeakHeap();
  },

  /** The read budget counts a body's JSON CHARS; what the isolate pays is the PARSED form, and for
   *  object-dense JSON that is an order of magnitude more (`[[]]` is 5 chars with the comma and ~90
   *  heap bytes). Two such events, each under the ceiling and appended separately (each fit), share
   *  one budgeted page — read back together they parse to far more than the budget. Every replay
   *  loop pages the same way, the constructor's core re-reduce included: a reboot loop. */
  async "read-object-dense-page"(args) {
    const storage = nodeSqliteDurableObjectStorage();
    const stream = bareStream(storage);
    // One append per call, in its own frame: two appends are two turns, and the first's payload is
    // unreachable — garbage — before the second arrives, exactly as in the DO.
    const appendDenseEvent = (i: number) => {
      // The payload as the DO receives it — deserialized: built by parsing the JSON it serializes to.
      const json = `[${"[[]],".repeat(args.itemCount).slice(0, -1)}]`;
      const heapBefore = memoryUsage().heapUsed;
      const items = JSON.parse(json) as unknown[];
      fact(`event${i}ParsedMB`, Math.round((memoryUsage().heapUsed - heapBefore) / MiB));
      const [event] = stream.append({ type: "dense", payload: { items } });
      fact(
        `event${i}BodyChars`,
        JSON.stringify({ type: event.type, payload: event.payload }).length,
      );
      notePeakHeap();
    };
    for (let i = 0; i < args.eventCount; i++) appendDenseEvent(i);
    const page = stream.read(0, 500);
    notePeakHeap();
    fact("pageEvents", page.events.length);
    fact("pageBytes", serialize(page).byteLength);
  },
};

export type ScenarioName = keyof typeof scenarios;

const [name, argsJson] = process.argv.slice(2);
const scenario = scenarios[name ?? ""];
if (!scenario) {
  console.error(
    `unknown scenario ${JSON.stringify(name)}; known: ${Object.keys(scenarios).join(", ")}`,
  );
  process.exit(2);
}
await scenario(JSON.parse(argsJson ?? "{}") as Record<string, number>);
notePeakHeap();
// THE REPORT: one JSON line — the runner parses it; a heap death never gets here.
console.log(JSON.stringify({ ...facts, peakHeapMB: Math.round(peakHeapBytes / MiB) }));
