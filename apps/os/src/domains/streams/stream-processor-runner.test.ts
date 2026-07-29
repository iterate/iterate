// The in-memory executable spec for StreamProcessorRunner (slice 3 of
// docs/stream-processor-runner-redesign.md). Every invariant the redesign
// promises is pinned here against a plain in-memory journal, progress store,
// and virtual clock — the same harness style as stream-processor-keepalive.test.ts.
//
// The invariants under test:
//  1. batch-division invariance (one batch / singletons / random partitions)
//  2. strict per-event blockProcessorWhile ordering
//  3. runInBackground overtaking
//  4. crash() at every boundary → at-least-once, never lost work
//  5. reduce-only refold (reducerVersion bump: reduce yes, processEvent no)
//  6. stale-incarnation commits rejected by the monotonic progress fence
//  7. onCaughtUp at head, including the requested-N / unconsumed-N+1 wedge

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StreamEvent, StreamEventInput } from "iterate/processors";
import {
  defineProcessorContract,
  idempotencyConflictMessage,
  sameIdempotentEvent,
} from "iterate/processors";
import { StreamProcessor } from "iterate/processors";
import { ProcessorKeepalive, type KeepaliveRecord } from "iterate/processors";
import {
  StreamProcessorRunner,
  type ProcessorProgress,
  type ProcessorProgressStore,
  type ProcessorRecovery,
} from "iterate/processors";
import { STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "iterate/processors";
import type { Stream } from "../../itx-api.generated.ts";

const REQUESTED = "events.iterate.com/test-task/requested";
const COMPLETED = "events.iterate.com/test-task/completed";
const ECHOED = "events.iterate.com/test-task/echoed";
const DRIVEN = "events.iterate.com/test-task/driven";
// The ONE platform revival fact (core-owned); the fixture contract defines it
// LOCALLY so this harness stays free of the real core contract's machinery.
const REVIVED = STREAM_PROCESSOR_REVIVED_EVENT_TYPE;
const NOISE = "events.iterate.com/other/noise";
const HOME = "/tests/runner";
const SIBLING = "/tests/runner-sibling";
const TEST_STREAM_ID = "11111111-1111-4111-8111-111111111111";
const RECREATED_STREAM_ID = "22222222-2222-4222-8222-222222222222";
const siblingKey = (semanticKey: string, streamId = TEST_STREAM_ID) =>
  `${semanticKey}@source-stream:${streamId}`;

// -----------------------------------------------------------------------------
// The processor under drive: an obligation-style task tracker. `requested`
// opens an obligation, `completed` settles it; side effects are whatever the
// test's hooks decide, so each test states its own semantics inline.
// -----------------------------------------------------------------------------

function taskContract(
  version: string,
  consumes: readonly string[] = [REQUESTED, COMPLETED, REVIVED],
) {
  return defineProcessorContract({
    slug: "test-task",
    version,
    description: "Obligation-style processor exercising the runner's per-event loop.",
    stateSchema: z.object({
      count: z.number().default(0),
      open: z.array(z.string()).default([]),
    }),
    events: {
      [REQUESTED]: { payloadSchema: z.object({ id: z.string() }) },
      [COMPLETED]: { payloadSchema: z.object({ id: z.string() }) },
      [ECHOED]: { payloadSchema: z.object({ id: z.string() }) },
      [DRIVEN]: { payloadSchema: z.object({ id: z.string() }) },
      [REVIVED]: { payloadSchema: z.object({}) },
    },
    // Cast: the runner reads `consumes` structurally (a string list + a `"*"`
    // check), so a runtime-supplied list is what the wildcard test needs; the
    // literal-union type the builder infers is irrelevant to the runner.
    consumes: consumes as unknown as [typeof REQUESTED, typeof COMPLETED, typeof REVIVED],
    emits: [ECHOED, DRIVEN],
  });
}

type TaskContract = ReturnType<typeof taskContract>;
type TaskState = { count: number; open: string[] };

/** Type carrier: names the protected hook arg shapes from inside a subclass,
 * so the module-level hook types below can reference them. Never instantiated. */
abstract class HookArgTypes extends StreamProcessor<TaskContract> {
  declare readonly processArgs: Parameters<StreamProcessor<TaskContract>["processEvent"]>[0];
}
type ProcessArgs = HookArgTypes["processArgs"];
/** processEvent args narrowed to a real consumed event — `onProcess` fires only
 * for those (never the event-less caught-up call). */
type ConsumedProcessArgs = ProcessArgs & { event: NonNullable<ProcessArgs["event"]> };
type TaskHooks = {
  /** `eventKey` is `this.idempotencyKey(key, event)` — the per-event effect
   * key a real processor mints for deterministic-consequence appends, so a
   * redelivered batch dedupes instead of double-appending. */
  onProcess?: (args: ConsumedProcessArgs, eventKey: (key: string) => string) => void;
  /** The caught-up processing: `processEvent` under `delivery.caughtUp`. `args.event`
   * is the last consumed event of a caught-up batch, or `null` for the
   * event-less caught-up call. `stableKey` is `this.idempotencyKey` (binds NO
   * offset) — obligation keys that survive redelivery/revival unchanged. */
  onHead?: (args: ProcessArgs, stableKey: (key: string) => string) => void | Promise<void>;
};

class TaskProcessor extends StreamProcessor<
  TaskContract,
  { contract: TaskContract; hooks: TaskHooks }
> {
  get contract(): TaskContract {
    return this.deps.contract;
  }

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<TaskContract>["reduce"]>[0]) {
    if (event.type === REQUESTED) {
      return { count: state.count + 1, open: [...state.open, event.payload.id] };
    }
    if (event.type === COMPLETED) {
      return { count: state.count + 1, open: state.open.filter((id) => id !== event.payload.id) };
    }
    return state;
  }

  protected override processEvent(args: ProcessArgs): undefined {
    if (args.event !== null) {
      const consumed = args as ConsumedProcessArgs;
      this.deps.hooks.onProcess?.(consumed, (key) => this.idempotencyKey(key, consumed.event));
    }
    // The caught-up processing: fires for the last consumed event of a
    // caught-up batch OR the runner's event-less caught-up call (args.event
    // null). onHead registers its blocking work synchronously (the runner
    // awaits it before the batch-end commit).
    if (args.delivery.caughtUp) {
      void this.deps.hooks.onHead?.(args, (key) => this.idempotencyKey(key));
    }
  }
}

// -----------------------------------------------------------------------------
// In-memory stream network: a home journal plus sibling streams, offset
// assignment, idempotency-key dedupe (like the real stream), and a paged
// readEvents — everything the runner touches.
// -----------------------------------------------------------------------------

type Journal = ReturnType<typeof makeJournal>;

