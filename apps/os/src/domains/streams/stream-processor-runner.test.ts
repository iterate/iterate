// The in-memory executable spec for StreamProcessorRunner (slice 3 of
// docs/stream-processor-runner-redesign.md). Every invariant the redesign
// promises is pinned here against a plain in-memory journal, progress store,
// and virtual clock — the same harness style as stream-processor-keepalive.test.ts.
//
// The invariants under test:
//  1. batch-division invariance (one frame / singletons / random partitions)
//  2. strict per-event blockProcessorWhile ordering
//  3. runInBackground overtaking
//  4. crash() at every boundary → at-least-once, never lost work
//  5. reduce-only refold (reducerVersion bump: reduce yes, processEvent no)
//  6. stale-incarnation commits rejected by the monotonic progress fence
//  7. onCaughtUp at head, including the requested-N / unconsumed-N+1 wedge

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StreamEvent, StreamEventInput } from "iterate/processors";
import { defineProcessorContract } from "iterate/processors";
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
    emits: [ECHOED, DRIVEN, COMPLETED],
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
 * for those (never the event-less at-head pass). */
type ConsumedProcessArgs = ProcessArgs & { event: NonNullable<ProcessArgs["event"]> };
type TaskHooks = {
  /** `eventKey` is `this.idempotencyKey(key, event)` — the per-event effect
   * key a real processor mints for deterministic-consequence appends, so a
   * redelivered frame dedupes instead of double-appending. */
  onProcess?: (args: ConsumedProcessArgs, eventKey: (key: string) => string) => void;
  /** The at-head reconcile: `processEvent` under `delivery.caughtUp`. `args.event`
   * is the last consumed event of a head-reaching batch, or `null` for the
   * event-less at-head pass. `stableKey` is `this.idempotencyKey` (binds NO
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
    // The at-head reconcile: fires for the last consumed event of a
    // head-reaching batch OR the runner's event-less at-head pass (args.event
    // null). onHead registers its blocking work synchronously (the runner
    // awaits it before the frame-end commit).
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

function makeJournal(
  homePath = HOME,
  options: {
    /** Freeze each pager's rows at readEvents() time, like a snapshotting
     * remote page source. Used to prove a coalesced later target gets a
     * trailing pass rather than sharing an older read blindly. */
    snapshotReadSessions?: boolean;
    onReadSession?: (session: number) => void;
  } = {},
) {
  const rowsByPath = new Map<string, StreamEvent[]>();
  /** EVERY append attempt, deduped or not — the at-least-once evidence. */
  const attempts: { path: string; event: StreamEventInput; deduped: boolean }[] = [];
  const failNext = new Map<string, Error>();
  let createdAtClock = 0;
  let readSessionCount = 0;

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
      at: (child: string) => streamAt(child),
      readEvents: (args?: {
        afterOffset?: number;
        beforeOffset?: number | null;
        limit?: number;
      }) => {
        readSessionCount += 1;
        const rowsAtOpen = options.snapshotReadSessions ? [...rowsFor(path)] : undefined;
        options.onReadSession?.(readSessionCount);
        let cursor = args?.afterOffset ?? 0;
        const limit = args?.limit ?? 500;
        return {
          next: () => {
            const page = (rowsAtOpen ?? rowsFor(path))
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
    readSessionCount: () => readSessionCount,
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
      const persistedRevision = record?.processing.cursorRevision ?? 0;
      if (opts.expectedCursorRevision !== persistedRevision) {
        throw new Error(
          `progress commit fenced: expected cursorRevision ${opts.expectedCursorRevision}, ` +
            `persisted ${persistedRevision}`,
        );
      }
      // MONOTONIC fence (mirrors durableObjectProgressStore): a same-revision
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

function deliveryFrame(events: StreamEvent[], streamMaxOffset: number) {
  const scannedAfterOffset =
    events[0]?.offset === undefined ? streamMaxOffset : events[0].offset - 1;
  return {
    events,
    scannedAfterOffset,
    scannedThroughOffset: events.at(-1)?.offset ?? scannedAfterOffset,
    streamMaxOffset,
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
    /** Deliver explicit frames through one opened sink. */
    async deliverFrames(frames: StreamEvent[][], streamMaxOffset?: number) {
      const { sink } = await runner.openDelivery();
      const head = streamMaxOffset ?? journal.head();
      for (const events of frames) {
        await sink(deliveryFrame(events, head));
      }
    },
    /** Open delivery and push everything past the persisted cursor as ONE frame. */
    async deliverPending() {
      const opened = await runner.openDelivery();
      const events = journal.rows().filter((row) => row.offset > opened.checkpointOffset);
      if (events.length > 0) {
        await opened.sink(deliveryFrame(events, journal.head()));
      }
      return opened.checkpointOffset;
    },
    /** The PRODUCTION wake lane's exact shape (stream-processor-host.ts:522):
     * only CONSUMED types are delivered, but the frame is stamped with the
     * RAW journal head — an unconsumed durable tail leaves the frame behind
     * `streamMaxOffset` with nothing else ever delivering the difference. */
    async deliverConsumesFilteredPending() {
      const opened = await runner.openDelivery();
      const consumed = new Set<string>(contract.consumes);
      const events = journal
        .rows()
        .filter((row) => row.offset > opened.checkpointOffset && consumed.has(row.type));
      if (events.length > 0) {
        await opened.sink(deliveryFrame(events, journal.head()));
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

  /** Effect-per-event + obligation-drive-at-head hooks (all onto the sibling). */
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
      await harness.deliverFrames(split(journal.rows().slice()));
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

  it("one frame, singletons, and random partitions yield identical state AND appends", async () => {
    const oneFrame = await runWithPartition((rows) => [rows]);

    expect(oneFrame.snapshot).toEqual({
      offset: 8,
      state: { count: 5, open: ["c"] },
    });
    expect(oneFrame.acknowledged).toBe(8);
    // 5 parsed consumed events echo; the open obligation is driven at head.
    expect(oneFrame.sibling).toEqual([
      { type: ECHOED, idempotencyKey: "test-task/echo@/tests/runner:1", payload: { id: "a" } },
      { type: ECHOED, idempotencyKey: "test-task/echo@/tests/runner:2", payload: { id: "b" } },
      { type: ECHOED, idempotencyKey: "test-task/echo@/tests/runner:4", payload: { id: "a" } },
      { type: ECHOED, idempotencyKey: "test-task/echo@/tests/runner:6", payload: { id: "c" } },
      { type: ECHOED, idempotencyKey: "test-task/echo@/tests/runner:8", payload: { id: "b" } },
      { type: DRIVEN, idempotencyKey: "test-task/drive:c", payload: { id: "c" } },
    ]);

    const singletons = await runWithPartition((rows) => rows.map((row) => [row]));
    expect(singletons).toEqual(oneFrame);

    for (const seed of [1, 7, 42]) {
      const partitioned = await runWithPartition((rows) => randomPartition(rows, seed));
      expect(partitioned).toEqual(oneFrame);
    }
  });
});

describe("StreamProcessorRunner delivery coordinates", () => {
  it("rejects a frame whose scan starts beyond the committed cursor", async () => {
    const harness = makeHarness();
    harness.journal.seed({ type: REQUESTED, payload: { id: "a" } });
    harness.journal.seed({ type: REQUESTED, payload: { id: "b" } });
    const opened = await harness.runner.openDelivery();

    await expect(
      opened.sink({
        events: [harness.journal.rows()[1]!],
        scannedAfterOffset: 1,
        scannedThroughOffset: 2,
        streamMaxOffset: 2,
      }),
    ).rejects.toThrow(/starts after the committed scan cursor: 1 > 0/);
    expect(harness.store.record?.processing.acknowledgedThroughOffset ?? 0).toBe(0);
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

    await harness.deliverFrames([harness.journal.rows().slice()]);

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

  it("runInBackground does NOT block the next event or the frame commit", async () => {
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

    // The frame settles (and commits durably) while the background work hangs.
    await harness.deliverFrames([harness.journal.rows().slice()]);
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

    const { sink } = await harness.runner.openDelivery();
    // Deliberately un-awaited: the frame wedges on event 2's blocker and the
    // incarnation is dropped underneath it, like an eviction.
    void sink(deliveryFrame(harness.journal.rows().slice(), 3));
    await tick();

    // Nothing durable happened: per-frame cadence, frame never completed.
    expect(harness.store.record).toBeUndefined();

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
      "test-task/echo@/tests/runner:1",
      "test-task/echo@/tests/runner:2",
      "test-task/echo@/tests/runner:3",
    ]);
    const echoAttempts = revived.journal.attempts.filter(({ path }) => path === SIBLING);
    expect(echoAttempts).toHaveLength(4);
    expect(echoAttempts.filter(({ deduped }) => deduped)).toHaveLength(1);
  });

  it("persist failure: cursor and in-memory state untouched, frame retryable", async () => {
    const harness = makeHarness({ hooks: gatedEchoHooks({}) });
    harness.journal.seed({ type: REQUESTED, payload: { id: "a" } });
    harness.journal.seed({ type: REQUESTED, payload: { id: "b" } });

    harness.store.failCommitOnce(new Error("KV write lost"));
    const { sink } = await harness.runner.openDelivery();
    const frame = deliveryFrame(harness.journal.rows().slice(), 2);

    await expect(sink(frame)).rejects.toThrow("KV write lost");
    // PERSIST-BEFORE-ADVANCE: the failed durable write left the published
    // fold at its pre-frame value, so the redelivered frame re-reduces from
    // the old state instead of silently no-oping.
    expect(harness.store.record).toBeUndefined();
    await expect(harness.runner.snapshot()).resolves.toEqual({
      offset: 0,
      state: { count: 0, open: [] },
    });

    await sink(frame); // the transport's retry
    expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(2);
    await expect(harness.runner.snapshot()).resolves.toEqual({
      offset: 2,
      state: { count: 2, open: ["a", "b"] },
    });
    // Effects ran in both attempts; keys collapsed them to exactly-once visible.
    expect(comparableRows(harness.journal.rows(SIBLING)).map((row) => row.idempotencyKey)).toEqual([
      "test-task/echo@/tests/runner:1",
      "test-task/echo@/tests/runner:2",
    ]);
  });

  it("crash after persist: redelivery is a silent no-op (no duplicate effects)", async () => {
    const harness = makeHarness({ hooks: gatedEchoHooks({}) });
    for (const id of ["a", "b"]) harness.journal.seed({ type: REQUESTED, payload: { id } });
    await harness.deliverFrames([harness.journal.rows().slice()]);
    expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(2);
    const attemptsBefore = harness.journal.attempts.length;

    const revived = harness.crash();
    const opened = await revived.runner.openDelivery();
    expect(opened.checkpointOffset).toBe(2);
    // The transport redelivers the same frame anyway (at-least-once).
    await opened.sink(deliveryFrame(revived.journal.rows().slice(), 2));

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
    await harness.deliverFrames([journal.rows().slice()]);
    expect(effectCalls).toBe(4);
    expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(5);
    const appendsBefore = journal.attempts.length;

    // Deploy a new reducer version. readPageSize 2 forces the rebuild to page.
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      effectCalls = 0;
      const redeployed = harness.crash({ contract: taskContract("0.0.2"), readPageSize: 2 });
      const opened = await redeployed.runner.openDelivery();

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
    reduction: {
      reducerVersion: "0.0.1",
      reducedThroughOffset: ack,
      state: { count: 0, open: [] },
    },
    processing: { acknowledgedThroughOffset: ack, cursorRevision },
  });

  it("store-level: a same-revision backward commit throws; a revision-bump rewind is allowed", () => {
    const store = makeProgressStore();
    store.store.commit(progressAt(10), { expectedCursorRevision: 0 });

    // Same revision, acked moving backward: a stale incarnation — fenced.
    expect(() => store.store.commit(progressAt(4), { expectedCursorRevision: 0 })).toThrow(
      /backward.*without a cursorRevision bump/,
    );
    expect(store.record).toEqual(progressAt(10)); // the fenced commit wrote nothing

    // A rewind lands under the OLD revision and writes the bumped one (the
    // browser projection reset's shape) — the ONLY sanctioned backward move.
    store.store.commit(progressAt(4, 1), { expectedCursorRevision: 0 });
    expect(store.record).toEqual(progressAt(4, 1));
  });

  it("a stale incarnation's same-revision commit cannot roll acknowledgement back past a newer one", async () => {
    const journal = makeJournal();
    for (const id of ["a", "b"]) journal.seed({ type: REQUESTED, payload: { id } });

    // Incarnation A: wedges on event 1's blocker BEFORE any durable commit,
    // holding a single-event frame whose frame-end commit will later try to
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
    const { sink } = await a.runner.openDelivery();
    const frameA = sink(deliveryFrame(journal.rows().slice(0, 1), 2));
    await tick();
    expect(a.store.record).toBeUndefined();

    // Incarnation B processes through offset 2 at the SAME revision.
    const b = a.crash({ hooks: {} });
    await b.deliverPending();
    expect(b.store.record?.processing).toEqual({ acknowledgedThroughOffset: 2, cursorRevision: 0 });

    // A resumes: its commit of acked=1 matches the persisted revision (0),
    // so the revision CAS alone would ACCEPT it and roll durable
    // acknowledgement and state backward — the monotonic fence rejects it.
    gate.resolve();
    await expect(frameA).rejects.toThrow(/backward/);
    expect(b.store.record?.processing).toEqual({ acknowledgedThroughOffset: 2, cursorRevision: 0 });
  });
});

// =============================================================================
// 7. At-head reconcile (`delivery.caughtUp`) — fires on the LAST CONSUMED event
//    of a frame whose scan reaches the observed stream head. If that frame
//    consumes nothing, one eventless pass reconciles the same final fold.
// =============================================================================

describe("StreamProcessorRunner at-head reconcile (delivery.caughtUp)", () => {
  it("does not reconcile a queued stale-head frame after the preceding reconcile appends to its home stream", async () => {
    const journal = makeJournal();
    const firstRequested = journal.seed({ type: REQUESTED, payload: { id: "a" } });
    const effectStarted = deferred();
    const releaseEffect = deferred();
    const headStates: string[][] = [];
    let effectAttempts = 0;
    const hooks: TaskHooks = {
      onHead: (args, stableKey) => {
        headStates.push([...args.state.open]);
        if (!args.state.open.includes("a")) return;
        args.blockProcessorWhile(async () => {
          effectAttempts += 1;
          effectStarted.resolve();
          await releaseEffect.promise;
          await args.append({
            type: COMPLETED,
            idempotencyKey: stableKey("complete:a"),
            payload: { id: "a" },
          });
        });
      },
    };
    const harness = makeHarness({ journal, hooks });
    const { sink } = await harness.runner.openDelivery();

    // Frame 1 reaches the head at offset 1 and starts its obligation. While
    // that work is in flight, another consumed fact becomes a queued frame
    // whose transport snapshot says the head is 2.
    const first = sink(deliveryFrame([firstRequested], 1));
    await effectStarted.promise;
    const secondRequested = journal.seed({ type: REQUESTED, payload: { id: "b" } });
    const second = sink(deliveryFrame([secondRequested], 2));

    // The first reconcile settles by appending its terminal fact at offset 3.
    // The queued frame's head=2 snapshot is now stale. It may fold/commit
    // offset 2, but MUST NOT reconcile the still-pre-terminal fold: doing so
    // repeats the external effect before offset 3 is delivered (the fresh
    // project config-repo double-seed incident).
    releaseEffect.resolve();
    await first;
    await second;
    expect(headStates).toEqual([["a"]]);
    expect(effectAttempts).toBe(1);

    // Once the self-appended terminal fact itself reaches the runner, the
    // processor is honestly at head again and reconciles the final fold.
    const completed = journal.rows().find((event) => event.type === COMPLETED)!;
    await sink(deliveryFrame([completed], 3));
    expect(headStates).toEqual([["a"], ["b"]]);
    expect(effectAttempts).toBe(1);
  });

  it("fires on the last consumed event of a head-reaching batch; an unconsumed tail at head fires the event-less pass", async () => {
    const journal = makeJournal();
    journal.seed({ type: REQUESTED, payload: { id: "a" } }); // 1: opens the obligation
    journal.seed({ type: NOISE, payload: {} }); // 2: unconsumed, reaches head

    const headCalls: { open: string[]; event: number | null }[] = [];
    const processPhases: string[] = [];
    const hooks: TaskHooks = {
      onProcess: (args) => {
        processPhases.push(
          `${args.event.offset}:${args.delivery.phase}:${args.delivery.eventsBehindObservedHead}`,
        );
      },
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
    const { sink } = await harness.runner.openDelivery();
    const [requestedEvent] = journal.rows();

    // Frame 1: the requested event, delivered mid-catch-up (head is at 2). It
    // is behind head, so NOT caughtUp — nothing may act on a partial fold.
    await sink(deliveryFrame([requestedEvent!], 2));
    expect(processPhases).toEqual(["1:catching-up:1"]);
    expect(headCalls).toEqual([]);
    expect(journal.rows(SIBLING)).toHaveLength(0);

    // Frame 2 proves the selector scanned offset 2 but omits its unconsumed
    // event. The frame reaches head but no consumed event carries `caughtUp`.
    // The runner fires the EVENT-LESS at-head pass (event=null), and the
    // obligation opened by event 1 drives instead of stranding on a quiet
    // stream.
    await sink({
      events: [],
      scannedAfterOffset: 1,
      scannedThroughOffset: 2,
      streamMaxOffset: 2,
    });
    expect(processPhases).toEqual(["1:catching-up:1"]); // still no per-event processEvent
    expect(headCalls).toEqual([{ open: ["a"], event: null }]); // event-less pass drove it
    expect(comparableRows(journal.rows(SIBLING))).toEqual([
      { type: DRIVEN, idempotencyKey: "test-task/drive:a", payload: { id: "a" } },
    ]);

    // A later CONSUMED event reaches head: the reconcile runs again over the
    // final fold; drive:a dedupes on its stable key, drive:b is new.
    journal.seed({ type: REQUESTED, payload: { id: "b" } }); // 3: consumed, at head
    await sink(deliveryFrame([journal.rows()[2]!], 3));
    expect(processPhases).toEqual(["1:catching-up:1", "3:live:0"]);
    expect(headCalls).toEqual([
      { open: ["a"], event: null },
      { open: ["a", "b"], event: 3 },
    ]);
    expect(comparableRows(journal.rows(SIBLING))).toEqual([
      { type: DRIVEN, idempotencyKey: "test-task/drive:a", payload: { id: "a" } },
      { type: DRIVEN, idempotencyKey: "test-task/drive:b", payload: { id: "b" } },
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
    // consumes, so it is the last consumed event of a head-reaching batch and
    // MUST carry caughtUp. Before the wildcard fix, `consumes.has("NOISE")`
    // was false and caughtUp never fired for `*` processors.
    const harness = makeHarness({ journal, hooks, contract: taskContract("0.0.1", ["*"]) });
    await harness.deliverFrames([journal.rows().slice()]);
    expect(headCalls).toEqual([["a"]]);
  });

  it("commits only after onCaughtUp's blocking work: a failing at-head blocker leaves the frame UNcommitted and retried (codex bug #2)", async () => {
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
          // The at-head pass's own blocking work fails (or the incarnation
          // dies mid-blocker — same durable outcome).
          args.blockProcessorWhile(() => Promise.reject(new Error("at-head work failed")));
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
    // BEFORE onCaughtUp's blocking work settled, a failed at-head blocker
    // would leave redelivery with zero pending events and the at-head work
    // lost forever. The frame-end-only commit runs after EVERY event's
    // blocking work — the at-head reconcile's included — so the failed pass
    // leaves the whole frame uncommitted and retryable.
    const harness = makeHarness({ journal, hooks });

    const { sink } = await harness.runner.openDelivery();
    const frame = deliveryFrame(journal.rows().slice(), 2);
    await expect(sink(frame)).rejects.toThrow("at-head work failed");

    // NOTHING committed — the head event (and its at-head pass) stays retryable.
    expect(harness.store.record).toBeUndefined();
    await expect(harness.runner.snapshot()).resolves.toEqual({
      offset: 0,
      state: { count: 0, open: [] },
    });

    // The transport's redelivery re-runs the frame AND the at-head pass.
    await sink(frame);
    expect(processedOffsets).toEqual([1, 2, 1, 2]); // at-least-once on the uncommitted frame
    expect(headAttempts).toBe(2);
    expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(2);
    expect(comparableRows(journal.rows(SIBLING))).toEqual([
      { type: DRIVEN, idempotencyKey: "test-task/drive:a", payload: { id: "a" } },
    ]);
  });

  it("fires the reconcile via the EVENT-LESS at-head pass when the head is an unconsumed tail (self-pull)", async () => {
    const journal = makeJournal();
    journal.seed({ type: REQUESTED, payload: { id: "a" } }); // 1 — consumed, opens the obligation
    journal.seed({ type: NOISE, payload: {} }); // 2 — unconsumed durable tail at raw head

    const headCalls: { open: string[]; event: number | null }[] = [];
    const hooks: TaskHooks = {
      onHead: (args, stableKey) => {
        // args.event is NULL here — this is the event-less at-head pass.
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

    // The production wake lane's exact shape: ONLY the consumed event 1 is
    // delivered, stamped with the RAW head 2. The trailing type-unfiltered
    // self-pull folds the unconsumed tail so the cursor reaches head — and the
    // batch reaches head with NO consumed event, so the runner fires the
    // EVENT-LESS at-head pass and the obligation drives. This is the exact
    // late-agent preview failure: the requested script stayed open forever
    // after unrelated presence facts occupied the raw tail.
    await harness.deliverConsumesFilteredPending();
    await vi.waitFor(() => {
      expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(2);
      expect(headCalls).toEqual([{ open: ["a"], event: null }]);
    });
    expect(comparableRows(journal.rows(SIBLING))).toEqual([
      { type: DRIVEN, idempotencyKey: "test-task/drive:a", payload: { id: "a" } },
    ]);
    await expect(harness.runner.snapshot()).resolves.toEqual({
      offset: 2,
      state: { count: 1, open: ["a"] },
    });
  });

  it("runs the caughtUp reconcile AFTER the head event's own per-event work (ordering fix)", async () => {
    // The head event registers BOTH a per-event append (blockProcessorWhile)
    // and an at-head reconcile append (blockProcessorWhileCaughtUp). The
    // reconcile MUST land after the per-event append — the guarantee that lets
    // e.g. an interrupt cancel fold before the reconcile's re-fire. Without it
    // the two race (the bug Bugbot caught folding onCaughtUp into processEvent).
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
        args.blockProcessorWhileCaughtUp(() =>
          args.appendTo(SIBLING, {
            type: DRIVEN,
            idempotencyKey: "test-task/at-head",
            payload: { id: "at-head" },
          }),
        );
      },
    };
    const harness = makeHarness({ journal, hooks });
    await harness.deliverFrames([journal.rows().slice()]);

    // Journal order proves the sequencing: per-event FIRST, at-head SECOND.
    expect(journal.rows(SIBLING).map((row) => row.type)).toEqual([ECHOED, DRIVEN]);
  });
});

// =============================================================================
// Malformed consumed events (stream-processor.ts:592-616 semantics, exactly)
// =============================================================================

describe("StreamProcessorRunner parse-failure lane", () => {
  it("advances past a malformed consumed event, records it AFTER the commit, in the background", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const journal = makeJournal();
      journal.seed({ type: REQUESTED, payload: { id: "a" } }); // 1
      journal.seed({ type: REQUESTED, payload: { id: 42 } }); // 2 — malformed
      journal.seed({ type: REQUESTED, payload: { id: "c" } }); // 3

      const harness = makeHarness({ journal });
      await harness.deliverFrames([journal.rows().slice()]);

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

  it("a failing diagnostic append is logged, never re-poisons the committed frame", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const journal = makeJournal();
      journal.seed({ type: REQUESTED, payload: { id: 42 } }); // malformed only

      const harness = makeHarness({ journal });
      journal.failNextAppendTo(HOME, new Error("append transport down"));
      await harness.deliverFrames([journal.rows().slice()]);
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

  it("a malformed consumed event at head does NOT steal caughtUp from the last good event", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const journal = makeJournal();
      journal.seed({ type: REQUESTED, payload: { id: "a" } }); // 1 — good, opens obligation
      journal.seed({ type: REQUESTED, payload: { id: 42 } }); // 2 — malformed, at raw head

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
      await harness.deliverFrames([journal.rows().slice()]);
      await tick();

      expect(headCalls).toEqual([["a"]]);
      expect(comparableRows(journal.rows(SIBLING))).toEqual([
        { type: DRIVEN, idempotencyKey: "test-task/drive:a", payload: { id: "a" } },
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
    await harness.deliverFrames([harness.journal.rows().slice()]);
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
    // scheduled — the harness never opens a sink, so nothing pushes a frame.
    // The wait must reach the event by pulling the journal itself; parking for
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

  it("coalesces concurrent offset waiters into one target-aware self-pull", async () => {
    const harness = makeHarness();
    // Complete the memoized load before measuring journal reads: this test is
    // about the offset waiters' pulls, not progress initialization.
    await harness.runner.snapshot();
    const committed = Array.from({ length: 20 }, (_, index) =>
      harness.journal.seed({ type: REQUESTED, payload: { id: `ryw-${index}` } }),
    );
    const readsBefore = harness.journal.readSessionCount();

    await Promise.all(
      committed.map((event) =>
        harness.runner.waitUntilEvent({ offset: event.offset, timeoutMs: 500 }),
      ),
    );

    expect(harness.journal.readSessionCount() - readsBefore).toBe(1);
    expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(20);
    expect((await harness.runner.snapshot()).state.open).toEqual(
      Array.from({ length: 20 }, (_, index) => `ryw-${index}`),
    );
  });

  it("runs one trailing pull when a later committed target was outside the active read", async () => {
    const firstReadStarted = deferred();
    const journal = makeJournal(HOME, {
      snapshotReadSessions: true,
      onReadSession: (session) => {
        if (session === 1) firstReadStarted.resolve();
      },
    });
    const harness = makeHarness({ journal });
    await harness.runner.snapshot();

    const first = journal.seed({ type: REQUESTED, payload: { id: "first" } });
    const firstWait = harness.runner.waitUntilEvent({ offset: first.offset, timeoutMs: 500 });
    await firstReadStarted.promise;
    // The active pager has already frozen its view at offset 1. This later
    // waiter must request one trailing pass; sharing only the active promise
    // would park forever because no push delivery is coming in this fixture.
    const second = journal.seed({ type: REQUESTED, payload: { id: "second" } });
    const secondWait = harness.runner.waitUntilEvent({ offset: second.offset, timeoutMs: 500 });

    await expect(Promise.all([firstWait, secondWait])).resolves.toEqual([undefined, undefined]);
    expect(journal.readSessionCount()).toBe(2);
    expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(second.offset);
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
    const build = (): ProcessorRecovery => {
      const recovery: ProcessorRecovery = {
        keepAliveWhile: (work) => keepalive.track(work()),
        appendRevived: () => void journal.seed({ type: REVIVED, payload: {} }),
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
          await recovery.appendRevived();
        },
        appendFact: () => {},
        version: "v1",
      });
      return recovery;
    };
    return { clock, kv, revivals, build };
  }

  it("throws at construction when recovery is wired but consumes has no <ns>/revived", () => {
    const journal = makeJournal();
    const recovery = makeRecoveryFixture(journal).build();
    const noRevivedContract = defineProcessorContract({
      slug: "test-no-revived",
      version: "0.0.1",
      description: "A contract without a revived event, for the construction check.",
      stateSchema: z.object({ count: z.number().default(0) }),
      events: { [REQUESTED]: { payloadSchema: z.object({ id: z.string() }) } },
      consumes: [REQUESTED],
      emits: [],
    });
    const processor = new (class extends StreamProcessor<typeof noRevivedContract> {
      readonly contract = noRevivedContract;
    })({ stream: journal.stream, path: journal.homePath, projectId: null });

    expect(
      () =>
        new StreamProcessorRunner({
          processor,
          stream: journal.stream,
          durability: { progress: makeProgressStore().store as never, recovery },
        }),
    ).toThrow(
      /does not consume the revival fact "events\.iterate\.com\/stream\/processor-revived"/,
    );
  });

  it("throws at construction when consumes has SOME /revived event but not the core stream/processor-revived", () => {
    // The trap the exact-membership check closes: a shape-only check
    // (endsWith "/revived") accepts a contract that consumes some namespaced
    // revival-looking event, while the ONE core fact the recovery adapter
    // appends never invokes the processor — recovery silently recovers
    // nothing.
    const OTHER_REVIVED = "events.iterate.com/other-processor/revived";
    const journal = makeJournal();
    const recovery = makeRecoveryFixture(journal).build();
    const wrongRevivedContract = defineProcessorContract({
      slug: "test-wrong-revived",
      version: "0.0.1",
      description: "Consumes a FOREIGN revived event, not its own adapter's.",
      stateSchema: z.object({ count: z.number().default(0) }),
      events: {
        [REQUESTED]: { payloadSchema: z.object({ id: z.string() }) },
        [OTHER_REVIVED]: { payloadSchema: z.object({}) },
      },
      consumes: [REQUESTED, OTHER_REVIVED],
      emits: [],
    });
    const processor = new (class extends StreamProcessor<typeof wrongRevivedContract> {
      readonly contract = wrongRevivedContract;
    })({ stream: journal.stream, path: journal.homePath, projectId: null });

    expect(
      () =>
        new StreamProcessorRunner({
          processor,
          stream: journal.stream,
          durability: { progress: makeProgressStore().store as never, recovery },
        }),
    ).toThrow(
      /does not consume the revival fact "events\.iterate\.com\/stream\/processor-revived"/,
    );
  });

  it("blocking, background, AND whole-frame work ride the keepalive; a quiet-clean alarm disarms", async () => {
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
    await harness.deliverFrames([journal.rows().slice()]);

    // The frame is done but background work is still owed: the durable alarm
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
    await harness.deliverFrames([journal.rows().slice()]);
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
    // ...whose ordinary delivery turn gives the processor its at-head pass —
    // where an obligation processor would settle what the dead incarnation
    // left behind. (The registry that auto-pulls after revival is a later
    // slice; here the transport's redelivery plays that part.)
    await revived.deliverPending();
    expect(headCalls).toEqual([{ count: 1, open: ["a"] }]);
  });
});
