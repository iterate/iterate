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
//  6. stale-cursorRevision fencing of pre-reprocessFrom continuations
//  7. onCaughtUp at head, including the requested-N / unconsumed-N+1 wedge
//  8. delivery.idempotencyKey byte-identical to the legacy format at revision 0

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Stream } from "../../itx-api.generated.ts";
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import { defineProcessorContract } from "./processor-contracts.ts";
import { StreamProcessor } from "./stream-processor.ts";
import { ProcessorKeepalive, type KeepaliveRecord } from "./stream-processor-keepalive.ts";
import {
  StreamProcessorRunner,
  STREAM_PROCESSOR_CURSOR_CONTROL_EVENT_TYPE,
  type CheckpointCadence,
  type ProcessorProgress,
  type ProcessorProgressStore,
  type ProcessorRecovery,
} from "./stream-processor-runner.ts";

const REQUESTED = "events.iterate.com/test-task/requested";
const COMPLETED = "events.iterate.com/test-task/completed";
const ECHOED = "events.iterate.com/test-task/echoed";
const DRIVEN = "events.iterate.com/test-task/driven";
const REVIVED = "events.iterate.com/test-task/revived";
const NOISE = "events.iterate.com/other/noise";
const HOME = "/tests/runner";
const SIBLING = "/tests/runner-sibling";

// -----------------------------------------------------------------------------
// The processor under drive: an obligation-style task tracker. `requested`
// opens an obligation, `completed` settles it; side effects are whatever the
// test's hooks decide, so each test states its own semantics inline.
// -----------------------------------------------------------------------------

function taskContract(version: string) {
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
    consumes: [REQUESTED, COMPLETED, REVIVED],
    emits: [ECHOED, DRIVEN],
  });
}

type TaskContract = ReturnType<typeof taskContract>;
type TaskState = { count: number; open: string[] };

/** Type carrier: names the protected hook arg shapes from inside a subclass,
 * so the module-level hook types below can reference them. Never instantiated. */