function makeJournal(homePath = HOME) {
  const rowsByPath = new Map<string, StreamEvent[]>();
  /** EVERY append attempt, deduped or not — the at-least-once evidence. */
  const attempts: { path: string; event: StreamEventInput; deduped: boolean }[] = [];
  const failNext = new Map<string, Error>();
  let failNextRead: Error | undefined;
  let hangNextRead = false;
  let createdAtClock = 0;
  let streamId = TEST_STREAM_ID;
  let eventPageReads = 0;
  let guardedAppendGate: ReturnType<typeof deferred> | undefined;
  let recreateAfterEventPage: { readNumber: number; nextStreamId: string } | undefined;

  const rowsFor = (path: string): StreamEvent[] => {
    let rows = rowsByPath.get(path);
    if (rows === undefined) {
      rows = [];
      rowsByPath.set(path, rows);
    }
    return rows;
  };

  const commit = (path: string, event: StreamEventInput): StreamEvent => {
    const injected = failNext.get(path);
    if (injected !== undefined) {
      failNext.delete(path);
      throw injected;
    }
    const rows = rowsFor(path);
    if (event.idempotencyKey !== undefined) {
      const existing = rows.find((row) => row.idempotencyKey === event.idempotencyKey);
      if (existing !== undefined) {
        if (!sameIdempotentEvent(existing, event)) {
          throw new Error(idempotencyConflictMessage(event.idempotencyKey, existing.offset));
        }
        attempts.push({ path, event, deduped: true });
        return existing;
      }
    }
    attempts.push({ path, event, deduped: false });
    const committed = {
      ...event,
      offset: (rows.at(-1)?.offset ?? 0) + 1,
      createdAt: new Date(++createdAtClock).toISOString(),
      path,
    } as StreamEvent;
    rows.push(committed);
    return committed;
  };

  const streamAt = (path: string): Stream =>
    ({
      append: (...events: StreamEventInput[]) =>
        Promise.resolve(events.map((event) => commit(path, event))),
      appendIfStreamId: async (args: { streamId: string; events: StreamEventInput[] }) => {
        await guardedAppendGate?.promise;
        if (args.streamId !== streamId) {
          throw new Error(`stream ID changed (${args.streamId} -> ${streamId}); append rejected`);
        }
        return args.events.map((event) => commit(path, event));
      },
      at: (child: string) => streamAt(child),
      getEventPage: (args?: {
        afterOffset?: number;
        beforeOffset?: number | null;
        limit?: number;
      }) => {
        if (failNextRead !== undefined) {
          const error = failNextRead;
          failNextRead = undefined;
          return Promise.reject(error);
        }
        const afterOffset = args?.afterOffset ?? 0;
        const beforeOffset = args?.beforeOffset ?? Number.MAX_SAFE_INTEGER;
        const page = {
          streamId,
          streamMaxOffset: rowsFor(path).at(-1)?.offset ?? 0,
          events: rowsFor(path)
            .filter((row) => row.offset > afterOffset && row.offset < beforeOffset)
            .slice(0, args?.limit ?? 500),
        };
        eventPageReads += 1;
        if (recreateAfterEventPage?.readNumber === eventPageReads) {
          rowsByPath.set(homePath, []);
          streamId = recreateAfterEventPage.nextStreamId;
          recreateAfterEventPage = undefined;
        }
        return Promise.resolve(page);
      },
      readEvents: (args?: {
        afterOffset?: number;
        beforeOffset?: number | null;
        limit?: number;
      }) => {
        let cursor = args?.afterOffset ?? 0;
        const limit = args?.limit ?? 500;
        return {
          next: () => {
            if (hangNextRead) {
              hangNextRead = false;
              return new Promise<StreamEvent[]>(() => {});
            }
            if (failNextRead !== undefined) {
              const error = failNextRead;
              failNextRead = undefined;
              return Promise.reject(error);
            }
            const page = rowsFor(path)
              .filter(
                (row) =>
                  row.offset > cursor &&
                  (args?.beforeOffset == null || row.offset < args.beforeOffset),
              )
              .slice(0, limit);
            if (page.length > 0) cursor = page.at(-1)!.offset;
            return Promise.resolve(page);
          },
          [Symbol.dispose]: () => {},
        };
      },
    }) as unknown as Stream;

  return {
    homePath,
    stream: streamAt(homePath),
    attempts,
    rows: (path = homePath) => rowsFor(path),
    head: () => rowsFor(homePath).at(-1)?.offset ?? 0,
    /** Seed a raw journal fact directly (no attempt logged — it's the fixture). */
    seed(event: { type: string; payload?: Record<string, unknown> }): StreamEvent {
      const rows = rowsFor(homePath);
      const committed = {
        ...event,
        offset: (rows.at(-1)?.offset ?? 0) + 1,
        createdAt: new Date(++createdAtClock).toISOString(),
        path: homePath,
      } as StreamEvent;
      rows.push(committed);
      return committed;
    },
    failNextAppendTo(path: string, error: Error) {
      failNext.set(path, error);
    },
    failNextReadWith(error: Error) {
      failNextRead = error;
    },
    hangNextRead() {
      hangNextRead = true;
    },
    pauseGuardedAppends() {
      if (guardedAppendGate !== undefined) throw new Error("guarded appends are already paused");
      guardedAppendGate = deferred();
      return () => {
        const gate = guardedAppendGate;
        guardedAppendGate = undefined;
        gate?.resolve(undefined);
      };
    },
    /** Delete and recreate the home stream: its offsets and identity restart. */
    recreate(nextStreamId = RECREATED_STREAM_ID) {
      rowsByPath.set(homePath, []);
      streamId = nextStreamId;
    },
    recreateAfterPage(readNumber: number, nextStreamId = RECREATED_STREAM_ID) {
      recreateAfterEventPage = { readNumber, nextStreamId };
    },
  };
}

// -----------------------------------------------------------------------------
// In-memory ProcessorProgressStore: CAS-fenced by cursorRevision (absent
// record = revision 0), deep-cloned on both sides so aliasing bugs surface,
// and asserting the persisted two-cursor invariant on every commit.
// -----------------------------------------------------------------------------

function makeProgressStore() {
  let record: ProcessorProgress<TaskState> | undefined;
  const commits: ProcessorProgress<TaskState>[] = [];
  let failNextCommit: Error | undefined;
  const store: ProcessorProgressStore<TaskState> = {
    read: () => (record === undefined ? undefined : structuredClone(record)),
    commit: (progress, opts) => {
      if (failNextCommit !== undefined) {
        const error = failNextCommit;
        failNextCommit = undefined;
        throw error;
      }
      if (opts.expectedStreamId !== record?.streamId) {
        throw new Error(
          `progress commit fenced: expected streamId ${String(opts.expectedStreamId)}, ` +
            `persisted ${String(record?.streamId)}`,
        );
      }
      const persistedRevision = record?.processing.cursorRevision ?? 0;
      if (opts.expectedCursorRevision !== persistedRevision) {
        throw new Error(
          `progress commit fenced: expected cursorRevision ${opts.expectedCursorRevision}, ` +
            `persisted ${persistedRevision}`,
        );
      }
      // MONOTONIC fence (same rule as durableObjectProgressStore): a same-revision
      // backward acknowledgement is a stale incarnation rolling the cursor
      // back; only a revision-bumping rewind may move it backward.
      if (
        record !== undefined &&
        progress.processing.acknowledgedThroughOffset <
          record.processing.acknowledgedThroughOffset &&
        progress.processing.cursorRevision <= persistedRevision
      ) {
        throw new Error(
          `progress commit fenced: acknowledgedThroughOffset would move backward ` +
            `(${record.processing.acknowledgedThroughOffset} -> ` +
            `${progress.processing.acknowledgedThroughOffset}) without a cursorRevision bump`,
        );
      }
      if (progress.reduction.reducedThroughOffset > progress.processing.acknowledgedThroughOffset) {
        throw new Error(
          "progress invariant violated: reducedThroughOffset > acknowledgedThroughOffset",
        );
      }
      record = structuredClone(progress);
      commits.push(structuredClone(progress));
    },
    replaceForStream: (progress, opts) => {
      if (
        record?.streamId !== opts.expectedStreamId ||
        record.processing.cursorRevision !== opts.expectedCursorRevision
      ) {
        throw new Error("stream replacement fenced");
      }
      record = structuredClone(progress);
      commits.push(structuredClone(progress));
    },
  };
  return {
    store,
    commits,
    get record() {
      return record;
    },
    failCommitOnce(error: Error) {
      failNextCommit = error;
    },
    /** Plant a record verbatim, bypassing commit's checks — corrupt/foreign-record fixtures. */
    plant(progress: ProcessorProgress<TaskState>) {
      record = structuredClone(progress);
    },
  };
}

// -----------------------------------------------------------------------------
// Harness: journal + store + one runner incarnation. crash() drops the
// incarnation (pending work is simply abandoned, like an eviction) and builds
// a fresh processor + runner over the SAME journal and store.
// -----------------------------------------------------------------------------

type HarnessArgs = {
  journal?: Journal;
  store?: ReturnType<typeof makeProgressStore>;
  contract?: TaskContract;
  hooks?: TaskHooks;
  readPageSize?: number;
  recovery?: ProcessorRecovery;
  now?: () => number;
};

function eventBatch(events: StreamEvent[], streamMaxOffset: number, streamId = TEST_STREAM_ID) {
  const scannedAfterOffset =
    events[0]?.offset === undefined ? streamMaxOffset : events[0].offset - 1;
  return {
    streamId,
    events,
    scannedAfterOffset,
    scannedThroughOffset: events.at(-1)?.offset ?? scannedAfterOffset,
    streamMaxOffset,
  };
}

function initialProgress(
  streamId = TEST_STREAM_ID,
  cursorRevision = 0,
): ProcessorProgress<TaskState> {
  return {
    streamId,
    reduction: {
      reducerVersion: "0.0.1",
      reducedThroughOffset: 0,
      state: { count: 0, open: [] },
    },
    processing: { acknowledgedThroughOffset: 0, cursorRevision },
  };
}

