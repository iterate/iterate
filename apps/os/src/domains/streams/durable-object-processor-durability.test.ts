// Plain-node tests for the Durable Object durability adapters
// (durable-object-processor-durability.ts) over an in-memory `storage.kv`
// fake, an alarm-seam capture, an idempotency-deduping journal, and a virtual
// clock — the same harness style as stream-processor-runner.test.ts. The
// storage fake deliberately has NO `setAlarm`: any adapter reaching past the
// injected seam would throw, proving the seam is the only alarm door.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Stream } from "../../itx-api.generated.ts";
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import { defineProcessorContract } from "./processor-contracts.ts";
import { StreamProcessor } from "./stream-processor.ts";
import { KEEPALIVE_ALARM_LEAD_MS, type KeepaliveRecord } from "./stream-processor-keepalive.ts";
import {
  StreamProcessorRunner,
  type ProcessorProgress,
  type ProcessorRecovery,
} from "./stream-processor-runner.ts";
import {
  durableObjectProgressStore,
  durableObjectRecovery,
  processorKeepaliveKey,
  processorProgressKey,
} from "./durable-object-processor-durability.ts";

const SLUG = "test-durability";
const REQUESTED = "events.iterate.com/test-durability/requested";
const REVIVED = "events.iterate.com/test-durability/revived";
const HOME = "/tests/durable-object-durability";
const VERSION = "0.0.1";

// -----------------------------------------------------------------------------
// Fakes: synchronous KV (structuredClone on both sides, like real
// serialization), a single-path journal with idempotency-key dedupe, and a
// deferred helper for async settlement.
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

  const commit = (event: StreamEventInput): StreamEvent => {
    attempts.push(event);
    if (event.idempotencyKey !== undefined) {
      const existing = rows.find((row) => row.idempotencyKey === event.idempotencyKey);
      if (existing !== undefined) return existing;
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
    at: () => stream,
    readEvents: (args?: { afterOffset?: number; beforeOffset?: number | null; limit?: number }) => {
      let cursor = args?.afterOffset ?? 0;
      const limit = args?.limit ?? 500;
      return {
        next: () => {
          const page = rows
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
  } as unknown as Stream;

  return {
    stream,
    rows,
    attempts,
    head: () => rows.at(-1)?.offset ?? 0,
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
    [REVIVED]: { payloadSchema: z.object({}) },
  },
  consumes: [REQUESTED, REVIVED],
  emits: [],
});

type Contract = typeof contract;
type State = z.infer<Contract["stateSchema"]>;

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
        slug: SLUG,
      }),
      ...(args.recovery === undefined ? {} : { recovery: args.recovery }),
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
      slug: SLUG,
    });
    return { storage, map, store };
  };
  const progressAt = (offset: number, cursorRevision = 0): ProcessorProgress<State> => ({
    reduction: { reducerVersion: VERSION, reducedThroughOffset: offset, state: { ids: [] } },
    processing: { acknowledgedThroughOffset: offset, cursorRevision },
  });

  it("reads undefined for a fresh processor, mutating nothing", () => {
    const { store, map } = makeStore();
    expect(store.read()).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it("CAS: an absent record reads as revision 0 — stale expected rejects, matching accepts", () => {
    const { store, map } = makeStore();

    expect(() => store.commit(progressAt(3), { expectedCursorRevision: 1 })).toThrow(
      /expected cursorRevision 1, persisted 0/,
    );
    // The fenced commit wrote nothing.
    expect(map.has(progressKey)).toBe(false);

    store.commit(progressAt(3), { expectedCursorRevision: 0 });
    expect(store.read()).toEqual(progressAt(3));
  });

  it("CAS fences against a rewind-style revision bump (commit lands under the OLD revision, writes the new)", () => {
    const { store } = makeStore();
    store.commit(progressAt(10), { expectedCursorRevision: 0 });

    // Rewind-style: asserts the old revision, persists the bumped one (the
    // browser projection reset rewinds this way).
    store.commit(progressAt(4, 1), { expectedCursorRevision: 0 });

    // A continuation of the pre-rewind cursor is now stale.
    expect(() => store.commit(progressAt(11), { expectedCursorRevision: 0 })).toThrow(
      /expected cursorRevision 0, persisted 1/,
    );
    store.commit(progressAt(11, 1), { expectedCursorRevision: 1 });
    expect(store.read()).toEqual(progressAt(11, 1));
  });

  it("MONOTONIC fence: a same-revision backward acknowledgement is rejected; only a revision bump may rewind", () => {
    const { store, map } = makeStore();
    store.commit(progressAt(10), { expectedCursorRevision: 0 });

    // A stale incarnation committing older progress at the SAME revision
    // passes the revision CAS — the monotonic fence must stop it from
    // rolling durable acknowledgement (and state) backward.
    expect(() => store.commit(progressAt(4), { expectedCursorRevision: 0 })).toThrow(
      /backward.*without a cursorRevision bump/,
    );
    expect(store.read()).toEqual(progressAt(10)); // the fenced commit wrote nothing
    expect(map.get(progressKey)).toEqual(progressAt(10));

    // The sanctioned backward move: a rewind bumps the revision under the
    // old expected value.
    store.commit(progressAt(4, 1), { expectedCursorRevision: 0 });
    expect(store.read()).toEqual(progressAt(4, 1));
  });
});

