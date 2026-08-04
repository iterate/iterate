// Isolation harness for createStreamProcessorRegistry — REAL registry + REAL
// runners + REAL durability adapters over a fake DurableObjectState (in-memory
// storage.kv, alarm cell, waitUntil), the in-memory MemoryStream journal, and
// a virtual clock. Nothing here re-tests runner internals (batch
// semantics live in stream-processor-runner.test.ts); it pins the registry's
// own jobs:
//
//  - the single-DO-alarm multiplex (earliest slice wins, inherited-alarm
//    adoption, due slices dropped at their own fire),
//  - one platform fire routed to EVERY runner (each keepalive self-gates),
//  - the wake response returning the runner's cursor + processEventBatch + capabilities,
//  - live-state assembly gated on isLoaded (a cold registry publishes
//    nothing until loaded, then the real fold),
//  - recovery revival: a runner that died owing work is revived by the alarm,
//    and on a two-processor DO only the runner that owes work revives.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { StreamProcessor } from "iterate/processors";
import { KEEPALIVE_ALARM_LEAD_MS } from "iterate/processors";
import { MemoryStream } from "iterate/processors/testing";
import {
  createStreamProcessorRegistry,
  type StreamProcessorRegistry,
} from "iterate/processors/cloudflare";
import { STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "iterate/processors";
import type { StreamProcessorWakeResponse, StreamWakeDeliveryResult } from "iterate/processors";

const HOME = "/tests/registry";
const STREAM_ID = "11111111-1111-4111-8111-111111111111";
const RECREATED_STREAM_ID = "22222222-2222-4222-8222-222222222222";
const REQUESTED = "events.iterate.com/registry-test/requested";
// Both slugs share the ONE core revival type; per-runner identity rides the
// payload's processorSlug (and the idempotency key), exactly as in production.
const REVIVED = STREAM_PROCESSOR_REVIVED_EVENT_TYPE;

// -----------------------------------------------------------------------------
// Processor fixture: `requested` folds an id into state; hooks observe every
// processEvent call (tests mutate the shared hooks object across incarnations,
// so behavior can differ before and after a crash). Both slugs share one
// contract shape — same pattern as the host test's recorderContract.
// -----------------------------------------------------------------------------

function recorderContract(slug: string) {
  return defineProcessorContract({
    slug,
    version: "0.0.1",
    description: "Registry harness recorder: requested folds an id, revived facts are consumed.",
    stateSchema: z.object({ ids: z.array(z.string()).default([]) }),
    events: {
      [REQUESTED]: { payloadSchema: z.object({ id: z.string() }) },
      // Defined LOCALLY so the harness stays free of the real core contract.
      [REVIVED]: { payloadSchema: z.looseObject({}) },
    },
    consumes: [REQUESTED, REVIVED],
    emits: [],
  });
}

type RecorderContract = ReturnType<typeof recorderContract>;

const AlphaContract = recorderContract("alpha-proc");
const BetaContract = recorderContract("beta-proc");

type RecorderHooks = {
  onProcess?: (args: Parameters<StreamProcessor<RecorderContract>["processEvent"]>[0]) => void;
};

class RecorderProcessor extends StreamProcessor<
  RecorderContract,
  { contract: RecorderContract; hooks: RecorderHooks }
> {
  get contract(): RecorderContract {
    return this.deps.contract;
  }

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<RecorderContract>["reduce"]>[0]) {
    if (event.type === REQUESTED) return { ids: [...state.ids, event.payload.id] };
    return state;
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<RecorderContract>["processEvent"]>[0],
  ): undefined {
    this.deps.hooks.onProcess?.(args);
  }
}

// -----------------------------------------------------------------------------
// Harness: fake DurableObjectState + MemoryStream journal + virtual clock +
// registry incarnations. crash() drops the incarnation (pending waitUntil work
// abandoned, like an eviction); the journal, KV, and durable alarm survive.
// -----------------------------------------------------------------------------