abstract class HookArgTypes extends StreamProcessor<TaskContract> {
  declare readonly processArgs: Parameters<StreamProcessor<TaskContract>["processEvent"]>[0];
  declare readonly headArgs: Parameters<StreamProcessor<TaskContract>["onCaughtUp"]>[0];
}
type TaskHooks = {
  onProcess?: (args: HookArgTypes["processArgs"]) => void;
  onHead?: (args: HookArgTypes["headArgs"]) => void | Promise<void>;
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

  protected override processEvent(
    args: Parameters<StreamProcessor<TaskContract>["processEvent"]>[0],
  ): undefined {
    this.deps.hooks.onProcess?.(args);
  }

  protected override async onCaughtUp(
    args: Parameters<StreamProcessor<TaskContract>["onCaughtUp"]>[0],
  ): Promise<void> {
    await this.deps.hooks.onHead?.(args);
  }

  /** The LEGACY key derivation, exposed for the byte-identity assertion. */
  legacyIdempotencyKey(key: string, whileProcessing?: Pick<StreamEvent, "offset" | "path">) {
    return this.idempotencyKey(key, whileProcessing);
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
  let createdAtClock = 0;

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
        let cursor = args?.afterOffset ?? 0;
        const limit = args?.limit ?? 500;
        return {
          next: () => {
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
  cadence?: CheckpointCadence;
  readPageSize?: number;
  recovery?: ProcessorRecovery;
  now?: () => number;
};

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
    ...(args.cadence === undefined ? {} : { cadence: args.cadence }),
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
        await sink({ events, streamMaxOffset: head });
      }
    },
    /** Open delivery and push everything past the persisted cursor as ONE frame. */
    async deliverPending() {
      const opened = await runner.openDelivery();
      const events = journal.rows().filter((row) => row.offset > opened.checkpointOffset);
      if (events.length > 0) {
        await opened.sink({ events, streamMaxOffset: journal.head() });
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
    onProcess: (args) => {
      args.blockProcessorWhile(() =>
        args.appendTo(SIBLING, {
          type: ECHOED,
          idempotencyKey: args.delivery!.idempotencyKey("echo"),
          payload: { id: args.event.payload.id },
        }),
      );
    },
    onHead: (args) => {
      for (const id of args.state.open) {
        args.blockProcessorWhile(() =>
          args.appendTo(SIBLING, {
            type: DRIVEN,
            idempotencyKey: args.delivery.idempotencyKey(`drive:${id}`),
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
      onProcess: (args) => {
        args.blockProcessorWhile(async () => {
          if (args.event.offset === state.gateOffset && state.gate !== undefined) {
            await state.gate;
          }
          await args.appendTo(SIBLING, {
            type: ECHOED,
            idempotencyKey: args.delivery!.idempotencyKey("echo"),
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
    void sink({ events: harness.journal.rows().slice(), streamMaxOffset: 3 });
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
    const frame = { events: harness.journal.rows().slice(), streamMaxOffset: 2 };

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
    await opened.sink({ events: revived.journal.rows().slice(), streamMaxOffset: 2 });

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
      onProcess: (args) => {
        effectCalls += 1;
        args.blockProcessorWhile(() =>
          args.appendTo(SIBLING, {
            type: ECHOED,
            idempotencyKey: args.delivery!.idempotencyKey("echo"),
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
// 6. Stale-cursorRevision fencing
// =============================================================================

describe("StreamProcessorRunner cursor-revision fencing", () => {
  it("a commit from a pre-reprocessFrom continuation is rejected", async () => {
    const journal = makeJournal();
    for (const id of ["a", "b"]) journal.seed({ type: REQUESTED, payload: { id } });

    // Incarnation A: wedges mid-frame on event 2's blocker.
    const gate = deferred();
    const hooksA: TaskHooks = {
      onProcess: (args) => {
        if (args.event.offset === 2) {
          args.blockProcessorWhile(() => gate.promise);
        }
      },
    };
    const a = makeHarness({ journal, hooks: hooksA });
    const { sink } = await a.runner.openDelivery();
    const frameA = sink({ events: journal.rows().slice(), streamMaxOffset: 2 });
    await tick();

    // Incarnation B (a fresh runner over the same store): operator redrive.
    const keys: string[] = [];
    const hooksB: TaskHooks = {
      onProcess: (args) => {
        keys.push(args.delivery!.idempotencyKey("echo"));
      },
    };
    const b = a.crash({ hooks: hooksB });
    const { cursorRevision } = await b.runner.reprocessFrom({
      offset: 1,
      expectedCursorRevision: 0,
      reason: "operator redrive",
    });
    expect(cursorRevision).toBe(1);
    // The rewind re-ran reduce + processEvent from offset 1 with ROTATED keys.
    expect(keys).toEqual(["test-task/echo@/tests/runner:1#1", "test-task/echo@/tests/runner:2#1"]);
    const committedAfterB = structuredClone(b.store.record);
    expect(committedAfterB?.processing.cursorRevision).toBe(1);

    // A's continuation resumes and tries to commit under revision 0: FENCED.
    gate.resolve();
    await expect(frameA).rejects.toThrow(/fenced/);
    expect(b.store.record).toEqual(committedAfterB); // the stale commit changed nothing

    // The audit fact landed (background, keyed per revision).
    await vi.waitFor(() => {
      const audits = journal
        .rows()
        .filter((row) => row.type === STREAM_PROCESSOR_CURSOR_CONTROL_EVENT_TYPE);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.payload).toMatchObject({
        control: "reprocess-from",
        offset: 1,
        reason: "operator redrive",
        cursorRevision: 1,
      });
    });
  });

  it("skipThrough advances past a poison effect, audited and revision-fenced", async () => {
    const journal = makeJournal();
    journal.seed({ type: REQUESTED, payload: { id: "a" } });
    journal.seed({ type: REQUESTED, payload: { id: "poison" } });

    const hooks: TaskHooks = {
      onProcess: (args) => {
        if (args.event.payload.id === "poison") {
          args.blockProcessorWhile(() => Promise.reject(new Error("vendor down")));
        } else {
          args.blockProcessorWhile(() =>
            args.appendTo(SIBLING, {
              type: ECHOED,
              idempotencyKey: args.delivery!.idempotencyKey("echo"),
              payload: { id: args.event.payload.id },
            }),
          );
        }
      },
    };
    // Per-event cadence, so the healthy event 1 commits before the poison —
    // this also exercises the mid-frame commit path of the cadence seam.
    const harness = makeHarness({
      journal,
      hooks,
      cadence: ({ eventsSinceCommit }) => eventsSinceCommit >= 1,
    });

    const { sink } = await harness.runner.openDelivery();
    const frame = { events: journal.rows().slice(), streamMaxOffset: 2 };
    await expect(sink(frame)).rejects.toThrow("vendor down");
    expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(1);

    // Retry-forever is the policy; the redelivered frame fails the same way.
    await expect(sink(frame)).rejects.toThrow("vendor down");

    // The audited escape hatch: skip the EFFECT, keep the fact in the fold.
    const skipped = await harness.runner.skipThrough({
      offset: 2,
      expectedCursorRevision: 0,
      reason: "vendor rejects this payload permanently",
    });
    expect(skipped.cursorRevision).toBe(1);
    expect(harness.store.record?.processing).toEqual({
      acknowledgedThroughOffset: 2,
      cursorRevision: 1,
    });
    // The skipped event IS reduced — what was skipped is its effect.
    await expect(harness.runner.snapshot()).resolves.toEqual({
      offset: 2,
      state: { count: 2, open: ["a", "poison"] },
    });
    expect(journal.rows(SIBLING).filter((row) => row.payload?.id === "poison")).toHaveLength(0);

    // The stale expected revision is refused thereafter.
    await expect(
      harness.runner.skipThrough({ offset: 3, expectedCursorRevision: 0, reason: "stale" }),
    ).rejects.toThrow(/stale cursor control/);

    // Redelivery of the poison frame is now a silent skip.
    await sink(frame);
    expect(harness.store.record?.processing.acknowledgedThroughOffset).toBe(2);

    await vi.waitFor(() => {
      const audits = journal
        .rows()
        .filter((row) => row.type === STREAM_PROCESSOR_CURSOR_CONTROL_EVENT_TYPE);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.payload).toMatchObject({ control: "skip-through", offset: 2 });
    });
  });
});

// =============================================================================
// 7. onCaughtUp at head — including the requested-N / unconsumed-N+1 wedge
// =============================================================================

describe("StreamProcessorRunner onCaughtUp", () => {
  it("fires only at the observed head and drives obligations whose trigger arrived mid-catch-up", async () => {
    const journal = makeJournal();
    journal.seed({ type: REQUESTED, payload: { id: "a" } }); // N: opens the obligation
    journal.seed({ type: NOISE, payload: {} }); // N+1: unconsumed, reaches head

    const headCalls: { open: string[]; phase: string }[] = [];
    const processPhases: string[] = [];
    const hooks: TaskHooks = {
      onProcess: (args) => {
        processPhases.push(
          `${args.event.offset}:${args.delivery!.phase}:${args.delivery!.eventsBehindObservedHead}`,
        );
      },
      onHead: (args) => {
        headCalls.push({ open: [...args.state.open], phase: args.delivery.phase });
        for (const id of args.state.open) {
          args.blockProcessorWhile(() =>
            args.appendTo(SIBLING, {
              type: DRIVEN,
              idempotencyKey: args.delivery.idempotencyKey(`drive:${id}`),
              payload: { id },
            }),
          );
        }
      },
    };
    const harness = makeHarness({ journal, hooks });
    const { sink } = await harness.runner.openDelivery();
    const [requestedEvent, noiseEvent] = journal.rows();

    // Frame 1: the requested event, delivered mid-catch-up (head is at 2).
    // The legacy wedge: N is "catching up" so nothing may act, and N+1 is
    // unconsumed so no processEvent will ever fire — without a runner-level
    // at-head pulse the obligation would hang forever.
    await sink({ events: [requestedEvent!], streamMaxOffset: 2 });
    expect(processPhases).toEqual(["1:catching-up:1"]);
    expect(headCalls).toEqual([]);
    expect(journal.rows(SIBLING)).toHaveLength(0);

    // Frame 2: ONLY the unconsumed tail event. Zero processEvent calls — yet
    // the cursor reaches the observed head and onCaughtUp drives the fold.
    await sink({ events: [noiseEvent!], streamMaxOffset: 2 });
    expect(processPhases).toEqual(["1:catching-up:1"]); // still no processEvent
    expect(headCalls).toEqual([{ open: ["a"], phase: "live" }]);
    expect(comparableRows(journal.rows(SIBLING))).toEqual([
      { type: DRIVEN, idempotencyKey: "test-task/drive:a", payload: { id: "a" } },
    ]);

    // A redelivered (fully acknowledged) frame delivers nothing new and does
    // not re-fire the pulse; a revival fact is what guarantees later turns.
    await sink({ events: [noiseEvent!], streamMaxOffset: 2 });
    expect(headCalls).toHaveLength(1);
  });
});

// =============================================================================
// 8. Idempotency-key byte-compatibility
// =============================================================================

describe("StreamProcessorRunner idempotency keys", () => {
  it("delivery.idempotencyKey at revision 0 is byte-identical to the legacy format; a rewind rotates it", async () => {
    const journal = makeJournal();
    for (let i = 0; i < 6; i += 1) journal.seed({ type: NOISE, payload: {} }); // 1..6
    journal.seed({ type: REQUESTED, payload: { id: "a" } }); // 7

    const eventKeys: string[] = [];
    const headKeys: string[] = [];
    const hooks: TaskHooks = {
      onProcess: (args) => {
        eventKeys.push(args.delivery!.idempotencyKey("foo"));
      },
      onHead: (args) => {
        headKeys.push(args.delivery.idempotencyKey("bar"));
      },
    };
    const harness = makeHarness({ journal, hooks });
    await harness.deliverFrames([journal.rows().slice()]);

    const requestedEvent = journal.rows().at(-1)!;
    expect(eventKeys).toEqual([harness.processor.legacyIdempotencyKey("foo", requestedEvent)]);
    expect(eventKeys).toEqual(["test-task/foo@/tests/runner:7"]);
    // The at-head derivation binds no offset (obligation keys stay stable
    // across passes) — byte-identical to the legacy no-whileProcessing form.
    expect(headKeys).toEqual([harness.processor.legacyIdempotencyKey("bar")]);
    expect(headKeys).toEqual(["test-task/bar"]);

    // An operator rewind bumps the revision: same offsets, NEW keys — the
    // crash-retry/redrive distinction the design demands.
    await harness.runner.reprocessFrom({
      offset: 7,
      expectedCursorRevision: 0,
      reason: "redrive",
    });
    expect(eventKeys).toEqual(["test-task/foo@/tests/runner:7", "test-task/foo@/tests/runner:7#1"]);
    expect(headKeys.at(-1)).toBe("test-task/bar#1");
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
    ).toThrow(/consumes no "<namespace>\/revived" event/);
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