function makeHarness(args: HarnessArgs = {}) {
  const journal = args.journal ?? makeJournal();
  const store = args.store ?? makeProgressStore();
  const contract = args.contract ?? taskContract("0.0.1");
  const hooks = args.hooks ?? {};
  const processor = new TaskProcessor({
    stream: journal.stream,
    path: journal.homePath,
    projectId: null,
    contract,
    hooks,
  });
  const runner = new StreamProcessorRunner({
    processor,
    stream: journal.stream,
    durability: {
      progress: store.store,
      ...(args.recovery === undefined ? {} : { recovery: args.recovery }),
    },
    now: args.now ?? (() => 0),
    ...(args.readPageSize === undefined ? {} : { readPageSize: args.readPageSize }),
  });

  return {
    journal,
    store,
    processor,
    runner,
    /** Deliver explicit batches through one opened processEventBatch. */
    async deliverBatches(batches: StreamEvent[][], streamMaxOffset?: number) {
      const { processEventBatch } = await runner.openEventBatchCallback();
      const head = streamMaxOffset ?? journal.head();
      for (const events of batches) {
        await processEventBatch(eventBatch(events, head));
      }
    },
    /** Open delivery and push everything past the persisted cursor as ONE batch. */
    async deliverPending() {
      const opened = await runner.openEventBatchCallback();
      const events = journal.rows().filter((row) => row.offset > opened.checkpointOffset);
      if (events.length > 0) {
        await opened.processEventBatch(eventBatch(events, journal.head()));
      }
      return opened.checkpointOffset;
    },
    /** The production hosted-processor batch's exact shape:
     * only CONSUMED types are delivered, but the batch is stamped with the
     * RAW journal maximum offset — an unconsumed durable tail leaves the batch behind
     * `streamMaxOffset` with nothing else ever delivering the difference. */
    async deliverConsumesFilteredPending() {
      const opened = await runner.openEventBatchCallback();
      const consumed = new Set<string>(contract.consumes);
      const events = journal
        .rows()
        .filter((row) => row.offset > opened.checkpointOffset && consumed.has(row.type));
      if (events.length > 0) {
        await opened.processEventBatch(eventBatch(events, journal.head()));
      }
      return opened.checkpointOffset;
    },
    /** Drop this incarnation; reopen over the same durable journal + store. */
    crash(overrides: Partial<HarnessArgs> = {}) {
      return makeHarness({ ...args, ...overrides, journal, store });
    },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Deterministic random partition of `items` (seeded LCG; order preserved). */
function randomPartition<T>(items: readonly T[], seed: number): T[][] {
  let s = seed >>> 0;
  const out: T[][] = [];
  let current: T[] = [];
  for (const item of items) {
    current.push(item);
    s = (s * 1664525 + 1013904223) >>> 0;
    if (s / 2 ** 32 < 0.4) {
      out.push(current);
      current = [];
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Comparable projection of committed rows (offsets/timestamps vary across runs). */
function comparableRows(rows: readonly StreamEvent[]) {
  return rows.map((row) => ({
    type: row.type,
    idempotencyKey: row.idempotencyKey,
    payload: row.payload,
  }));
}

// =============================================================================
// 1. Batch-division invariance
// =============================================================================

describe("StreamProcessorRunner batch-division invariance", () => {
  /** 8-event fixture: consumed, unconsumed, and one malformed consumed-type event. */
  function seedFixture(journal: Journal) {
    journal.seed({ type: REQUESTED, payload: { id: "a" } }); // 1
    journal.seed({ type: REQUESTED, payload: { id: "b" } }); // 2
    journal.seed({ type: NOISE, payload: {} }); // 3
    journal.seed({ type: COMPLETED, payload: { id: "a" } }); // 4
    journal.seed({ type: REQUESTED, payload: { id: 42 } }); // 5 — fails the contract parse
    journal.seed({ type: REQUESTED, payload: { id: "c" } }); // 6
    journal.seed({ type: NOISE, payload: {} }); // 7
    journal.seed({ type: COMPLETED, payload: { id: "b" } }); // 8
  }

  /** Effect-per-event + obligation-drive-caught-up hooks (all onto the sibling). */
  const effectHooks: TaskHooks = {
    onProcess: (args, eventKey) => {
      args.blockProcessorWhile(() =>
        args.appendTo(SIBLING, {
          type: ECHOED,
          idempotencyKey: eventKey("echo"),
          payload: { id: args.event.payload.id },
        }),
      );
    },
    onHead: (args, stableKey) => {
      for (const id of args.state.open) {
        args.blockProcessorWhile(() =>
          args.appendTo(SIBLING, {
            type: DRIVEN,
            idempotencyKey: stableKey(`drive:${id}`),
            payload: { id },
          }),
        );
      }
    },
  };

  async function runWithPartition(split: (rows: StreamEvent[]) => StreamEvent[][]) {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const journal = makeJournal();
      seedFixture(journal);
      const harness = makeHarness({ journal, hooks: effectHooks });
      await harness.deliverBatches(split(journal.rows().slice()));
      // The parse-failure diagnostic is a post-commit background append.
      await vi.waitFor(() =>
        expect(
          journal.rows().filter((row) => row.type === "events.iterate.com/stream/error-occurred"),
        ).toHaveLength(1),
      );
      const snapshot = await harness.runner.snapshot();
      return {
        snapshot,
        acknowledged: harness.store.record!.processing.acknowledgedThroughOffset,
        sibling: comparableRows(harness.journal.rows(SIBLING)),
        homeDiagnostics: comparableRows(
          journal.rows().filter((row) => row.type === "events.iterate.com/stream/error-occurred"),
        ),
      };
    } finally {
      consoleError.mockRestore();
    }
  }

  it("one batch, singletons, and random partitions yield identical state AND appends", async () => {
    const oneBatch = await runWithPartition((rows) => [rows]);

    expect(oneBatch.snapshot).toEqual({
      offset: 8,
      state: { count: 5, open: ["c"] },
    });
    expect(oneBatch.acknowledged).toBe(8);
    // 5 parsed consumed events echo; the open obligation is driven at head.
    expect(oneBatch.sibling).toEqual([
      {
        type: ECHOED,
        idempotencyKey: siblingKey("test-task/echo@/tests/runner:1"),
        payload: { id: "a" },
      },
      {
        type: ECHOED,
        idempotencyKey: siblingKey("test-task/echo@/tests/runner:2"),
        payload: { id: "b" },
      },
      {
        type: ECHOED,
        idempotencyKey: siblingKey("test-task/echo@/tests/runner:4"),
        payload: { id: "a" },
      },
      {
        type: ECHOED,
        idempotencyKey: siblingKey("test-task/echo@/tests/runner:6"),
        payload: { id: "c" },
      },
      {
        type: ECHOED,
        idempotencyKey: siblingKey("test-task/echo@/tests/runner:8"),
        payload: { id: "b" },
      },
      { type: DRIVEN, idempotencyKey: siblingKey("test-task/drive:c"), payload: { id: "c" } },
    ]);

    const singletons = await runWithPartition((rows) => rows.map((row) => [row]));
    expect(singletons).toEqual(oneBatch);

    for (const seed of [1, 7, 42]) {
      const partitioned = await runWithPartition((rows) => randomPartition(rows, seed));
      expect(partitioned).toEqual(oneBatch);
    }
  });
});

describe("StreamProcessorRunner delivery coordinates", () => {
  it("rejects a batch whose scan starts beyond the committed cursor", async () => {
    const harness = makeHarness();
    harness.journal.seed({ type: REQUESTED, payload: { id: "a" } });
    harness.journal.seed({ type: REQUESTED, payload: { id: "b" } });
    const opened = await harness.runner.openEventBatchCallback();

    await expect(
      opened.processEventBatch({
        streamId: TEST_STREAM_ID,
        events: [harness.journal.rows()[1]!],
        scannedAfterOffset: 1,
        scannedThroughOffset: 2,
        streamMaxOffset: 2,
      }),
    ).rejects.toThrow(/starts after the committed scan cursor: 1 > 0/);
    expect(harness.store.record?.processing.acknowledgedThroughOffset ?? 0).toBe(0);
  });

  it("resets progress when the same path is recreated and rejects the old lifetime callback", async () => {
    const journal = makeJournal();
    journal.seed({ type: REQUESTED, payload: { id: "from-a" } });
    const harness = makeHarness({ journal });
    await harness.deliverPending();
    expect(harness.store.record).toEqual({
      streamId: TEST_STREAM_ID,
      reduction: {
        reducerVersion: "0.0.1",
        reducedThroughOffset: 1,
        state: { count: 1, open: ["from-a"] },
      },
      processing: { acknowledgedThroughOffset: 1, cursorRevision: 0 },
    });

    // Keep a callback opened against lifetime A, then delete/recreate the
    // stream at the same path. Offsets restart at 1 under a new stream ID.
    const oldCallback = await harness.runner.openEventBatchCallback(TEST_STREAM_ID);
    const oldEvent = journal.rows()[0]!;
    journal.recreate();
    journal.seed({ type: REQUESTED, payload: { id: "from-b" } });

    const currentCallback = await harness.runner.openEventBatchCallback(RECREATED_STREAM_ID);
    expect(currentCallback.checkpointOffset).toBe(0);
    expect(harness.store.record).toEqual(initialProgress(RECREATED_STREAM_ID, 1));

    // A callback retained from lifetime A cannot feed its offset-1 event into
    // lifetime B after the reset. It is rejected before reduction or effects.
    await expect(
      oldCallback.processEventBatch(eventBatch([oldEvent], 1, TEST_STREAM_ID)),
    ).rejects.toThrow(
      `received batch for stream ID ${TEST_STREAM_ID}; current progress belongs to ${RECREATED_STREAM_ID}`,
    );
    expect(harness.store.record).toEqual(initialProgress(RECREATED_STREAM_ID, 1));

    await currentCallback.processEventBatch(
      eventBatch(journal.rows().slice(), 1, RECREATED_STREAM_ID),
    );
    await expect(harness.runner.snapshot()).resolves.toEqual({
      offset: 1,
      state: { count: 1, open: ["from-b"] },
    });
    expect(harness.store.record?.processing).toEqual({
      acknowledgedThroughOffset: 1,
      cursorRevision: 1,
    });
  });

  it("rejects a delayed lifetime-A home append after the path is recreated as B", async () => {
    const blockerStarted = deferred();
    const releaseBlocker = deferred();
    const hooks: TaskHooks = {
      onProcess: (args, eventKey) => {
        if (args.event.payload.id !== "from-a") return;
        args.blockProcessorWhile(async () => {
          blockerStarted.resolve();
          await releaseBlocker.promise;
          await args.append({
            type: ECHOED,
            idempotencyKey: eventKey("echo"),
            payload: { id: args.event.payload.id },
          });
        });
      },
    };
    const journal = makeJournal();
    journal.seed({ type: REQUESTED, payload: { id: "from-a" } });
    const harness = makeHarness({ journal, hooks });

    const lifetimeADelivery = harness.deliverPending();
    await blockerStarted.promise;
    journal.recreate();
    journal.seed({ type: REQUESTED, payload: { id: "from-b" } });
    releaseBlocker.resolve();

    await expect(lifetimeADelivery).rejects.toThrow(
      `stream ID changed (${TEST_STREAM_ID} -> ${RECREATED_STREAM_ID}); append rejected`,
    );
    expect(journal.rows().map((event) => [event.type, event.payload])).toEqual([
      [REQUESTED, { id: "from-b" }],
    ]);

    const lifetimeBCallback = await harness.runner.openEventBatchCallback(RECREATED_STREAM_ID);
    expect(lifetimeBCallback.checkpointOffset).toBe(0);
    await lifetimeBCallback.processEventBatch(
      eventBatch(journal.rows().slice(), 1, RECREATED_STREAM_ID),
    );
    await expect(harness.runner.snapshot()).resolves.toEqual({
      offset: 1,
      state: { count: 1, open: ["from-b"] },
    });
  });

  it("keeps recreated source lifetimes distinct when both append offset 1 to a sibling", async () => {
    const hooks: TaskHooks = {
      onProcess: (args, eventKey) => {
        args.blockProcessorWhile(() =>
          args.appendTo(SIBLING, {
            type: ECHOED,
            idempotencyKey: eventKey("echo"),
            payload: { id: args.event.payload.id },
          }),
        );
      },
    };
    const journal = makeJournal();
    journal.seed({ type: REQUESTED, payload: { id: "from-a" } });
    const harness = makeHarness({ journal, hooks });
    await harness.deliverPending();

    journal.recreate();
    journal.seed({ type: REQUESTED, payload: { id: "from-b" } });
    const lifetimeBCallback = await harness.runner.openEventBatchCallback(RECREATED_STREAM_ID);
    await lifetimeBCallback.processEventBatch(
      eventBatch(journal.rows().slice(), 1, RECREATED_STREAM_ID),
    );

    const siblingRows = journal.rows(SIBLING);
    expect(siblingRows.map((event) => event.idempotencyKey)).toEqual([
      siblingKey(`test-task/echo@${HOME}:1`),
      siblingKey(`test-task/echo@${HOME}:1`, RECREATED_STREAM_ID),
    ]);
    expect(
      siblingRows.map((event) => ({
        id: event.payload?.id,
        sourceStream: event.source?.processor?.stream,
      })),
    ).toEqual([
      {
        id: "from-a",
        sourceStream: { path: HOME, projectId: null, streamId: TEST_STREAM_ID },
      },
      {
        id: "from-b",
        sourceStream: { path: HOME, projectId: null, streamId: RECREATED_STREAM_ID },
      },
    ]);
  });
});

// =============================================================================
// 2 + 3. Strict blocker ordering; background overtaking
// =============================================================================

describe("StreamProcessorRunner side-effect ordering", () => {
  it("event N's blockProcessorWhile completes before N+1's processEvent starts", async () => {
    const log: string[] = [];
    const hooks: TaskHooks = {
      onProcess: (args) => {
        const offset = args.event.offset;
        log.push(`process:${offset}`);
        args.blockProcessorWhile(async () => {
          log.push(`block-start:${offset}`);
          await tick(); // a real async gap — ordering must survive macrotasks
          log.push(`block-end:${offset}`);
        });
      },
    };
    const harness = makeHarness({ hooks });
    for (const id of ["a", "b", "c"]) harness.journal.seed({ type: REQUESTED, payload: { id } });

    await harness.deliverBatches([harness.journal.rows().slice()]);

    expect(log).toEqual([
      "process:1",
      "block-start:1",
      "block-end:1",
      "process:2",
      "block-start:2",
      "block-end:2",
      "process:3",
      "block-start:3",
      "block-end:3",
    ]);
  });

  it("runInBackground does NOT block the next event or the batch commit", async () => {
    const log: string[] = [];
    const gate = deferred();
    const hooks: TaskHooks = {
      onProcess: (args) => {
        const offset = args.event.offset;
        log.push(`process:${offset}`);
        if (offset === 1) {
          args.runInBackground(async () => {
            await gate.promise;
            log.push("background-1-done");
          });
        }
      },
    };
    const harness = makeHarness({ hooks });
    harness.journal.seed({ type: REQUESTED, payload: { id: "a" } });
    harness.journal.seed({ type: REQUESTED, payload: { id: "b" } });

    // The batch settles (and commits durably) while the background work hangs.
    await harness.deliverBatches([harness.journal.rows().slice()]);
    expect(log).toEqual(["process:1", "process:2"]);
    expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(2);

    gate.resolve();
    await tick();
    expect(log).toContain("background-1-done");
  });
});

// =============================================================================
// 4. crash() at every boundary — at-least-once, never lost
// =============================================================================

describe("StreamProcessorRunner crash/redelivery", () => {
  /** Echo-effect hooks whose event-2 blocker can be wedged open. */
  function gatedEchoHooks(state: { gateOffset?: number; gate?: Promise<void> }): TaskHooks {
    return {
      onProcess: (args, eventKey) => {
        args.blockProcessorWhile(async () => {
          if (args.event.offset === state.gateOffset && state.gate !== undefined) {
            await state.gate;
          }
          await args.appendTo(SIBLING, {
            type: ECHOED,
            idempotencyKey: eventKey("echo"),
            payload: { id: args.event.payload.id },
          });
        });
      },
    };
  }

  it("crash mid-blocker: redelivery re-processes with at-least-once duplication only", async () => {
    const gateState: { gateOffset?: number; gate?: Promise<void> } = {
      gateOffset: 2,
      gate: deferred().promise, // never resolves — the incarnation dies owing it
    };
    const harness = makeHarness({ hooks: gatedEchoHooks(gateState) });
    for (const id of ["a", "b", "c"]) harness.journal.seed({ type: REQUESTED, payload: { id } });

    const { processEventBatch } = await harness.runner.openEventBatchCallback();
    // Deliberately un-awaited: the batch wedges on event 2's blocker and the
    // incarnation is dropped underneath it, like an eviction.
    void processEventBatch(eventBatch(harness.journal.rows().slice(), 3));
    await tick();

    // The stream-lifetime binding is durable, but no event progress landed:
    // per-batch cadence kept the wedged batch entirely retryable.
    expect(harness.store.record).toEqual(initialProgress());

    // New incarnation, gate removed (the transient hang does not recur).
    gateState.gateOffset = undefined;
    const revived = harness.crash();
    const resumeCursor = await revived.deliverPending();
    expect(resumeCursor).toBe(0); // re-opened from the persisted cursor

    expect(revived.store.record?.processing.acknowledgedThroughOffset).toBe(3);
    await expect(revived.runner.snapshot()).resolves.toEqual({
      offset: 3,
      state: { count: 3, open: ["a", "b", "c"] },
    });
    // Event 1's effect ran in BOTH incarnations (at-least-once) but the
    // idempotency key collapsed the duplicate; events 2/3 ran once.
    const committed = comparableRows(revived.journal.rows(SIBLING));
    expect(committed.map((row) => row.idempotencyKey)).toEqual([
      siblingKey("test-task/echo@/tests/runner:1"),
      siblingKey("test-task/echo@/tests/runner:2"),
      siblingKey("test-task/echo@/tests/runner:3"),
    ]);
    const echoAttempts = revived.journal.attempts.filter(({ path }) => path === SIBLING);
    expect(echoAttempts).toHaveLength(4);
    expect(echoAttempts.filter(({ deduped }) => deduped)).toHaveLength(1);
  });

  it("persist failure: cursor and in-memory state untouched, batch retryable", async () => {
    const harness = makeHarness({ hooks: gatedEchoHooks({}) });
    harness.journal.seed({ type: REQUESTED, payload: { id: "a" } });
    harness.journal.seed({ type: REQUESTED, payload: { id: "b" } });

    const { processEventBatch } = await harness.runner.openEventBatchCallback();
    // Opening first durably binds this progress row to the stream lifetime;
    // fail the EVENT-BATCH commit rather than that initial identity write.
    harness.store.failCommitOnce(new Error("KV write lost"));
    const batch = eventBatch(harness.journal.rows().slice(), 2);

    await expect(processEventBatch(batch)).rejects.toThrow("KV write lost");
    // PERSIST-BEFORE-ADVANCE: the failed durable write left the published
    // fold at its pre-batch value, so the redelivered batch re-reduces from
    // the old state instead of silently no-oping.
    expect(harness.store.record).toEqual(initialProgress());
    await expect(harness.runner.snapshot()).resolves.toEqual({
      offset: 0,
      state: { count: 0, open: [] },
    });

    await processEventBatch(batch); // the transport's retry
    expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(2);
    await expect(harness.runner.snapshot()).resolves.toEqual({
      offset: 2,
      state: { count: 2, open: ["a", "b"] },
    });
    // Effects ran in both attempts; keys collapsed them to exactly-once visible.
    expect(comparableRows(harness.journal.rows(SIBLING)).map((row) => row.idempotencyKey)).toEqual([
      siblingKey("test-task/echo@/tests/runner:1"),
      siblingKey("test-task/echo@/tests/runner:2"),
    ]);
  });

  it("crash after persist: redelivery is a silent no-op (no duplicate effects)", async () => {
    const harness = makeHarness({ hooks: gatedEchoHooks({}) });
    for (const id of ["a", "b"]) harness.journal.seed({ type: REQUESTED, payload: { id } });
    await harness.deliverBatches([harness.journal.rows().slice()]);
    expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(2);
    const attemptsBefore = harness.journal.attempts.length;

    const revived = harness.crash();
    const opened = await revived.runner.openEventBatchCallback();
    expect(opened.checkpointOffset).toBe(2);
    // The transport redelivers the same batch anyway (at-least-once).
    await opened.processEventBatch(eventBatch(revived.journal.rows().slice(), 2));

    expect(revived.journal.attempts.length).toBe(attemptsBefore); // zero re-runs
    expect(revived.store.record?.processing.acknowledgedThroughOffset).toBe(2);
  });
});

// =============================================================================
// 5. Reduce-only refold
// =============================================================================

describe("StreamProcessorRunner reduce-only refold", () => {
  it("a reducerVersion bump rebuilds state via reduce only and keeps the acknowledged cursor", async () => {
    const journal = makeJournal();
    for (const id of ["a", "b", "c"]) journal.seed({ type: REQUESTED, payload: { id } });
    journal.seed({ type: NOISE, payload: {} });
    journal.seed({ type: COMPLETED, payload: { id: "b" } });

    let effectCalls = 0;
    const hooks: TaskHooks = {
      onProcess: (args, eventKey) => {
        effectCalls += 1;
        args.blockProcessorWhile(() =>
          args.appendTo(SIBLING, {
            type: ECHOED,
            idempotencyKey: eventKey("echo"),
            payload: { id: args.event.payload.id },
          }),
        );
      },
    };
    const harness = makeHarness({ journal, hooks });
    await harness.deliverBatches([journal.rows().slice()]);
    expect(effectCalls).toBe(4);
    expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(5);
    const appendsBefore = journal.attempts.length;

    // Deploy a new reducer version. readPageSize 2 forces the rebuild to page.
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      effectCalls = 0;
      const redeployed = harness.crash({ contract: taskContract("0.0.2"), readPageSize: 2 });
      const opened = await redeployed.runner.openEventBatchCallback();

      // The PROCESSING cursor survived the cache discard...
      expect(opened.checkpointOffset).toBe(5);
      // ...the fold was rebuilt through it...
      await expect(redeployed.runner.snapshot()).resolves.toEqual({
        offset: 5,
        state: { count: 4, open: ["a", "c"] },
      });
      expect(redeployed.store.record?.reduction.reducerVersion).toBe("0.0.2");
      expect(redeployed.store.record?.processing).toEqual({
        acknowledgedThroughOffset: 5,
        cursorRevision: 0,
      });
      // ...with ZERO processEvent calls and ZERO effects.
      expect(effectCalls).toBe(0);
      expect(journal.attempts.length).toBe(appendsBefore);
      expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("refolding reduce-only"));
    } finally {
      consoleWarn.mockRestore();
    }
  });
});

// =============================================================================
// 5b. Load-time reduction/acknowledgement cursor validation (codex bug #3)
// =============================================================================

describe("StreamProcessorRunner load-time reduction catch-up", () => {
  it("rejects a recreation between refold pages without committing a mixed-lifetime fold", async () => {
    const journal = makeJournal();
    journal.seed({ type: REQUESTED, payload: { id: "a" } });
    journal.seed({ type: REQUESTED, payload: { id: "b" } });
    const store = makeProgressStore();
    const persisted: ProcessorProgress<TaskState> = {
      streamId: TEST_STREAM_ID,
      reduction: {
        reducerVersion: "0.0.1",
        reducedThroughOffset: 0,
        state: { count: 0, open: [] },
      },
      processing: { acknowledgedThroughOffset: 2, cursorRevision: 0 },
    };
    store.plant(persisted);

    // Read 1 identifies lifetime A. Read 2 returns A's first refold page and
    // recreates the path before read 3. The second page therefore belongs to
    // B and must be rejected before any staged state is published or stored.
    journal.recreateAfterPage(2);
    const harness = makeHarness({ journal, store, readPageSize: 1 });
    await expect(harness.runner.openEventBatchCallback(TEST_STREAM_ID)).rejects.toThrow(
      `stream ID changed during a read (${TEST_STREAM_ID} -> ${RECREATED_STREAM_ID})`,
    );
    expect(store.record).toEqual(persisted);
    expect(store.commits).toEqual([]);

    // A later open observes B, atomically replaces A's progress, and starts
    // from offset zero. Only B's prefix contributes to the new fold.
    journal.seed({ type: REQUESTED, payload: { id: "from-b" } });
    const reopened = await harness.runner.openEventBatchCallback(RECREATED_STREAM_ID);
    expect(reopened.checkpointOffset).toBe(0);
    expect(store.record).toEqual(initialProgress(RECREATED_STREAM_ID, 1));
    await reopened.processEventBatch(eventBatch(journal.rows().slice(), 1, RECREATED_STREAM_ID));
    await expect(harness.runner.snapshot()).resolves.toEqual({
      offset: 1,
      state: { count: 1, open: ["from-b"] },
    });
  });

  it("a persisted fold LAGGING the acknowledgement is caught up reduce-only before publishing", async () => {
    const journal = makeJournal();
    journal.seed({ type: REQUESTED, payload: { id: "a" } }); // 1
    journal.seed({ type: REQUESTED, payload: { id: "b" } }); // 2
    journal.seed({ type: COMPLETED, payload: { id: "a" } }); // 3
    const store = makeProgressStore();
    // A VALID record whose fold cache lags the acknowledgement (the persisted
    // invariant allows reduction to lag; trusting it verbatim would fold the
    // next delivery onto state missing events 2..3 and stamp it as current —
    // their contributions silently dropped forever).
    store.plant({
      streamId: TEST_STREAM_ID,
      reduction: {
        reducerVersion: "0.0.1",
        reducedThroughOffset: 1,
        state: { count: 1, open: ["a"] },
      },
      processing: { acknowledgedThroughOffset: 3, cursorRevision: 0 },
    });

    let processEventCalls = 0;
    const harness = makeHarness({
      journal,
      store,
      readPageSize: 1, // the catch-up fold must page
      hooks: { onProcess: () => void (processEventCalls += 1) },
    });

    // The gap events (2, 3) CONTRIBUTE to the published fold...
    await expect(harness.runner.snapshot()).resolves.toEqual({
      offset: 3,
      state: { count: 3, open: ["b"] },
    });
    // ...with ZERO processEvent runs (those effects are already acknowledged)...
    expect(processEventCalls).toBe(0);
    // ...and the healed cache is persisted under the same revision.
    expect(store.record).toEqual({
      streamId: TEST_STREAM_ID,
      reduction: {
        reducerVersion: "0.0.1",
        reducedThroughOffset: 3,
        state: { count: 3, open: ["b"] },
      },
      processing: { acknowledgedThroughOffset: 3, cursorRevision: 0 },
    });
  });

  it("a persisted fold AHEAD of the acknowledgement (invalid) is discarded and refolded through ack", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const journal = makeJournal();
      journal.seed({ type: REQUESTED, payload: { id: "a" } }); // 1
      journal.seed({ type: REQUESTED, payload: { id: "b" } }); // 2
      const store = makeProgressStore();
      // INVALID: the fold claims offsets whose effects were never
      // acknowledged — publishing it would show state an operator rewind is
      // entitled to re-run. The load must discard it, never publish it.
      store.plant({
        streamId: TEST_STREAM_ID,
        reduction: {
          reducerVersion: "0.0.1",
          reducedThroughOffset: 9,
          state: { count: 9, open: ["ghost"] },
        },
        processing: { acknowledgedThroughOffset: 2, cursorRevision: 0 },
      });

      let processEventCalls = 0;
      const harness = makeHarness({
        journal,
        store,
        hooks: { onProcess: () => void (processEventCalls += 1) },
      });

      await expect(harness.runner.snapshot()).resolves.toEqual({
        offset: 2,
        state: { count: 2, open: ["a", "b"] },
      });
      expect(processEventCalls).toBe(0); // reduce-only, like every refold
      expect(store.record?.reduction).toEqual({
        reducerVersion: "0.0.1",
        reducedThroughOffset: 2,
        state: { count: 2, open: ["a", "b"] },
      });
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining("AHEAD of the acknowledged cursor"),
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });
});

// =============================================================================
// 6. Monotonic progress fence (codex bug #4) — the revision CAS alone cannot
// stop a stale incarnation at the SAME revision from rolling the cursor back.
// =============================================================================

describe("StreamProcessorRunner monotonic progress fence", () => {
  const progressAt = (ack: number, cursorRevision = 0): ProcessorProgress<TaskState> => ({
    streamId: TEST_STREAM_ID,
    reduction: {
      reducerVersion: "0.0.1",
      reducedThroughOffset: ack,
      state: { count: 0, open: [] },
    },
    processing: { acknowledgedThroughOffset: ack, cursorRevision },
  });

  it("store-level: a same-revision backward commit throws; a revision-bump rewind is allowed", () => {
    const store = makeProgressStore();
    store.store.commit(progressAt(10), {
      expectedCursorRevision: 0,
      expectedStreamId: undefined,
    });

    // Same revision, acked moving backward: a stale incarnation — fenced.
    expect(() =>
      store.store.commit(progressAt(4), {
        expectedCursorRevision: 0,
        expectedStreamId: TEST_STREAM_ID,
      }),
    ).toThrow(/backward.*without a cursorRevision bump/);
    expect(store.record).toEqual(progressAt(10)); // the fenced commit wrote nothing

    // A rewind lands under the OLD revision and writes the bumped one (the
    // browser projection reset's shape) — the ONLY sanctioned backward move.
    store.store.commit(progressAt(4, 1), {
      expectedCursorRevision: 0,
      expectedStreamId: TEST_STREAM_ID,
    });
    expect(store.record).toEqual(progressAt(4, 1));
  });

  it("a stale incarnation's same-revision commit cannot roll acknowledgement back past a newer one", async () => {
    const journal = makeJournal();
    for (const id of ["a", "b"]) journal.seed({ type: REQUESTED, payload: { id } });

    // Incarnation A: wedges on event 1's blocker BEFORE any durable commit,
    // holding a single-event batch whose batch-end commit will later try to
    // land acked=1.
    const gate = deferred();
    const a = makeHarness({
      journal,
      hooks: {
        onProcess: (args) => {
          if (args.event.offset === 1) args.blockProcessorWhile(() => gate.promise);
        },
      },
    });
    const { processEventBatch } = await a.runner.openEventBatchCallback();
    const batchA = processEventBatch(eventBatch(journal.rows().slice(0, 1), 2));
    await tick();
    expect(a.store.record).toEqual(initialProgress());

    // Incarnation B processes through offset 2 at the SAME revision.
    const b = a.crash({ hooks: {} });
    await b.deliverPending();
    expect(b.store.record?.processing).toEqual({ acknowledgedThroughOffset: 2, cursorRevision: 0 });

    // A resumes: its commit of acked=1 matches the persisted revision (0),
    // so the revision CAS alone would ACCEPT it and roll durable
    // acknowledgement and state backward — the monotonic fence rejects it.
    gate.resolve();
    await expect(batchA).rejects.toThrow(/backward/);
    expect(b.store.record?.processing).toEqual({ acknowledgedThroughOffset: 2, cursorRevision: 0 });
  });
});

// =============================================================================
// 7. Caught-up processing (`delivery.caughtUp`) — fires on the LAST CONSUMED event
//    of a batch whose scan reaches the observed stream maximum offset. If that batch
//    consumes nothing, one eventless pass reconciles the same final fold.
// =============================================================================

describe("StreamProcessorRunner caught-up processing (delivery.caughtUp)", () => {
  it("fires on the last consumed event of a caught-up batch; an unconsumed tail at head fires the event-less pass", async () => {
    const journal = makeJournal();
    journal.seed({ type: REQUESTED, payload: { id: "a" } }); // 1: opens the obligation
    journal.seed({ type: NOISE, payload: {} }); // 2: unconsumed, reaches head

    const headCalls: { open: string[]; event: number | null }[] = [];
    const hooks: TaskHooks = {
      onHead: (args, stableKey) => {
        headCalls.push({ open: [...args.state.open], event: args.event?.offset ?? null });
        for (const id of args.state.open) {
          args.blockProcessorWhile(() =>
            args.appendTo(SIBLING, {
              type: DRIVEN,
              idempotencyKey: stableKey(`drive:${id}`),
              payload: { id },
            }),
          );
        }
      },
    };
    const harness = makeHarness({ journal, hooks });
    const { processEventBatch } = await harness.runner.openEventBatchCallback();
    const [requestedEvent] = journal.rows();

    // Batch 1: the requested event, delivered mid-catch-up (head is at 2). It
    // is behind head, so NOT caughtUp — nothing may act on a partial fold.
    await processEventBatch(eventBatch([requestedEvent!], 2));
    expect(headCalls).toEqual([]);
    expect(journal.rows(SIBLING)).toHaveLength(0);

    // Batch 2 proves the filter scanned offset 2 but omits its unconsumed
    // event. The batch reaches head but no consumed event carries `caughtUp`.
    // The runner fires the EVENT-LESS caught-up call (event=null), and the
    // obligation opened by event 1 drives instead of stranding on a quiet
    // stream.
    await processEventBatch({
      streamId: TEST_STREAM_ID,
      events: [],
      scannedAfterOffset: 1,
      scannedThroughOffset: 2,
      streamMaxOffset: 2,
    });
    expect(headCalls).toEqual([{ open: ["a"], event: null }]); // event-less pass drove it
    expect(comparableRows(journal.rows(SIBLING))).toEqual([
      { type: DRIVEN, idempotencyKey: siblingKey("test-task/drive:a"), payload: { id: "a" } },
    ]);

    // A later CONSUMED event reaches head: the reconcile runs again over the
    // final fold; drive:a dedupes on its stable key, drive:b is new.
    journal.seed({ type: REQUESTED, payload: { id: "b" } }); // 3: consumed, at head
    await processEventBatch(eventBatch([journal.rows()[2]!], 3));
    expect(headCalls).toEqual([
      { open: ["a"], event: null },
      { open: ["a", "b"], event: 3 },
    ]);
    expect(comparableRows(journal.rows(SIBLING))).toEqual([
      { type: DRIVEN, idempotencyKey: siblingKey("test-task/drive:a"), payload: { id: "a" } },
      { type: DRIVEN, idempotencyKey: siblingKey("test-task/drive:b"), payload: { id: "b" } },
    ]);
  });

  it("fires caughtUp for a wildcard (`*`) consumer — every delivered event counts as consumed", async () => {
    const journal = makeJournal();
    journal.seed({ type: REQUESTED, payload: { id: "a" } }); // 1: consumed, opens obligation
    journal.seed({ type: NOISE, payload: {} }); // 2: a `*` consumer DOES consume this — it is head

    const headCalls: string[][] = [];
    const hooks: TaskHooks = {
      onHead: (args) => {
        headCalls.push([...args.state.open]);
      },
    };
    // A `*` contract reduces every type; the head event (NOISE) is one it
    // consumes, so it is the last consumed event of a caught-up batch and
    // MUST carry caughtUp. Before the wildcard fix, `consumes.has("NOISE")`
    // was false and caughtUp never fired for `*` processors.
    const harness = makeHarness({ journal, hooks, contract: taskContract("0.0.1", ["*"]) });
    await harness.deliverBatches([journal.rows().slice()]);
    expect(headCalls).toEqual([["a"]]);
  });

  it("commits only after onCaughtUp's blocking work: a failing caught-up blocker leaves the batch UNcommitted and retried (codex bug #2)", async () => {
    const journal = makeJournal();
    journal.seed({ type: REQUESTED, payload: { id: "a" } }); // 1
    journal.seed({ type: REQUESTED, payload: { id: "b" } }); // 2 — the head event

    let headAttempts = 0;
    const processedOffsets: number[] = [];
    const hooks: TaskHooks = {
      onProcess: (args) => void processedOffsets.push(args.event.offset),
      onHead: (args, stableKey) => {
        headAttempts += 1;
        if (headAttempts === 1) {
          // The caught-up call's own blocking work fails (or the incarnation
          // dies mid-blocker — same durable outcome).
          args.blockProcessorWhile(() => Promise.reject(new Error("caught-up work failed")));
          return;
        }
        args.blockProcessorWhile(() =>
          args.appendTo(SIBLING, {
            type: DRIVEN,
            idempotencyKey: stableKey("drive:a"),
            payload: { id: "a" },
          }),
        );
      },
    };
    // The bug this pins out: if the head event's acknowledgement could land
    // BEFORE onCaughtUp's blocking work settled, a failed caught-up blocker
    // would leave redelivery with zero pending events and the caught-up work
    // lost forever. The batch-end-only commit runs after EVERY event's
    // blocking work — the caught-up processing's included — so the failed pass
    // leaves the whole batch uncommitted and retryable.
    const harness = makeHarness({ journal, hooks });

    const { processEventBatch } = await harness.runner.openEventBatchCallback();
    const batch = eventBatch(journal.rows().slice(), 2);
    await expect(processEventBatch(batch)).rejects.toThrow("caught-up work failed");

    // Only the stream-lifetime binding is committed; the head event and its
    // caught-up call both stay retryable.
    expect(harness.store.record).toEqual(initialProgress());
    await expect(harness.runner.snapshot()).resolves.toEqual({
      offset: 0,
      state: { count: 0, open: [] },
    });

    // The transport's redelivery re-runs the batch AND the caught-up call.
    await processEventBatch(batch);
    expect(processedOffsets).toEqual([1, 2, 1, 2]); // at-least-once on the uncommitted batch
    expect(headAttempts).toBe(2);
    expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(2);
    expect(comparableRows(journal.rows(SIBLING))).toEqual([
      { type: DRIVEN, idempotencyKey: siblingKey("test-task/drive:a"), payload: { id: "a" } },
    ]);
  });

  it("fires the reconcile via the EVENT-LESS caught-up call when the head is an unconsumed tail (self-pull)", async () => {
    const journal = makeJournal();
    journal.seed({ type: REQUESTED, payload: { id: "a" } }); // 1 — consumed, opens the obligation
    journal.seed({ type: NOISE, payload: {} }); // 2 — unconsumed durable tail at maximum raw offset

    const headCalls: { open: string[]; event: number | null }[] = [];
    const hooks: TaskHooks = {
      onHead: (args, stableKey) => {
        // args.event is NULL here — this is the event-less caught-up call.
        headCalls.push({ open: [...args.state.open], event: args.event?.offset ?? null });
        for (const id of args.state.open) {
          args.blockProcessorWhile(() =>
            args.appendTo(SIBLING, {
              type: DRIVEN,
              idempotencyKey: stableKey(`drive:${id}`),
              payload: { id },
            }),
          );
        }
      },
    };
    const harness = makeHarness({ journal, hooks });

    // The production hosted-processor batch's exact shape: ONLY the consumed event 1 is
    // delivered, stamped with the maximum raw offset 2. The trailing type-unfiltered
    // self-pull folds the unconsumed tail so the cursor reaches head — and the
    // batch reaches head with NO consumed event, so the runner fires the
    // EVENT-LESS caught-up call and the obligation drives. This is the exact
    // late-agent preview failure: the requested script stayed open forever
    // after unrelated presence facts occupied the raw tail.
    await harness.deliverConsumesFilteredPending();
    await vi.waitFor(() => {
      expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(2);
      expect(headCalls).toEqual([{ open: ["a"], event: null }]);
    });
    expect(comparableRows(journal.rows(SIBLING))).toEqual([
      { type: DRIVEN, idempotencyKey: siblingKey("test-task/drive:a"), payload: { id: "a" } },
    ]);
    await expect(harness.runner.snapshot()).resolves.toEqual({
      offset: 2,
      state: { count: 1, open: ["a"] },
    });
  });

  it("lets a scan-owning source advance a filtered gap without an unfiltered self-pull", async () => {
    const journal = makeJournal();
    const requested = journal.seed({ type: REQUESTED, payload: { id: "a" } });
    journal.seed({ type: NOISE, payload: {} });

    const headCalls: { open: string[]; event: number | null }[] = [];
    const harness = makeHarness({
      journal,
      hooks: {
        onHead: (args) => {
          headCalls.push({ open: [...args.state.open], event: args.event?.offset ?? null });
        },
      },
    });
    const { processEventBatch } = await harness.runner.openEventBatchCallback(undefined, {
      sourceScansAllEvents: true,
    });

    await processEventBatch({
      streamId: TEST_STREAM_ID,
      events: [requested],
      scannedAfterOffset: 0,
      scannedThroughOffset: 1,
      streamMaxOffset: 2,
    });
    await tick();

    // The runner has not read the raw NOISE row behind the configured source
    // filter. It waits for the source's explicit scan-progress frame.
    expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(1);
    expect(headCalls).toEqual([]);

    await processEventBatch({
      streamId: TEST_STREAM_ID,
      events: [],
      scannedAfterOffset: 1,
      scannedThroughOffset: 2,
      streamMaxOffset: 2,
    });
    expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(2);
    expect(headCalls).toEqual([{ open: ["a"], event: null }]);
  });

  it("runs blockProcessorWhile registrations in strict FIFO order — fold-derived work lands after per-event work", async () => {
    // The head event registers TWO blockers in one `processEvent` body: a
    // per-event append first, a fold-derived append second. Registration
    // order MUST be journal order — the guarantee that lets e.g. an
    // interrupt cancel fold before a fold-derived re-fire. This ordering
    // used to need a separate deferred callback (`blockProcessorWhileCaughtUp`,
    // deleted); FIFO chaining makes it structural.
    const journal = makeJournal();
    journal.seed({ type: REQUESTED, payload: { id: "a" } }); // 1 — consumed, at head

    const hooks: TaskHooks = {
      onProcess: (args) => {
        args.blockProcessorWhile(() =>
          args.appendTo(SIBLING, {
            type: ECHOED,
            idempotencyKey: "test-task/per-event",
            payload: { id: "per-event" },
          }),
        );
      },
      onHead: (args) => {
        args.blockProcessorWhile(() =>
          args.appendTo(SIBLING, {
            type: DRIVEN,
            idempotencyKey: "test-task/caught-up",
            payload: { id: "caught-up" },
          }),
        );
      },
    };
    const harness = makeHarness({ journal, hooks });
    await harness.deliverBatches([journal.rows().slice()]);

    // Journal order proves the sequencing: per-event FIRST, caught-up SECOND.
    expect(journal.rows(SIBLING).map((row) => row.type)).toEqual([ECHOED, DRIVEN]);
  });
});

// =============================================================================
// Malformed consumed events (stream-processor.ts:592-616 semantics, exactly)
// =============================================================================

describe("StreamProcessorRunner parse-failure handling", () => {
  it("advances past a malformed consumed event, records it AFTER the commit, in the background", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const journal = makeJournal();
      journal.seed({ type: REQUESTED, payload: { id: "a" } }); // 1
      journal.seed({ type: REQUESTED, payload: { id: 42 } }); // 2 — malformed
      journal.seed({ type: REQUESTED, payload: { id: "c" } }); // 3

      const harness = makeHarness({ journal });
      await harness.deliverBatches([journal.rows().slice()]);

      // The cursor never wedges on the malformed fact; the fold skips it.
      expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(3);
      await expect(harness.runner.snapshot()).resolves.toEqual({
        offset: 3,
        state: { count: 2, open: ["a", "c"] },
      });

      // The diagnostic lands post-commit with the LEGACY key shape.
      await vi.waitFor(() => {
        const diagnostics = journal
          .rows()
          .filter((row) => row.type === "events.iterate.com/stream/error-occurred");
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.idempotencyKey).toBe("test-task/event-parse-failed@/tests/runner:2");
        expect(diagnostics[0]!.source?.processor).toMatchObject({
          slug: "test-task",
          whileProcessing: { offset: 2, type: REQUESTED },
        });
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a failing diagnostic append is logged and never fails the committed batch again", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const journal = makeJournal();
      journal.seed({ type: REQUESTED, payload: { id: 42 } }); // malformed only

      const harness = makeHarness({ journal });
      journal.failNextAppendTo(HOME, new Error("append transport down"));
      await harness.deliverBatches([journal.rows().slice()]);
      await tick();

      // The skip committed even though recording it failed.
      expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(1);
      expect(
        journal.rows().filter((row) => row.type === "events.iterate.com/stream/error-occurred"),
      ).toHaveLength(0);
      expect(consoleError).toHaveBeenCalledWith(
        "stream processor runner background work failed",
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a delayed lifetime-A diagnostic is rejected after the stream is recreated as B", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const journal = makeJournal();
      journal.seed({ type: REQUESTED, payload: { id: 42 } });
      const releaseAppend = journal.pauseGuardedAppends();
      const harness = makeHarness({ journal });

      await harness.deliverBatches([journal.rows().slice()]);
      expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(1);

      journal.recreate();
      releaseAppend();
      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          "stream processor runner background work failed",
          expect.objectContaining({ message: expect.stringContaining("append rejected") }),
        );
      });
      expect(journal.rows()).toEqual([]);
      expect(journal.attempts).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a malformed consumed event at head does NOT steal caughtUp from the last good event", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const journal = makeJournal();
      journal.seed({ type: REQUESTED, payload: { id: "a" } }); // 1 — good, opens obligation
      journal.seed({ type: REQUESTED, payload: { id: 42 } }); // 2 — malformed, at maximum raw offset

      const headCalls: string[][] = [];
      const hooks: TaskHooks = {
        onHead: (args, stableKey) => {
          headCalls.push([...args.state.open]);
          for (const id of args.state.open) {
            args.blockProcessorWhile(() =>
              args.appendTo(SIBLING, {
                type: DRIVEN,
                idempotencyKey: stableKey(`drive:${id}`),
                payload: { id },
              }),
            );
          }
        },
      };
      const harness = makeHarness({ journal, hooks });
      // Head is offset 2 (the malformed event). The last DELIVERED event is
      // offset 1 (the good one) — it must carry caughtUp so the obligation
      // drives, rather than being stranded because offset 2 stole the flag.
      await harness.deliverBatches([journal.rows().slice()]);
      await tick();

      expect(headCalls).toEqual([["a"]]);
      expect(comparableRows(journal.rows(SIBLING))).toEqual([
        { type: DRIVEN, idempotencyKey: siblingKey("test-task/drive:a"), payload: { id: "a" } },
      ]);
      // Both offsets committed (the malformed one skipped-not-wedged).
      expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(2);
    } finally {
      consoleError.mockRestore();
    }
  });
});