function makeHarness(
  opts: {
    betaRecovery?: boolean;
    onLiveAssembled?: (assembly: { skippedUnloadedRunners: boolean }) => void;
  } = {},
) {
  const clock = { now: Date.parse("2026-07-14T12:00:00Z") };
  const stream = new MemoryStream(HOME);
  stream.streamId = STREAM_ID;
  stream.now = () => clock.now;

  const kv = new Map<string, unknown>();
  const alarm: { at: number | null } = { at: null };
  let pending: Promise<unknown>[] = [];
  const ctx = {
    storage: {
      kv: {
        get: (key: string) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
        put: (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
        delete: (key: string) => kv.delete(key),
      },
      getAlarm: async () => alarm.at,
      setAlarm: async (at: number | Date) => {
        alarm.at = typeof at === "number" ? at : at.getTime();
      },
      deleteAlarm: async () => {
        alarm.at = null;
      },
    },
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise.catch(() => undefined)),
  } as unknown as DurableObjectState;

  const hooks: { alpha: RecorderHooks; beta: RecorderHooks } = { alpha: {}, beta: {} };

  let registry!: StreamProcessorRegistry;
  const boot = () => {
    registry = createStreamProcessorRegistry(ctx, {
      stream,
      path: HOME,
      projectId: null,
      version: "v-test",
      now: () => clock.now,
      ...(opts.onLiveAssembled === undefined ? {} : { onLiveAssembled: opts.onLiveAssembled }),
    });
    registry.register(
      new RecorderProcessor({
        stream,
        path: HOME,
        projectId: null,
        contract: AlphaContract,
        hooks: hooks.alpha,
      }),
      { recovery: true },
    );
    registry.register(
      new RecorderProcessor({
        stream,
        path: HOME,
        projectId: null,
        contract: BetaContract,
        hooks: hooks.beta,
      }),
      opts.betaRecovery === true ? { recovery: true } : undefined,
    );
  };
  boot();

  const settle = async () => {
    for (let round = 0; round < 5; round += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };
  const head = () => stream.events.at(-1)?.offset ?? 0;

  const harness = {
    clock,
    stream,
    kv,
    alarm,
    hooks,
    settle,
    head,
    get registry() {
      return registry;
    },
    /** Evict the incarnation: registry, runners, and in-flight work die; the
     * journal, KV, and the durable alarm survive into the next boot. */
    crash() {
      pending = [];
      boot();
    },
    async wake(slug: string, streamId = STREAM_ID) {
      return await registry.wakeStreamProcessor({
        stream: { projectId: null, path: HOME, streamId, streamMaxOffset: head() },
        subscriptionKey: `wake:${slug}`,
        processorSlug: slug,
      });
    },
    /** Wake `slug` and push everything past its acknowledged cursor as one
     * batch — the transport's job, minimally. */
    async deliverPending(slug: string) {
      const woken = await harness.wake(slug);
      const events = stream.events.filter((event) => event.offset > woken.checkpointOffset);
      if (events.length > 0) {
        const deliveryResult = await deliverWakeBatch(woken, {
          projectId: null,
          path: HOME,
          streamId: woken.streamId,
          events,
          scannedAfterOffset: woken.checkpointOffset,
          scannedThroughOffset: head(),
          streamMaxOffset: head(),
          state: null,
        });
        if (deliveryResult.outcome === "error") {
          throw new Error(deliveryResult.error.message);
        }
      }
      await settle();
      return woken;
    },
    /** Advance virtual time, firing the durable alarm through the REAL
     * handleAlarm path whenever it comes due within the window. */
    async advance(ms: number) {
      const target = clock.now + ms;
      while (alarm.at !== null && alarm.at <= target) {
        clock.now = Math.max(clock.now, alarm.at);
        alarm.at = null; // the platform consumes the alarm by firing it
        await registry.handleAlarm();
        await settle();
      }
      clock.now = target;
    },
  };
  return harness;
}

const hang = () => new Promise<never>(() => {});

async function deliverWakeBatch(
  woken: StreamProcessorWakeResponse,
  batch: Omit<
    Parameters<StreamProcessorWakeResponse["processEventBatch"]>[0],
    "reportDeliveryResult"
  >,
): Promise<StreamWakeDeliveryResult> {
  let report!: (value: StreamWakeDeliveryResult) => void;
  const reported = new Promise<StreamWakeDeliveryResult>((resolve) => {
    report = resolve;
  });
  woken.processEventBatch({
    ...batch,
    reportDeliveryResult: (value) => report(value),
  });
  return await reported;
}

/** The processorSlugs of every journaled revival fact, sorted — revivals share
 * the ONE core type, so the payload's slug is what identifies the runner. */
const revivedSlugs = (h: { stream: MemoryStream }) =>
  h.stream.events
    .filter((event) => event.type === REVIVED)
    .map((event) => (event.payload as { processorSlug: string }).processorSlug)
    .sort();

// =============================================================================
// Registration
// =============================================================================

describe("register", () => {
  it("rejects duplicate slugs", () => {
    const h = makeHarness();
    expect(() =>
      h.registry.register(
        new RecorderProcessor({
          stream: h.stream,
          path: HOME,
          projectId: null,
          contract: AlphaContract,
          hooks: {},
        }),
      ),
    ).toThrow(/already registered/);
  });
});

describe("catchUp", () => {
  it("propagates a lifecycle reset unretried — the calling door owns the one replay", async () => {
    const h = makeHarness();
    const reset = Object.assign(new Error("injected deploy reset"), { durableObjectReset: true });
    let calls = 0;
    h.stream.getEvents = async () => {
      calls += 1;
      throw reset;
    };

    await expect(h.registry.catchUp("alpha-proc")).rejects.toBe(reset);
    expect(calls).toBe(1);
  });

  it("does not replay or swallow application failures", async () => {
    const h = makeHarness();
    const failure = new Error("invalid processor input");
    let calls = 0;
    h.stream.getEvents = async () => {
      calls += 1;
      throw failure;
    };

    await expect(h.registry.catchUp("alpha-proc")).rejects.toBe(failure);
    expect(calls).toBe(1);
  });
});

// =============================================================================
// The single-DO-alarm multiplex
// =============================================================================

describe("alarm multiplex", () => {
  it("merges every slice's desire onto the one platform alarm — the earliest wins", async () => {
    const h = makeHarness();
    // A hanging background attempt arms alpha's keepalive slice at the lead.
    h.hooks.alpha.onProcess = (args) => args.runInBackground(hang);
    await h.stream.append({ type: REQUESTED, payload: { id: "a" } });
    await h.deliverPending("alpha-proc");

    const keepaliveAt = h.clock.now + KEEPALIVE_ALARM_LEAD_MS;
    expect(h.registry.getAlarmSlice("keepalive:alpha-proc")).toBe(keepaliveAt);
    expect(h.alarm.at).toBe(keepaliveAt);

    // A LATER desire must not clobber the earlier keepalive...
    await h.registry.setAlarmSlice("scheduler", h.clock.now + 30_000);
    expect(h.registry.getAlarmSlice("scheduler")).toBe(h.clock.now + 30_000);
    expect(h.alarm.at).toBe(keepaliveAt);

    // ...and an EARLIER one wins immediately.
    await h.registry.setAlarmSlice("urgent", h.clock.now + 1_000);
    expect(h.alarm.at).toBe(h.clock.now + 1_000);
  });

  it("adopts an inherited platform alarm and drops due slices at their fire instead of re-arming in the past", async () => {
    const h = makeHarness();
    // Armed by a previous incarnation whose owning slice is unknowable.
    const inheritedAt = h.clock.now - 5_000;
    h.alarm.at = inheritedAt;

    // The first reconcile adopts it: this incarnation's later desire cannot
    // clobber the inherited (earlier) alarm.
    await h.registry.setAlarmSlice("scheduler", h.clock.now + 30_000);
    expect(h.alarm.at).toBe(inheritedAt);

    // The platform fires the inherited alarm: the due (inherited) slice is
    // dropped, every runner is routed (none owes work — a no-op), and the
    // surviving scheduler desire becomes the new earliest.
    h.alarm.at = null;
    await h.registry.handleAlarm();
    expect(h.alarm.at).toBe(h.clock.now + 30_000);

    // The scheduler slice fires with no owner re-arm in this test: it is
    // dropped rather than re-armed in the past, and the alarm clears.
    await h.advance(30_000);
    expect(h.registry.getAlarmSlice("scheduler")).toBeNull();
    expect(h.alarm.at).toBeNull();
  });

  it("routes one platform fire to EVERY runner: both died owing work, one fire revives both", async () => {
    const h = makeHarness({ betaRecovery: true });
    const hangOnRequested: RecorderHooks["onProcess"] = (args) => {
      if (args.event === null) return;
      if (args.event.type === REQUESTED) args.runInBackground(hang);
    };
    h.hooks.alpha.onProcess = hangOnRequested;
    h.hooks.beta.onProcess = hangOnRequested;
    await h.stream.append({ type: REQUESTED, payload: { id: "a" } });
    await h.deliverPending("alpha-proc");
    await h.deliverPending("beta-proc");
    expect(h.alarm.at).not.toBeNull();

    // Both incarnations' checkpoints advanced (zero lag), both owe background
    // work, and the eviction takes it all.
    h.crash();
    await h.advance(KEEPALIVE_ALARM_LEAD_MS + 1);

    // ONE fire, routed to every runner: each keepalive self-gated as due and
    // journaled ITS revival fact — the shared core type, identified per
    // runner by the payload's processorSlug.
    expect(revivedSlugs(h)).toEqual(["alpha-proc", "beta-proc"]);
    // The safety-net retry stays armed after a revival pass (only a
    // quiet-clean confirmation disarms).
    expect(h.alarm.at).not.toBeNull();
  });
});

// =============================================================================
// Recovery revival
// =============================================================================

describe("recovery revival", () => {
  it("revives ONLY the runner that owes work, and its revived fact reaches its processor through ordinary delivery", async () => {
    const h = makeHarness(); // beta has NO recovery — the registry routes it the fire anyway
    h.hooks.alpha.onProcess = (args) => {
      if (args.event === null) return;
      if (args.event.type === REQUESTED) args.runInBackground(hang);
    };
    await h.stream.append({ type: REQUESTED, payload: { id: "a" } });
    await h.deliverPending("alpha-proc");
    await h.deliverPending("beta-proc"); // same fact, no registered work — owes nothing
    const armedAt = h.alarm.at;
    expect(armedAt).not.toBeNull();

    h.crash();
    // Boot re-issued alpha's persisted desire (the lost-platform-alarm heal
    // rides durableObjectRecovery's construction through the registry slice).
    await h.settle();
    expect(h.alarm.at).toBe(armedAt);

    const processed: string[] = [];
    h.hooks.alpha.onProcess = (args) => {
      if (args.event === null) return;
      processed.push(args.event.type);
    };
    await h.advance(KEEPALIVE_ALARM_LEAD_MS + 1);

    // Only the runner that owed work journaled a revival fact.
    expect(revivedSlugs(h)).toEqual(["alpha-proc"]);

    // The fact's ordinary delivery turn is the guaranteed recovery pass: the
    // wake resumes from the durable acknowledgement (the dead batch DID
    // checkpoint — that is the zero-lag wedge) and hands alpha its fact.
    const woken = await h.deliverPending("alpha-proc");
    expect(woken.checkpointOffset).toBe(1);
    expect(processed).toEqual([REVIVED]);
  });
});

// =============================================================================
// The processor wake request and response
// =============================================================================

describe("wakeStreamProcessor", () => {
  it("answers the runner's cursor, processEventBatch, announcement, and runtime capabilities", async () => {
    const h = makeHarness();
    // A multi-processor registry cannot guess which runner a wake is for.
    await expect(
      h.registry.wakeStreamProcessor({
        stream: { projectId: null, path: HOME, streamId: STREAM_ID, streamMaxOffset: 0 },
        subscriptionKey: "wake:unspecified",
      }),
    ).rejects.toThrow(/processorSlug/);

    // Pre-load everything so the commit-time observer assertion below is
    // synchronous (all runners loaded = assembleLive publishes inline).
    await h.registry.loadAndRefreshLive();
    expect(h.registry.live.getState()).toEqual({ ids: [] });

    await h.stream.append({ type: REQUESTED, payload: { id: "a" } });
    const woken = await h.wake("alpha-proc");
    expect(woken.streamId).toBe(STREAM_ID);
    expect(woken.checkpointOffset).toBe(0);
    const openedBy = woken.openedBy as {
      processor: { announcement: { slug: string; consumes: string[] } };
    };
    expect(openedBy.processor.announcement.slug).toBe("alpha-proc");

    // The returned callback is one-way. Its independent result reports when
    // the runner has durably advanced progress.
    await expect(
      deliverWakeBatch(woken, {
        projectId: null,
        path: HOME,
        streamId: STREAM_ID,
        events: h.stream.events.slice(),
        scannedAfterOffset: woken.checkpointOffset,
        scannedThroughOffset: h.head(),
        streamMaxOffset: h.head(),
        state: null,
      }),
    ).resolves.toEqual({ outcome: "ok" });
    const runtime = await woken.getRuntimeState!();
    expect(runtime.snapshot).toEqual({ offset: 1, state: { ids: ["a"] } });
    // The batch commit notified the registry's observer, which reassembled
    // live state synchronously (everything already loaded).
    expect(h.registry.live.getState()).toEqual({ ids: ["a"] });

    // A fresh wake resumes from the durably committed cursor.
    const rewoken = await h.wake("alpha-proc");
    expect(rewoken.checkpointOffset).toBe(1);
  });

  it("returns the callback call before blocking processor work and reports independently", async () => {
    const h = makeHarness();
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    h.hooks.alpha.onProcess = (args) => {
      if (args.event?.type === REQUESTED) {
        args.blockProcessorWhile(() => blocker);
      }
    };
    await h.stream.append({ type: REQUESTED, payload: { id: "slow" } });
    const woken = await h.wake("alpha-proc");
    let deliveryResult: StreamWakeDeliveryResult | undefined;

    const returned = woken.processEventBatch({
      projectId: null,
      path: HOME,
      streamId: STREAM_ID,
      events: h.stream.events.slice(),
      scannedAfterOffset: 0,
      scannedThroughOffset: h.head(),
      streamMaxOffset: h.head(),
      state: null,
      reportDeliveryResult: (value) => {
        deliveryResult = value;
      },
    });

    expect(returned).toBeUndefined();
    await h.settle();
    expect(deliveryResult).toBeUndefined();

    releaseBlocker();
    await expect.poll(() => deliveryResult).toEqual({ outcome: "ok" });
    await expect(woken.getRuntimeState!()).resolves.toMatchObject({
      snapshot: { offset: 1 },
    });
  });

  it("reports processor failures with lifecycle classification and ITX correlation intact", async () => {
    const h = makeHarness();
    const lifecycleReset = Object.assign(new Error("subscriber incarnation reset"), {
      durableObjectReset: true,
      itxCallId: "log_0123456789abcdef0123456789abcdef",
      retryable: true,
    });
    h.hooks.alpha.onProcess = (args) => {
      if (args.event?.type === REQUESTED) {
        args.blockProcessorWhile(() => Promise.reject(lifecycleReset));
      }
    };
    await h.stream.append({ type: REQUESTED, payload: { id: "reset" } });
    const woken = await h.wake("alpha-proc");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        deliverWakeBatch(woken, {
          projectId: null,
          path: HOME,
          streamId: STREAM_ID,
          events: h.stream.events.slice(),
          scannedAfterOffset: 0,
          scannedThroughOffset: h.head(),
          streamMaxOffset: h.head(),
          state: null,
        }),
      ).resolves.toEqual({
        outcome: "error",
        error: {
          name: "Error",
          message: "subscriber incarnation reset",
          durableObjectReset: true,
          itxCallId: "log_0123456789abcdef0123456789abcdef",
          retryable: true,
        },
      });
    } finally {
      errorLog.mockRestore();
    }
  });

  it("rejects a wake whose stream coordinate does not match the registry's own (isolation fence)", async () => {
    const h = makeHarness();
    await h.registry.loadAndRefreshLive();

    // A valid slug from the WRONG path — a stale, copied, or miswired
    // subscription pointing a sibling stream at this registry. Must be
    // rejected before it can fold foreign events into this processor.
    await expect(
      h.registry.wakeStreamProcessor({
        stream: {
          projectId: null,
          path: "/agents/someone-else",
          streamId: STREAM_ID,
          streamMaxOffset: 5,
        },
        subscriptionKey: "wake:alpha-proc",
        processorSlug: "alpha-proc",
      }),
    ).rejects.toThrow(/coordinate mismatch/);

    // A valid slug from the WRONG project (same path, foreign tenant).
    await expect(
      h.registry.wakeStreamProcessor({
        stream: {
          projectId: "prj_intruder",
          path: HOME,
          streamId: STREAM_ID,
          streamMaxOffset: 5,
        },
        subscriptionKey: "wake:alpha-proc",
        processorSlug: "alpha-proc",
      }),
    ).rejects.toThrow(/coordinate mismatch/);

    // The fence runs BEFORE slug resolution: a mismatched coordinate is
    // rejected as a mismatch, never as a missing/unknown slug.
    await expect(
      h.registry.wakeStreamProcessor({
        stream: {
          projectId: null,
          path: "/agents/someone-else",
          streamId: STREAM_ID,
          streamMaxOffset: 5,
        },
        subscriptionKey: "wake:unspecified",
      }),
    ).rejects.toThrow(/coordinate mismatch/);

    // The matching coordinate still works (control).
    const woken = await h.registry.wakeStreamProcessor({
      stream: { projectId: null, path: HOME, streamId: STREAM_ID, streamMaxOffset: 0 },
      subscriptionKey: "wake:alpha-proc",
      processorSlug: "alpha-proc",
    });
    expect(woken.checkpointOffset).toBe(0);
  });

  it("resets checkpoint and folded state for a recreated stream while rejecting the old callback", async () => {
    const h = makeHarness();
    await h.stream.append({ type: REQUESTED, payload: { id: "old" } });
    const oldWake = await h.deliverPending("alpha-proc");
    expect(oldWake.checkpointOffset).toBe(0);

    expect(() =>
      oldWake.processEventBatch({
        projectId: null,
        path: HOME,
        streamId: RECREATED_STREAM_ID,
        events: [],
        scannedAfterOffset: 1,
        scannedThroughOffset: 1,
        streamMaxOffset: 1,
        state: null,
        reportDeliveryResult: vi.fn(),
      }),
    ).toThrow(/received batch.*expected/);

    // The ID binding is durable, not merely an incarnation-local callback
    // guard. A host that survives the source stream's reset must atomically
    // replace lifetime A's checkpoint and fold before answering lifetime B.
    h.stream.events = [];
    h.stream.streamId = RECREATED_STREAM_ID;
    h.crash();
    const recreatedWake = await h.wake("alpha-proc", RECREATED_STREAM_ID);
    expect(recreatedWake.checkpointOffset).toBe(0);
    await expect(recreatedWake.getRuntimeState!()).resolves.toMatchObject({
      snapshot: { offset: 0, state: { ids: [] } },
    });

    await h.stream.append({ type: REQUESTED, payload: { id: "new" } });
    await expect(
      deliverWakeBatch(recreatedWake, {
        projectId: null,
        path: HOME,
        streamId: RECREATED_STREAM_ID,
        events: h.stream.events.slice(),
        scannedAfterOffset: 0,
        scannedThroughOffset: 1,
        streamMaxOffset: 1,
        state: null,
      }),
    ).resolves.toEqual({ outcome: "ok" });
    await expect(recreatedWake.getRuntimeState!()).resolves.toMatchObject({
      snapshot: { offset: 1, state: { ids: ["new"] } },
    });
  });
});