// =============================================================================
// durableObjectRecovery
// =============================================================================

describe("durableObjectRecovery", () => {
  function makeRecoveryFixture(args: { journal: Journal; storage: DurableObjectStorage }) {
    const clock = { now: Date.parse("2026-07-14T12:00:00Z") };
    const alarmCalls: (number | null)[] = [];
    /** One incarnation. Rebuild over the same storage to simulate an eviction:
     * only the KV record and the journal survive; keepalive flags do not. */
    const build = () =>
      durableObjectRecovery({
        storage: args.storage,
        slug: SLUG,
        stream: args.journal.stream,
        revivedEventType: REVIVED,
        version: "v1",
        armAlarm: (atMs) => void alarmCalls.push(atMs),
        waitUntil: (work) => void work.catch(() => undefined),
        now: () => clock.now,
      });
    const readRecord = () =>
      (args.storage as unknown as { kv: { get(key: string): unknown } }).kv.get(
        processorKeepaliveKey(SLUG),
      ) as KeepaliveRecord | undefined;
    return { clock, alarmCalls, build, readRecord };
  }

  it("exposes its revivedEventType so the runner's construction check can validate exact identity", () => {
    const journal = makeJournal();
    const { storage } = makeStorage();
    const fixture = makeRecoveryFixture({ journal, storage });
    expect(fixture.build().revivedEventType).toBe(REVIVED);
  });

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
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); // let the settlement propagate
    fixture.clock.now = fixture.readRecord()!.armedAtMs! + 1;
    await recovery.handleAlarm();
    expect(fixture.alarmCalls.at(-1)).toBeNull();
    expect(fixture.readRecord()?.armedAtMs).toBeNull();
    expect(fixture.readRecord()?.revivals).toBe(0);
    expect(journal.rows.filter((row) => row.type === REVIVED)).toHaveLength(0);
  });

  it("died owing work: the alarm fires in a fresh incarnation and appends the revived fact exactly once, stably keyed", async () => {
    const journal = makeJournal();
    const { storage } = makeStorage();
    const fixture = makeRecoveryFixture({ journal, storage });

    // Incarnation 1 dies owing this never-settling work.
    const first = fixture.build();
    first.keepAliveWhile(() => new Promise(() => {}));
    const armedAt = fixture.readRecord()!.armedAtMs!;

    // Incarnation 2 boots: construction re-issues the persisted desire — the
    // lost-platform-alarm heal the host performs on every dial.
    const callsBefore = fixture.alarmCalls.length;
    const second = fixture.build();
    expect(fixture.alarmCalls.length).toBe(callsBefore + 1);
    expect(fixture.alarmCalls.at(-1)).toBe(armedAt);

    // The durable alarm fires: nothing in flight, nothing settled clean in
    // this incarnation ⇒ the revival lane. The mark is written BEFORE the
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

    // Stable within the attempt: a retry of the same revival (same durable
    // mark) dedupes on the idempotency key instead of double-journaling.
    await second.appendRevived();
    expect(journal.rows.filter((row) => row.type === REVIVED)).toHaveLength(1);
    expect(journal.attempts.filter((event) => event.type === REVIVED)).toHaveLength(2);
  });

  it("wired into a real runner: a frame that dies owing background work is revived end-to-end through runner.handleAlarm", async () => {
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
    const opened = await runner1.openDelivery();
    await opened.sink({ events: journal.rows.slice(), streamMaxOffset: 1 });
    // The frame checkpointed — no lag left — but the alarm is armed: "died
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
          if (args.event === null) return;
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
    // resumes from the durable acknowledgement (1 — the dead frame DID
    // checkpoint) and hands the processor its revived event.
    const reopened = await runner2.openDelivery();
    expect(reopened.checkpointOffset).toBe(1);
    const pending = journal.rows.filter((row) => row.offset > reopened.checkpointOffset);
    await reopened.sink({ events: pending, streamMaxOffset: journal.head() });
    expect(processedTypes).toEqual([REVIVED]);
    await expect(runner2.snapshot()).resolves.toEqual({ offset: 2, state: { ids: ["a"] } });
  });
});
