// Plain-node tests for the Durable Object durability adapters
// (durable-object-processor-durability.ts) over an in-memory `storage.kv`
// fake, an alarm-seam capture, an idempotency-deduping journal, and a virtual
// clock — the same harness style as stream-processor-runner.test.ts. The
// storage fake deliberately has NO `setAlarm`: any adapter reaching past the
// injected seam would throw, proving the seam is the only alarm door.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StreamEvent, StreamEventInput } from "iterate/processors";
import { defineProcessorContract } from "iterate/processors";
import { StreamProcessor } from "iterate/processors";
import { KEEPALIVE_ALARM_LEAD_MS, type KeepaliveRecord } from "iterate/processors";
import {
  StreamProcessorRunner,
  type ProcessorProgress,
  type ProcessorRecovery,
} from "iterate/processors";
import {
  durableObjectProgressStore,
  durableObjectRecovery,
  processorKeepaliveKey,
  processorProgressKey,
} from "iterate/processors/cloudflare";
import { STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "iterate/processors";
import type { Stream } from "../../itx-api.generated.ts";

const SLUG = "test-durability";
const REQUESTED = "events.iterate.com/test-durability/requested";
// The ONE core revival type the adapter appends; the fixture contract defines
// it LOCALLY so this harness stays free of the real core contract.
const REVIVED = STREAM_PROCESSOR_REVIVED_EVENT_TYPE;
const HOME = "/tests/durable-object-durability";
const VERSION = "0.0.1";
const TEST_STREAM_ID = "11111111-1111-4111-8111-111111111111";
const RECREATED_STREAM_ID = "22222222-2222-4222-8222-222222222222";

// -----------------------------------------------------------------------------
// Fakes: synchronous KV (structuredClone on both sides, like real
// serialization), a single-path journal with idempotency-key dedupe, and a
// deferred helper for asynchronous completion.
// -----------------------------------------------------------------------------

function makeStorage() {
  const map = new Map<string, unknown>();
  const kv = {
    get: (key: string) => (map.has(key) ? structuredClone(map.get(key)) : undefined),
    put: (key: string, value: unknown) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
    list: () => [][Symbol.iterator](),
    // Deliberately NO setAlarm/getAlarm: the adapters must never reach past
    // the injected armAlarm seam.
  };
  return { storage: { kv } as unknown as DurableObjectStorage, map };
}

type Journal = ReturnType<typeof makeJournal>;

function makeJournal() {
  const rows: StreamEvent[] = [];
  /** EVERY append attempt, deduped or not — the exactly-once evidence. */
  const attempts: StreamEventInput[] = [];
  let createdAtClock = 0;
  let streamId = TEST_STREAM_ID;
  let guardedAppendGate: ReturnType<typeof deferred> | undefined;

  const commit = (event: StreamEventInput): StreamEvent => {
    attempts.push(event);
    if (event.idempotencyKey) {
      const existing = rows.find((row) => row.idempotencyKey === event.idempotencyKey);
      if (existing) return existing;
    }
    const committed = {
      ...event,
      offset: (rows.at(-1)?.offset ?? 0) + 1,
      createdAt: new Date(++createdAtClock).toISOString(),
      path: HOME,
    } as StreamEvent;
    rows.push(committed);
    return committed;
  };

  const stream = {
    append: (...events: StreamEventInput[]) => Promise.resolve(events.map(commit)),
    appendIfStreamId: async (args: { streamId: string; events: StreamEventInput[] }) => {
      await guardedAppendGate?.promise;
      if (args.streamId !== streamId) {
        throw new Error(`stream ID changed (${args.streamId} -> ${streamId}); append rejected`);
      }
      return args.events.map(commit);
    },
    at: () => stream,
    getEventPage: async (args?: {
      afterOffset?: number;
      beforeOffset?: number | null;
      limit?: number;
    }) => {
      const afterOffset = args?.afterOffset ?? 0;
      const beforeOffset = args?.beforeOffset ?? Number.MAX_SAFE_INTEGER;
      return {
        streamId,
        streamMaxOffset: rows.at(-1)?.offset ?? 0,
        events: rows
          .filter((row) => row.offset > afterOffset && row.offset < beforeOffset)
          .slice(0, args?.limit ?? 500),
      };
    },
    readEvents: (args?: { afterOffset?: number; beforeOffset?: number | null; limit?: number }) => {
      let cursor = args?.afterOffset ?? 0;
      const limit = args?.limit ?? 500;
      return {
        next: () => {
          const page = rows
            .filter(
              (row) =>
                row.offset > cursor &&
                (!Number.isFinite(args?.beforeOffset) || row.offset < args.beforeOffset),
            )
            .slice(0, limit);
          if (page.length > 0) cursor = page.at(-1)!.offset;
          return Promise.resolve(page);
        },
        [Symbol.dispose]: () => {},
      };
    },
  } as unknown as Stream;

  return {
    stream,
    rows,
    attempts,
    head: () => rows.at(-1)?.offset ?? 0,
    pauseGuardedAppends() {
      if (guardedAppendGate) throw new Error("guarded appends are already paused");
      guardedAppendGate = deferred();
      return () => {
        const gate = guardedAppendGate;
        guardedAppendGate = undefined;
        gate?.resolve(undefined);
      };
    },
    recreate(nextStreamId: string) {
      streamId = nextStreamId;
      rows.splice(0, rows.length);
    },
    /** Seed a raw journal fact directly (no attempt logged — it's the fixture). */
    seed(event: { type: string; payload?: Record<string, unknown> }): StreamEvent {
      const committed = {
        ...event,
        offset: (rows.at(-1)?.offset ?? 0) + 1,
        createdAt: new Date(++createdAtClock).toISOString(),
        path: HOME,
      } as StreamEvent;
      rows.push(committed);
      return committed;
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

// -----------------------------------------------------------------------------
// Processor fixture for the runner-integration tests: `requested` folds an id
// into state; hooks observe every reduce and processEvent call.
// -----------------------------------------------------------------------------

const contract = defineProcessorContract({
  slug: SLUG,
  version: VERSION,
  description: "Fixture exercising the DO durability adapters under the runner.",
  stateSchema: z.object({ ids: z.array(z.string()).default([]) }),
  events: {
    [REQUESTED]: { payloadSchema: z.object({ id: z.string() }) },
    [REVIVED]: { payloadSchema: z.looseObject({}) },
  },
  consumes: [REQUESTED, REVIVED],
  emits: [],
});

type Contract = typeof contract;
type State = z.infer<Contract["stateSchema"]>;

function progressAt(
  offset: number,
  cursorRevision = 0,
  streamId = TEST_STREAM_ID,
): ProcessorProgress<State> {
  return {
    streamId,
    reduction: { reducerVersion: VERSION, reducedThroughOffset: offset, state: { ids: [] } },
    processing: { acknowledgedThroughOffset: offset, cursorRevision },
  };
}

type Hooks = {
  onReduce?: (offset: number) => void;
  onProcess?: (args: Parameters<StreamProcessor<Contract>["processEvent"]>[0]) => void;
};

class DurabilityProcessor extends StreamProcessor<Contract, { contract: Contract; hooks: Hooks }> {
  get contract(): Contract {
    return this.deps.contract;
  }

  protected override reduce({ event, state }: Parameters<StreamProcessor<Contract>["reduce"]>[0]) {
    this.deps.hooks.onReduce?.(event.offset);
    if (event.type === REQUESTED) return { ids: [...state.ids, event.payload.id] };
    return state;
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<Contract>["processEvent"]>[0],
  ): undefined {
    this.deps.hooks.onProcess?.(args);
  }
}

function makeRunner(args: {
  journal: Journal;
  storage: DurableObjectStorage;
  hooks?: Hooks;
  recovery?: ProcessorRecovery;
}) {
  const processor = new DurabilityProcessor({
    stream: args.journal.stream,
    path: HOME,
    projectId: null,
    contract,
    hooks: args.hooks ?? {},
  });
  return new StreamProcessorRunner({
    processor,
    stream: args.journal.stream,
    durability: {
      progress: durableObjectProgressStore<State>({
        storage: args.storage,
        name: SLUG,
      }),
      ...(!args.recovery ? {} : { recovery: args.recovery }),
    },
    now: () => 0,
  });
}

// =============================================================================
// durableObjectProgressStore
// =============================================================================

describe("durableObjectProgressStore", () => {
  const progressKey = processorProgressKey(SLUG);
  const makeStore = () => {
    const { storage, map } = makeStorage();
    const store = durableObjectProgressStore<State>({
      storage,
      name: SLUG,
    });
    return { storage, map, store };
  };
  it("reads undefined for a fresh processor, mutating nothing", () => {
    const { store, map } = makeStore();
    expect(store.read()).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it("CAS: an absent record reads as revision 0 — stale expected rejects, matching accepts", () => {
    const { store, map } = makeStore();

    expect(() =>
      store.commit(progressAt(3), {
        expectedCursorRevision: 1,
        expectedStreamId: undefined,
      }),
    ).toThrow(/expected cursorRevision 1, persisted 0/);
    // The fenced commit wrote nothing.
    expect(map.has(progressKey)).toBe(false);

    store.commit(progressAt(3), { expectedCursorRevision: 0, expectedStreamId: undefined });
    expect(store.read()).toEqual(progressAt(3));
  });

  it("CAS fences against a rewind-style revision bump (commit lands under the OLD revision, writes the new)", () => {
    const { store } = makeStore();
    store.commit(progressAt(10), { expectedCursorRevision: 0, expectedStreamId: undefined });

    // Rewind-style: asserts the old revision, persists the bumped one (the
    // browser projection reset rewinds this way).
    store.commit(progressAt(4, 1), {
      expectedCursorRevision: 0,
      expectedStreamId: TEST_STREAM_ID,
    });

    // A continuation of the pre-rewind cursor is now stale.
    expect(() =>
      store.commit(progressAt(11), {
        expectedCursorRevision: 0,
        expectedStreamId: TEST_STREAM_ID,
      }),
    ).toThrow(/expected cursorRevision 0, persisted 1/);
    store.commit(progressAt(11, 1), {
      expectedCursorRevision: 1,
      expectedStreamId: TEST_STREAM_ID,
    });
    expect(store.read()).toEqual(progressAt(11, 1));
  });

  it("MONOTONIC fence: a same-revision backward acknowledgement is rejected; only a revision bump may rewind", () => {
    const { store, map } = makeStore();
    store.commit(progressAt(10), { expectedCursorRevision: 0, expectedStreamId: undefined });

    // A stale incarnation committing older progress at the SAME revision
    // passes the revision CAS — the monotonic fence must stop it from
    // rolling durable acknowledgement (and state) backward.
    expect(() =>
      store.commit(progressAt(4), {
        expectedCursorRevision: 0,
        expectedStreamId: TEST_STREAM_ID,
      }),
    ).toThrow(/backward.*without a cursorRevision bump/);
    expect(store.read()).toEqual(progressAt(10)); // the fenced commit wrote nothing
    expect(map.get(progressKey)).toEqual(progressAt(10));

    // The sanctioned backward move: a rewind bumps the revision under the
    // old expected value.
    store.commit(progressAt(4, 1), {
      expectedCursorRevision: 0,
      expectedStreamId: TEST_STREAM_ID,
    });
    expect(store.read()).toEqual(progressAt(4, 1));
  });
});

// =============================================================================
// durableObjectRecovery
// =============================================================================

describe("durableObjectRecovery", () => {
  function makeRecoveryFixture(args: { journal: Journal; storage: DurableObjectStorage }) {
    const kv = (
      args.storage as unknown as {
        kv: { get(key: string): unknown; put(key: string, value: unknown): void };
      }
    ).kv;
    if (!kv.get(processorProgressKey(SLUG))) {
      kv.put(processorProgressKey(SLUG), progressAt(0));
    }
    const clock = { now: Date.parse("2026-07-14T12:00:00Z") };
    const alarmCalls: (number | null)[] = [];
    /** One incarnation. Rebuild over the same storage to simulate an eviction:
     * only the KV record and the journal survive; keepalive flags do not. */
    const build = () =>
      durableObjectRecovery({
        storage: args.storage,
        name: SLUG,
        stream: args.journal.stream,
        version: "v1",
        armAlarm: (atMs) => void alarmCalls.push(atMs),
        waitUntil: (work) => void work.catch(() => undefined),
        now: () => clock.now,
      });
    return {
      clock,
      alarmCalls,
      build,
      readRecord: () =>
        kv.get(processorKeepaliveKey(SLUG)) as (KeepaliveRecord & { streamId: string }) | undefined,
    };
  }

  it("keepAliveWhile arms the durable alarm ahead of tracked work; a quiet-clean fire disarms through the seam", async () => {
    const journal = makeJournal();
    const { storage } = makeStorage();
    const fixture = makeRecoveryFixture({ journal, storage });
    const recovery = fixture.build();
    // No persisted desire yet: construction must not touch the seam.
    expect(fixture.alarmCalls).toEqual([]);

    const work = deferred();
    recovery.keepAliveWhile(() => work.promise);
    const armedAt = fixture.clock.now + KEEPALIVE_ALARM_LEAD_MS;
    expect(fixture.readRecord()?.armedAtMs).toBe(armedAt);
    expect(fixture.alarmCalls.at(-1)).toBe(armedAt);

    // A fire before the armed time is another slice's — a no-op here.
    await recovery.handleAlarm();
    expect(fixture.alarmCalls.at(-1)).toBe(armedAt);

    // A due fire while the work is still in flight re-arms (busy), never revives.
    fixture.clock.now = armedAt + 1;
    await recovery.handleAlarm();
    expect(fixture.alarmCalls.at(-1)).toBe(fixture.clock.now + KEEPALIVE_ALARM_LEAD_MS);
    expect(journal.rows.filter((row) => row.type === REVIVED)).toHaveLength(0);

    // The work settles cleanly; the confirmation fire finds quiet and disarms.
    work.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); // let the result callback run
    fixture.clock.now = fixture.readRecord()!.armedAtMs! + 1;
    await recovery.handleAlarm();
    expect(fixture.alarmCalls.at(-1)).toBeNull();
    expect(fixture.readRecord()?.armedAtMs).toBeNull();
    expect(fixture.readRecord()?.revivals).toBe(0);
    expect(journal.rows.filter((row) => row.type === REVIVED)).toHaveLength(0);
  });

  it("died owing work: the alarm fires in a fresh incarnation and appends one attempt-keyed revived fact", async () => {
    const journal = makeJournal();
    const { storage } = makeStorage();
    const fixture = makeRecoveryFixture({ journal, storage });

    // Incarnation 1 dies owing this never-settling work.
    const first = fixture.build();
    first.keepAliveWhile(() => new Promise(() => {}));
    const armedAt = fixture.readRecord()!.armedAtMs!;

    // Incarnation 2 boots: construction re-issues the persisted desire — the
    // lost-platform-alarm heal the host performs whenever it opens.
    const callsBefore = fixture.alarmCalls.length;
    const second = fixture.build();
    expect(fixture.alarmCalls.length).toBe(callsBefore + 1);
    expect(fixture.alarmCalls.at(-1)).toBe(armedAt);

    // The durable alarm fires: nothing in flight, nothing settled clean in
    // this incarnation ⇒ the revival alarm. The mark is written BEFORE the
    // pass, so the appended fact is keyed by attempt.
    fixture.clock.now = armedAt + 1;
    await second.handleAlarm();

    const revivedRows = journal.rows.filter((row) => row.type === REVIVED);
    expect(revivedRows).toHaveLength(1);
    expect(revivedRows[0]!.idempotencyKey).toBe(
      `processor-revived:${SLUG}@v1:1:${fixture.clock.now}`,
    );
    expect(revivedRows[0]!.payload).toEqual({ processorSlug: SLUG, revivals: 1, version: "v1" });
    expect(fixture.readRecord()?.revivals).toBe(1);
    // The safety net stays armed after the pass (quiet-clean is what resets it).
    expect(fixture.readRecord()?.armedAtMs).not.toBeNull();
  });

  it("an in-flight lifetime-A revival cannot append into a recreated lifetime B; B arms a fresh record", async () => {
    const journal = makeJournal();
    const { storage } = makeStorage();
    const fixture = makeRecoveryFixture({ journal, storage });
    const recovery = fixture.build();

    recovery.keepAliveWhile(() => new Promise(() => {}));
    const lifetimeARecord = fixture.readRecord()!;
    expect(lifetimeARecord.streamId).toBe(TEST_STREAM_ID);

    const releaseAppend = journal.pauseGuardedAppends();
    fixture.clock.now = lifetimeARecord.armedAtMs! + 1;
    // The arming incarnation died. A fresh incarnation has no in-memory
    // in-flight count, so the persisted due alarm performs the revival.
    const staleAlarm = fixture.build().handleAlarm();

    // The alarm has durably marked its A revival and entered the append RPC,
    // but the receiving stream has not performed the identity check yet.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    journal.recreate(RECREATED_STREAM_ID);
    durableObjectProgressStore<State>({ storage, name: SLUG }).replaceForStream!(
      progressAt(0, 1, RECREATED_STREAM_ID),
      { expectedStreamId: TEST_STREAM_ID, expectedCursorRevision: 0 },
    );
    expect(fixture.readRecord()).toBeUndefined();

    releaseAppend();
    await staleAlarm;
    expect(journal.rows).toEqual([]);
    expect(journal.attempts).toEqual([]);

    // The same adapter resolves the current progress when new work begins;
    // no stale A instance or breaker budget leaks into lifetime B.
    recovery.keepAliveWhile(() => new Promise(() => {}));
    expect(fixture.readRecord()).toMatchObject({
      streamId: RECREATED_STREAM_ID,
      revivals: 0,
      lastRevivalAt: 0,
    });
  });

  it("a lifetime-A revival that fails after lifetime B arms leaves B's record and alarm intact", async () => {
    const journal = makeJournal();
    const { storage } = makeStorage();
    const fixture = makeRecoveryFixture({ journal, storage });
    const recovery = fixture.build();

    recovery.keepAliveWhile(() => new Promise(() => {}));
    const lifetimeARecord = fixture.readRecord()!;
    const releaseAppend = journal.pauseGuardedAppends();
    fixture.clock.now = lifetimeARecord.armedAtMs! + 1;
    const staleAlarm = fixture.build().handleAlarm();

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    journal.recreate(RECREATED_STREAM_ID);
    durableObjectProgressStore<State>({ storage, name: SLUG }).replaceForStream!(
      progressAt(0, 1, RECREATED_STREAM_ID),
      { expectedStreamId: TEST_STREAM_ID, expectedCursorRevision: 0 },
    );

    // Lifetime B starts work before A's guarded append answers. Its record and
    // alarm are newer durable desire and must not be cleared by A's rejection.
    recovery.keepAliveWhile(() => new Promise(() => {}));
    const lifetimeBRecord = structuredClone(fixture.readRecord()!);
    expect(lifetimeBRecord.streamId).toBe(RECREATED_STREAM_ID);
    const lifetimeBAlarm = lifetimeBRecord.armedAtMs;

    releaseAppend();
    await staleAlarm;

    expect(journal.rows).toEqual([]);
    expect(journal.attempts).toEqual([]);
    expect(fixture.readRecord()).toEqual(lifetimeBRecord);
    expect(fixture.alarmCalls.at(-1)).toBe(lifetimeBAlarm);
  });

  it("a guarded append rejection permanently discards an orphaned lifetime-A revival", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const journal = makeJournal();
      const { storage } = makeStorage();
      const fixture = makeRecoveryFixture({ journal, storage });
      const recovery = fixture.build();

      recovery.keepAliveWhile(() => new Promise(() => {}));
      const lifetimeARecord = fixture.readRecord()!;
      const releaseAppend = journal.pauseGuardedAppends();
      fixture.clock.now = lifetimeARecord.armedAtMs! + 1;
      const staleAlarm = fixture.build().handleAlarm();

      // No lifetime-B delivery reaches this host, so progress is not replaced.
      // Only the receiving stream's atomic guard can reveal the recreation.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      journal.recreate(RECREATED_STREAM_ID);
      releaseAppend();
      await staleAlarm;

      expect(journal.rows).toEqual([]);
      expect(journal.attempts).toEqual([]);
      expect(fixture.readRecord()).toBeUndefined();
      expect(fixture.alarmCalls.at(-1)).toBeNull();

      // There is no six-hour plateau loop: later alarm routing is a no-op.
      const callsAfterDiscard = fixture.alarmCalls.length;
      fixture.clock.now += 24 * 60 * 60_000;
      await recovery.handleAlarm();
      expect(fixture.alarmCalls).toHaveLength(callsAfterDiscard);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("discards invalid recovery records on boot and alarm routing instead of poisoning the host", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const journal = makeJournal();
      const { storage } = makeStorage();
      const fixture = makeRecoveryFixture({ journal, storage });
      const kv = (
        storage as unknown as {
          kv: { put(key: string, value: unknown): void };
        }
      ).kv;

      // The pre-stream-ID record shape is invalid under the new design. A
      // deploy must remove it and its alarm desire, not brick every boot.
      kv.put(processorKeepaliveKey(SLUG), {
        revivals: 2,
        lastRevivalAt: fixture.clock.now,
        version: "v1",
        armedAtMs: fixture.clock.now + 1,
      });
      const recovery = fixture.build();
      expect(fixture.readRecord()).toBeUndefined();
      expect(fixture.alarmCalls.at(-1)).toBeNull();

      // Corruption appearing after construction is handled the same way when
      // the shared Durable Object alarm is routed to this processor.
      kv.put(processorKeepaliveKey(SLUG), {
        streamId: TEST_STREAM_ID,
        revivals: "many",
        lastRevivalAt: fixture.clock.now,
        version: "v1",
        armedAtMs: fixture.clock.now,
      });
      await expect(recovery.handleAlarm()).resolves.toBeUndefined();
      expect(fixture.readRecord()).toBeUndefined();
      expect(fixture.alarmCalls.at(-1)).toBeNull();
      expect(consoleWarn).toHaveBeenCalledTimes(2);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("wired into a real runner: a batch that dies owing background work is revived end-to-end through runner.handleAlarm", async () => {
    const journal = makeJournal();
    journal.seed({ type: REQUESTED, payload: { id: "a" } }); // 1
    const { storage } = makeStorage();
    const fixture = makeRecoveryFixture({ journal, storage });

    // Incarnation 1: processing the event starts background work that never
    // settles (the incident shape: an obligation journaled, the attempt dies
    // with the incarnation, the stream sees zero lag).
    const runner1 = makeRunner({
      journal,
      storage,
      hooks: { onProcess: (args) => args.runInBackground(() => new Promise(() => {})) },
      recovery: fixture.build(),
    });
    const opened = await runner1.openEventBatchCallback();
    await opened.processEventBatch({
      streamId: TEST_STREAM_ID,
      events: journal.rows.slice(),
      scannedAfterOffset: opened.checkpointOffset,
      scannedThroughOffset: 1,
      streamMaxOffset: 1,
    });
    // The batch checkpointed — no lag left — but the alarm is armed: "died
    // owing work" must equal "alarm armed".
    expect(fixture.readRecord()?.armedAtMs).not.toBeNull();

    // Incarnation 2 (post-eviction): the alarm fire routes through the
    // RUNNER's handleAlarm into the recovery adapter and appends the fact.
    const processedTypes: string[] = [];
    const runner2 = makeRunner({
      journal,
      storage,
      hooks: {
        onProcess: (args) => {
          if (!args.event) return;
          processedTypes.push(args.event.type);
        },
      },
      recovery: fixture.build(),
    });
    fixture.clock.now = fixture.readRecord()!.armedAtMs! + 1;
    await runner2.handleAlarm();

    const revivedRows = journal.rows.filter((row) => row.type === REVIVED);
    expect(revivedRows).toHaveLength(1);

    // The fact's ordinary delivery turn is the guaranteed recovery pass: it
    // resumes from the durable acknowledgement (1 — the dead batch DID
    // checkpoint) and hands the processor its revived event.
    const reopened = await runner2.openEventBatchCallback();
    expect(reopened.checkpointOffset).toBe(1);
    const pending = journal.rows.filter((row) => row.offset > reopened.checkpointOffset);
    await reopened.processEventBatch({
      streamId: TEST_STREAM_ID,
      events: pending,
      scannedAfterOffset: reopened.checkpointOffset,
      scannedThroughOffset: journal.head(),
      streamMaxOffset: journal.head(),
    });
    expect(processedTypes).toEqual([REVIVED]);
    await expect(runner2.snapshot()).resolves.toEqual({ offset: 2, state: { ids: ["a"] } });
  });
});