// =============================================================================
// Live-state assembly
// =============================================================================

describe("live state", () => {
  it("gates on isLoaded: a cold registry publishes nothing until loaded, then the real fold", async () => {
    const h = makeHarness();
    await h.stream.append({ type: REQUESTED, payload: { id: "a" } });
    await h.deliverPending("alpha-proc"); // commits real durable progress

    h.crash(); // cold incarnation: committed KV progress, nothing loaded yet
    h.registry.refreshLive();
    // Synchronously NOTHING was published — not the schema default (which
    // would wipe the real fact for live-state listeners), not anything else; the
    // refresh deferred to an async load-then-assemble.
    expect(h.registry.live.getState()).toEqual({});

    await h.registry.loadAndRefreshLive();
    expect(h.registry.live.getState()).toEqual({ ids: ["a"] });
  });

  it("notifies onLiveAssembled on every pass — skipped behind the runner wall, real once loaded", async () => {
    const assemblies: { skippedUnloadedRunners: boolean }[] = [];
    const h = makeHarness({ onLiveAssembled: (assembly) => assemblies.push(assembly) });

    // One runner folds while the other is still cold — the exact incarnation
    // shape a liveState-socket host must hear about (a silent skip here means
    // watchers never learn of the committed change).
    await h.stream.append({ type: REQUESTED, payload: { id: "a" } });
    await h.deliverPending("alpha-proc");
    expect(assemblies).toContainEqual({ skippedUnloadedRunners: true });
    expect(assemblies.filter((assembly) => !assembly.skippedUnloadedRunners)).toEqual([]);

    // Loading everything turns the next pass into a real assembly.
    await h.registry.loadAndRefreshLive();
    expect(assemblies.at(-1)).toEqual({ skippedUnloadedRunners: false });
    expect(h.registry.live.getState()).toEqual({ ids: ["a"] });
  });
});