// =============================================================================
// waitUntilEvent (acknowledged-through semantics)
// =============================================================================

describe("StreamProcessorRunner.waitUntilEvent", () => {
  it("offset form resolves once the acknowledged cursor covers it; predicate form on future deliveries", async () => {
    const harness = makeHarness();
    harness.journal.seed({ type: REQUESTED, payload: { id: "a" } });

    const pendingOffset = harness.runner.waitUntilEvent({ offset: 1 });
    const pendingPredicate = harness.runner.waitUntilEvent({
      predicate: (event) => event.type === REQUESTED,
    });
    await harness.deliverBatches([harness.journal.rows().slice()]);
    await expect(pendingOffset).resolves.toBeUndefined();
    await expect(pendingPredicate).resolves.toBeUndefined();

    // Already-acknowledged offsets short-circuit.
    await expect(harness.runner.waitUntilEvent({ offset: 1 })).resolves.toBeUndefined();
    // Timeouts reject.
    await expect(harness.runner.waitUntilEvent({ offset: 99, timeoutMs: 5 })).rejects.toThrow(
      /timed out/,
    );
  });

  it("offset form reaches an already-appended event by SELF-PULL — read-your-writes never depends on push delivery", async () => {
    const harness = makeHarness();
    // Read-your-writes: the event is already on the stream, but NO delivery is
    // scheduled — the harness never opens a processEventBatch, so nothing pushes a batch.
    // The wait must reach the event by pulling the journal itself; waiting for
    // a push that never comes hangs until the bounded timeout (the pre-fix
    // behavior this test pins out).
    const committed = harness.journal.seed({ type: REQUESTED, payload: { id: "ryw" } });
    await expect(
      harness.runner.waitUntilEvent({ offset: committed.offset, timeoutMs: 500 }),
    ).resolves.toBeUndefined();
    // The self-pull is ordinary drive: the committed fold reflects the event.
    const snapshot = await harness.runner.snapshot();
    expect(snapshot.offset).toBe(committed.offset);
    expect(snapshot.state.open).toContain("ryw");
    expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(committed.offset);
  });

  it("offset form rejects a failed self-pull promptly instead of parking until its timeout", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    try {
      const harness = makeHarness();
      const storageReset = new Error(
        "Internal error while starting up Durable Object storage caused object to be reset",
      );
      harness.journal.failNextReadWith(storageReset);

      const waiting = harness.runner.waitUntilEvent({
        offset: 8,
        timeoutMs: 75_000,
        signal: controller.signal,
      });
      const outcome = await Promise.race([
        waiting.then(
          () => ({ status: "resolved" as const }),
          (error: unknown) => ({ error, status: "rejected" as const }),
        ),
        tick().then(() => ({ status: "still-parked" as const })),
      ]);

      // Always settle the old implementation's parked promise so a red test
      // leaves neither a timer nor an unhandled rejection behind.
      controller.abort();
      await waiting.catch(() => undefined);

      expect(outcome).toEqual({ error: storageReset, status: "rejected" });
    } finally {
      controller.abort();
      consoleError.mockRestore();
    }
  });

  it("offset form's timeout bounds a silently orphaned self-pull", async () => {
    const harness = makeHarness();
    harness.journal.hangNextRead();

    await expect(
      harness.runner.waitUntilEvent({
        offset: 8,
        timeoutMs: 20,
      }),
    ).rejects.toThrow("waitUntilEvent timed out after 20ms");
  });
});

