// Isolation harness for createStreamProcessorRegistry — REAL registry + REAL
// runners + REAL durability adapters over a fake DurableObjectState (in-memory
// storage.kv, alarm cell, waitUntil), the in-memory MemoryStream journal, and
// a virtual clock. Nothing here re-tests runner internals (frame
// semantics live in stream-processor-runner.test.ts); it pins the registry's
// own jobs:
//
//  - the single-DO-alarm multiplex (earliest slice wins, inherited-alarm
//    adoption, due slices dropped at their own fire),
//  - one platform fire routed to EVERY runner (each keepalive self-gates),
//  - the wake handshake answering the runner's cursor + sink + capabilities,
//  - live-state assembly gated on isLoaded (a cold registry publishes
//    nothing until loaded, then the real fold),
//  - recovery revival: a runner that died owing work is revived by the alarm,
//    and on a two-processor DO only the runner that owes work revives.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { StreamProcessor } from "iterate/processors";
import { KEEPALIVE_ALARM_LEAD_MS } from "iterate/processors";
import { MemoryStream } from "iterate/processors/testing";
import {
  createStreamProcessorRegistry,
  type StreamProcessorRegistry,
} from "iterate/processors/cloudflare";
import { STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "./core-processor-contract.ts";

const HOME = "/tests/registry";
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

function makeHarness(opts: { betaRecovery?: boolean } = {}) {
  const clock = { now: Date.parse("2026-07-14T12:00:00Z") };
  const stream = new MemoryStream(HOME);
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
    async wake(slug: string) {
      return await registry.wakeStreamSubscriber({
        stream: { projectId: null, path: HOME, streamMaxOffset: head() },
        subscriptionKey: `wake:${slug}`,
        processorSlug: slug,
      });
    },
    /** Wake `slug` and push everything past its acknowledged cursor as one
     * frame — the transport's job, minimally. */
    async deliverPending(slug: string) {
      const woken = await harness.wake(slug);
      const events = stream.events.filter((event) => event.offset > woken.checkpointOffset);
      if (events.length > 0) {
        await woken.sink({
          projectId: null,
          path: HOME,
          events,
          scannedAfterOffset: woken.checkpointOffset,
          scannedThroughOffset: head(),
          streamMaxOffset: head(),
          state: null,
        });
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
    // wake resumes from the durable acknowledgement (the dead frame DID
    // checkpoint — that is the zero-lag wedge) and hands alpha its fact.
    const woken = await h.deliverPending("alpha-proc");
    expect(woken.checkpointOffset).toBe(1);
    expect(processed).toEqual([REVIVED]);
  });
});

// =============================================================================
// The wake handshake
// =============================================================================

describe("wakeStreamSubscriber", () => {
  it("answers the runner's cursor, sink, announcement, and runtime capabilities", async () => {
    const h = makeHarness();
    // A multi-processor registry cannot guess which runner a poke is for.
    await expect(
      h.registry.wakeStreamSubscriber({
        stream: { projectId: null, path: HOME, streamMaxOffset: 0 },
        subscriptionKey: "wake:unspecified",
      }),
    ).rejects.toThrow(/processorSlug/);

    // Pre-load everything so the commit-time observer assertion below is
    // synchronous (all runners loaded = assembleLive publishes inline).
    await h.registry.loadAndRefreshLive();
    expect(h.registry.live.getState()).toEqual({ ids: [] });

    await h.stream.append({ type: REQUESTED, payload: { id: "a" } });
    const woken = await h.wake("alpha-proc");
    expect(woken.checkpointOffset).toBe(0);
    const subscriber = woken.subscriber as {
      processor: { announcement: { slug: string; consumes: string[] } };
    };
    expect(subscriber.processor.announcement.slug).toBe("alpha-proc");

    // The returned sink IS the runner's: driving it advances durable progress.
    await woken.sink({
      projectId: null,
      path: HOME,
      events: h.stream.events.slice(),
      scannedAfterOffset: woken.checkpointOffset,
      scannedThroughOffset: h.head(),
      streamMaxOffset: h.head(),
      state: null,
    });
    const runtime = await woken.getRuntimeState!();
    expect(runtime.snapshot).toEqual({ offset: 1, state: { ids: ["a"] } });
    // The frame commit notified the registry's observer, which reassembled
    // live state synchronously (everything already loaded).
    expect(h.registry.live.getState()).toEqual({ ids: ["a"] });

    // A fresh wake resumes from the durably committed cursor.
    const rewoken = await h.wake("alpha-proc");
    expect(rewoken.checkpointOffset).toBe(1);
  });

  it("rejects a wake whose stream coordinate does not match the registry's own (isolation fence)", async () => {
    const h = makeHarness();
    await h.registry.loadAndRefreshLive();

    // A valid slug from the WRONG path — a stale, copied, or miswired
    // subscription pointing a sibling stream at this registry. Must be
    // rejected before it can fold foreign events into this processor.
    await expect(
      h.registry.wakeStreamSubscriber({
        stream: { projectId: null, path: "/agents/someone-else", streamMaxOffset: 5 },
        subscriptionKey: "wake:alpha-proc",
        processorSlug: "alpha-proc",
      }),
    ).rejects.toThrow(/coordinate mismatch/);

    // A valid slug from the WRONG project (same path, foreign tenant).
    await expect(
      h.registry.wakeStreamSubscriber({
        stream: { projectId: "prj_intruder", path: HOME, streamMaxOffset: 5 },
        subscriptionKey: "wake:alpha-proc",
        processorSlug: "alpha-proc",
      }),
    ).rejects.toThrow(/coordinate mismatch/);

    // The fence runs BEFORE slug resolution: a mismatched coordinate is
    // rejected as a mismatch, never as a missing/unknown slug.
    await expect(
      h.registry.wakeStreamSubscriber({
        stream: { projectId: null, path: "/agents/someone-else", streamMaxOffset: 5 },
        subscriptionKey: "wake:unspecified",
      }),
    ).rejects.toThrow(/coordinate mismatch/);

    // The matching coordinate still works (control).
    const woken = await h.registry.wakeStreamSubscriber({
      stream: { projectId: null, path: HOME, streamMaxOffset: 0 },
      subscriptionKey: "wake:alpha-proc",
      processorSlug: "alpha-proc",
    });
    expect(woken.checkpointOffset).toBe(0);
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
    // would wipe the real fact for subscribers), not anything else; the
    // refresh deferred to an async load-then-assemble.
    expect(h.registry.live.getState()).toEqual({});

    await h.registry.loadAndRefreshLive();
    expect(h.registry.live.getState()).toEqual({ ids: ["a"] });
  });
});