// =============================================================================
// Recovery wiring (ProcessorKeepalive reused wholesale)
// =============================================================================

describe("StreamProcessorRunner recovery wiring", () => {
  function makeRecoveryFixture(journal: Journal) {
    const clock = { now: Date.parse("2026-07-14T12:00:00Z") };
    // Only the KV record and the journal survive an eviction; the keepalive's
    // in-memory flags do not. Each incarnation therefore BUILDS a fresh
    // ProcessorKeepalive over the shared record — exactly what the production
    // registry does with DO KV.
    const kv: { record: KeepaliveRecord | undefined } = { record: undefined };
    const revivals: KeepaliveRecord[] = [];
    const appendRevived = () => void journal.seed({ type: REVIVED, payload: {} });
    const build = (): ProcessorRecovery => {
      const recovery: ProcessorRecovery = {
        keepAliveWhile: (work) => keepalive.track(work()),
        handleAlarm: async () => {
          await keepalive.onAlarm();
        },
      };
      const keepalive = new ProcessorKeepalive({
        now: () => clock.now,
        readRecord: () => kv.record,
        writeRecord: (record) => {
          kv.record = record;
        },
        armAlarm: () => {},
        keepAlive: (work) => {
          void work.catch(() => undefined);
        },
        revive: async (record) => {
          revivals.push(record);
          appendRevived();
        },
        appendFact: () => {},
        version: "v1",
      });
      return recovery;
    };
    return { clock, kv, revivals, appendRevived, build };
  }

  it("recovery needs no revived consumption: construction succeeds and the fact gives an eventless at-head turn", async () => {
    const streamFixture = makeJournal();
    const recoveryFixture = makeRecoveryFixture(streamFixture);
    const recovery = recoveryFixture.build();
    const noRevivedContract = defineProcessorContract({
      slug: "test-no-revived",
      version: "0.0.1",
      description: "A recovery-wired contract that does not react to revival facts.",
      stateSchema: z.object({ count: z.number().default(0) }),
      events: { [REQUESTED]: { payloadSchema: z.object({ id: z.string() }) } },
      consumes: [REQUESTED],
      emits: [],
    });
    const headTurns: { eventType: string | null; count: number }[] = [];
    const processor = new (class extends StreamProcessor<typeof noRevivedContract> {
      readonly contract = noRevivedContract;

      protected override reduce({
        state,
      }: Parameters<StreamProcessor<typeof noRevivedContract>["reduce"]>[0]) {
        return { count: state.count + 1 };
      }

      protected override processEvent(
        args: Parameters<StreamProcessor<typeof noRevivedContract>["processEvent"]>[0],
      ) {
        if (args.delivery.caughtUp) {
          headTurns.push({ eventType: args.event?.type ?? null, count: args.state.count });
        }
        return undefined;
      }
    })({
      stream: streamFixture.stream,
      path: streamFixture.homePath,
      projectId: null,
    });
    const runner = new StreamProcessorRunner({
      processor,
      stream: streamFixture.stream,
      durability: { progress: makeProgressStore().store as never, recovery },
    });

    streamFixture.seed({ type: REQUESTED, payload: { id: "open" } });
    await runner.catchUp();
    recoveryFixture.appendRevived();
    await runner.catchUp();

    expect(headTurns).toEqual([
      { eventType: REQUESTED, count: 1 },
      { eventType: null, count: 1 },
    ]);
  });

  it("blocking, background, AND whole-batch work ride the keepalive; a quiet-clean alarm disarms", async () => {
    const journal = makeJournal();
    journal.seed({ type: REQUESTED, payload: { id: "a" } });
    const fixture = makeRecoveryFixture(journal);

    const background = deferred();
    const hooks: TaskHooks = {
      onProcess: (args) => {
        args.blockProcessorWhile(() => tick());
        args.runInBackground(() => background.promise);
      },
    };
    const harness = makeHarness({ journal, hooks, recovery: fixture.build() });
    await harness.deliverBatches([journal.rows().slice()]);

    // The batch is done but background work is still owed: the durable alarm
    // stays armed — "died owing work" must equal "alarm armed".
    expect(fixture.kv.record?.armedAtMs).not.toBeNull();
    fixture.clock.now = fixture.kv.record!.armedAtMs! + 1;
    await harness.runner.handleAlarm();
    expect(fixture.kv.record?.armedAtMs).not.toBeNull(); // busy_rearmed, not disarmed

    background.resolve();
    await tick();
    fixture.clock.now = fixture.kv.record!.armedAtMs! + 1;
    await harness.runner.handleAlarm(); // quiet-clean confirmation
    expect(fixture.kv.record?.armedAtMs).toBeNull();
    expect(fixture.revivals).toHaveLength(0);
  });

  it("an incarnation that dies owing work is revived through the alarm, and the revived fact reaches the fold", async () => {
    const journal = makeJournal();
    journal.seed({ type: REQUESTED, payload: { id: "a" } });
    const fixture = makeRecoveryFixture(journal);

    const wedgedForever = deferred();
    const hooks: TaskHooks = {
      onProcess: (args) => {
        args.runInBackground(() => wedgedForever.promise);
      },
    };
    const harness = makeHarness({ journal, hooks, recovery: fixture.build() });
    await harness.deliverBatches([journal.rows().slice()]);
    expect(fixture.kv.record?.armedAtMs).not.toBeNull();

    // The incarnation dies owing the background attempt. A fresh one boots
    // with a FRESH keepalive whose in-memory flags know nothing — exactly the
    // revival case. The durable alarm fires in the fresh incarnation:
    const headCalls: TaskState[] = [];
    const revived = harness.crash({
      hooks: { onHead: (args) => void headCalls.push(structuredClone(args.state)) },
      recovery: fixture.build(),
    });
    fixture.clock.now = fixture.kv.record!.armedAtMs! + 1;
    await revived.runner.handleAlarm();

    // The revival pass appended the journaled fact...
    expect(fixture.revivals).toHaveLength(1);
    const revivedEvent = journal.rows().find((row) => row.type === REVIVED);
    expect(revivedEvent).toBeDefined();
    // ...whose ordinary delivery turn gives the processor its caught-up call —
    // where an obligation processor would settle what the dead incarnation
    // left behind. (The registry that auto-pulls after revival is a later
    // slice; here the transport's redelivery plays that part.)
    await revived.deliverPending();
    expect(headCalls).toEqual([{ count: 1, open: ["a"] }]);
  });
});
