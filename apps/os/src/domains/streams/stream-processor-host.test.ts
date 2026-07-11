// Host-level recovery mechanics against the REAL createStreamProcessorHost:
// the revival pass (fact + catch-up + reconciliations), the crash-loop
// breaker driven full-stack by a genuinely poisoned batch, and the shared
// alarm's slice merging. The keepalive's own state machine has exhaustive
// unit coverage in stream-processor-keepalive.test.ts; these tests prove the
// wiring — storage keys, alarm plumbing, fenced streams, catch-up rethrow —
// against the same code the Durable Objects run.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineProcessorContract } from "./processor-contracts.ts";
import { StreamProcessor, type StreamProcessorConstructorArgs } from "./stream-processor.ts";
import { PROCESSOR_HOST_REVIVED_EVENT_TYPE } from "./stream-processor-host.ts";
import { revivalBackoffMs, type KeepaliveRecord } from "./stream-processor-keepalive.ts";
import type { SubscriberMetricsReport } from "./subscriber-metrics.ts";
import { createProcessorHostHarness } from "./test-helpers.ts";

const PING = "events.iterate.com/test/ping";
const POISON = "events.iterate.com/test/poison";

function recorderContract(slug: string) {
  return defineProcessorContract({
    slug,
    version: "0",
    description: "test recorder",
    stateSchema: z.object({ pings: z.number().default(0) }),
    events: {
      [PING]: { description: "ping", payloadSchema: z.looseObject({}) },
      [POISON]: { description: "poison", payloadSchema: z.looseObject({}) },
    },
    consumes: [PING, POISON],
    emits: [],
  });
}

const RecorderA = recorderContract("recorder-a");
const RecorderB = recorderContract("recorder-b");

type RecorderContract = ReturnType<typeof recorderContract>;

class Recorder extends StreamProcessor<RecorderContract> {
  readonly batches: string[][] = [];
  constructor(
    readonly contract: RecorderContract,
    args: StreamProcessorConstructorArgs<RecorderContract, object>,
    readonly poisoned?: () => boolean,
  ) {
    super(args);
  }
  protected override async processEventBatch(
    args: Parameters<StreamProcessor<ReturnType<typeof recorderContract>>["processEventBatch"]>[0],
  ): Promise<void> {
    this.batches.push(args.events.map((event) => event.type));
    if (args.events.some((event) => event.type === POISON) && this.poisoned?.() === true) {
      args.blockProcessorWhile(() => Promise.reject(new Error("poisoned batch")));
    } else if (args.events.some((event) => event.type === PING)) {
      // Registered work is what arms the keepalive; a ping stands in for any
      // real processor's side effects.
      args.blockProcessorWhile(() => Promise.resolve());
    }
    await super.processEventBatch(args);
  }
}

describe("revival", () => {
  it("appends the fact, cold-pulls every processor, and their reconciliations see it", async () => {
    const h = createProcessorHostHarness({
      build: (host) => ({
        a: host.add((deps) => new Recorder(RecorderA, deps)),
        b: host.add((deps) => new Recorder(RecorderB, deps)),
      }),
    });
    await h.stream.append({ type: PING, payload: {} });
    await h.deliverAll();
    // Track work that "dies": ping processed, but hang background work so the
    // alarm stays armed at eviction (any registered work does this).
    await h.stream.append({ type: PING, payload: {} });
    await h.deliverAll();
    expect(h.store.alarm.at).not.toBeNull();

    h.crash();
    await h.advance(15_000);

    const revived = h.stream.events.find(
      (event) => event.type === PROCESSOR_HOST_REVIVED_EVENT_TYPE,
    );
    expect(revived?.payload).toMatchObject({
      revivals: 1,
      processors: ["recorder-a", "recorder-b"],
    });
    // BOTH processors got a post-revival batch containing the fact — even
    // though neither consumes it (catch-up is unfiltered, unlike wake push).
    for (const recorder of [h.processors.a, h.processors.b]) {
      expect(recorder.batches.some((types) => types.includes(revived!.type))).toBe(true);
    }
  });

  it("a poisoned batch decays along the breaker's backoff and heals on the antidote deploy", async () => {
    let version = "v1";
    let poisoned = true;
    const h = createProcessorHostHarness({
      version: () => version,
      build: (host) => ({
        a: host.add((deps) => new Recorder(RecorderA, deps, () => poisoned)),
      }),
    });
    await h.stream.append({ type: POISON, payload: {} });
    await h.deliverAll(); // batch fails (swallowed); keepalive saw the failure

    // Every revival re-pulls the poison batch, fails, and backs off further.
    for (const expected of [1, 2, 3].map((n) => revivalBackoffMs(n))) {
      const firesAt = h.store.alarm.at!;
      await h.advance(firesAt - h.clock.now);
      expect(h.store.alarm.at).toBe(h.clock.now + expected);
    }
    const record = () => h.store.kv.get("stream-processor-host:keepalive") as KeepaliveRecord;
    expect(record().revivals).toBe(3);
    // Journaled evidence at the threshold, keyed on the version.
    expect(
      h.stream.events.some((event) => event.idempotencyKey === "processor-host-crash-loop:v1"),
    ).toBe(true);

    // The antidote deploy: new version, bug gone. The next revival starts
    // from a fresh budget and the pass succeeds.
    version = "v2";
    poisoned = false;
    h.crash();
    await h.advance(h.store.alarm.at! - h.clock.now); // exactly the next fire
    expect(record()).toMatchObject({ revivals: 1, version: "v2" });
    // The quiet-clean confirmation then resets the budget entirely.
    await h.advance(60_000);
    expect(record().revivals).toBe(0);
    expect(h.store.alarm.at).toBeNull();
  });
});

describe("lost-alarm self-healing", () => {
  it("a fresh incarnation re-issues a persisted-but-lost alarm desire on boot", async () => {
    // The unrecoverable-wedge shape from review round 1: the record says
    // armed, but the platform alarm is GONE (a setAlarm that failed, or an
    // eviction between the fire and the re-arm landing). The next dial of the
    // DO must re-issue the desire — otherwise the record lies forever and the
    // zero-lag wedge is back, one storage failure deep.
    const h = createProcessorHostHarness({
      build: (host) => ({ a: host.add((deps) => new Recorder(RecorderA, deps)) }),
    });
    await h.stream.append({ type: PING, payload: {} });
    await h.deliverAll();
    expect(h.store.alarm.at).not.toBeNull();

    h.store.alarm.at = null; // the platform alarm is lost
    h.crash(); // and the DO is dialed again in a fresh incarnation
    await vitestSettle();
    // Boot re-issued the persisted desire; it is in the past, so it fires
    // immediately and the revival pass runs.
    expect(h.store.alarm.at).not.toBeNull();
    await h.advance(15_000);
    expect(h.stream.events.some((event) => event.type === PROCESSOR_HOST_REVIVED_EVENT_TYPE)).toBe(
      true,
    );
  });

  it("a due slice is dropped at its own fire instead of re-arming the alarm in the past", async () => {
    // The scheduler-shaped refire loop from review round 1: the slice that
    // caused the fire must not survive into the post-fire reconcile, or the
    // just-consumed alarm gets re-armed at a PAST time and refires
    // concurrently with the handler body still running.
    const h = createProcessorHostHarness({
      build: (host) => ({ a: host.add((deps) => new Recorder(RecorderA, deps)) }),
    });
    void h.host.setAlarmSlice("scheduler", h.clock.now + 30_000);
    await vitestSettle();
    expect(h.store.alarm.at).toBe(h.clock.now + 30_000);

    await h.advance(30_000); // the scheduler slice fires
    await vitestSettle();
    // Its owner did not re-arm (this test has no scheduler body); the desire
    // is gone rather than re-armed in the past.
    expect(h.host.getAlarmSlice("scheduler")).toBeNull();
    expect(h.store.alarm.at).toBeNull();
  });
});

describe("filtered wake-lane delivery", () => {
  it("a consumes-filtered batch left behind the head gets a trailing unfiltered catch-up", async () => {
    // Production's wake lane filters delivered events through the contract's
    // consumes list but stamps batches with the RAW head. A non-consumed tail
    // event (a presence fact, another processor's chunk) therefore leaves the
    // checkpoint legitimately behind streamMaxOffset with no further delivery
    // coming — and the reconcilers' at-head gate defers on such folds. The
    // host must converge it: a trailing unfiltered catch-up after the behind
    // batch. Without it, this is the review-round-2 forever-wedge.
    const h = createProcessorHostHarness({
      build: (host) => ({ a: host.add((deps) => new Recorder(RecorderA, deps)) }),
    });
    const [ping] = await h.stream.append({ type: PING, payload: {} });
    await h.stream.append({ type: "events.iterate.com/other/presence-fact", payload: {} });

    const wake = await h.host.wakeStreamSubscriber({
      stream: { projectId: "prj_test", path: h.stream.path, streamMaxOffset: 2 },
      subscriptionKey: "wake:recorder-a",
      processorSlug: "recorder-a",
    });
    // The spine's filtered delivery: only the consumed event, raw head as max.
    await wake.sink({
      projectId: "prj_test",
      path: h.stream.path,
      events: [ping!],
      streamMaxOffset: 2,
    } as Parameters<typeof wake.sink>[0]);

    // The trailing catch-up pulls the non-consumed tail; the checkpoint
    // reaches the true head, so the deferred reconciliation ran at-head.
    await vi.waitFor(async () => {
      expect((await h.processors.a.snapshot()).offset).toBe(2);
    });
    const lastBatch = h.processors.a.batches.at(-1)!;
    expect(lastBatch).toContain("events.iterate.com/other/presence-fact");
  });

  it("a failed trailing pull reads as a FAILURE; the next fire revives and converges", async () => {
    // The trailing pull is the ONLY delivery owed for a non-consumed tail. If
    // its failure settled clean, the keepalive would disarm with the
    // checkpoint stranded behind the at-head gate and no future dial owed —
    // the zero-lag wedge reborn one layer up. It must poison the quiet-clean
    // window instead, so the alarm's next fire takes the revival lane, whose
    // unfiltered catch-up is the pull's retry.
    const h = createProcessorHostHarness({
      build: (host) => ({ a: host.add((deps) => new Recorder(RecorderA, deps)) }),
    });
    const [ping] = await h.stream.append({ type: PING, payload: {} });
    await h.stream.append({ type: "events.iterate.com/other/presence-fact", payload: {} });
    const wake = await h.host.wakeStreamSubscriber({
      stream: { projectId: "prj_test", path: h.stream.path, streamMaxOffset: 2 },
      subscriptionKey: "wake:recorder-a",
      processorSlug: "recorder-a",
    });

    // One transient stream-read failure, timed to hit exactly the trailing pull.
    const readEvents = h.stream.readEvents.bind(h.stream);
    let readFailures = 0;
    h.stream.readEvents = (input) => {
      if (readFailures === 0) {
        readFailures += 1;
        throw new Error("transient stream read failure");
      }
      return readEvents(input);
    };
    await wake.sink({
      projectId: "prj_test",
      path: h.stream.path,
      events: [ping!],
      streamMaxOffset: 2,
    } as Parameters<typeof wake.sink>[0]);
    await vi.waitFor(() => expect(readFailures).toBe(1));
    expect((await h.processors.a.snapshot()).offset).toBe(1); // stranded behind head
    expect(h.store.alarm.at).not.toBeNull();

    await h.advance(60_000);
    // Not a quiet-clean disarm: the fire revived, and the revival's catch-up
    // (stream healed) pulled the tail plus its own fact through to head…
    expect(h.stream.events.some((event) => event.type === PROCESSOR_HOST_REVIVED_EVENT_TYPE)).toBe(
      true,
    );
    expect((await h.processors.a.snapshot()).offset).toBe(3);
    // …and the confirmation fire then stood the alarm down for good.
    expect(h.store.alarm.at).toBeNull();
  });
});

describe("catch-up head reporting", () => {
  it("non-final pages carry a streamMaxOffset past their tail; only the head batch is at-head", async () => {
    // Reconcilers gate side effects on checkpointOffset >= streamMaxOffset —
    // which only works if a behind batch can SEE it is behind. Three pings
    // through a page size of 2: page one must NOT report itself at head.
    const atHead: boolean[] = [];
    class GateRecorder extends Recorder {
      protected override async processEventBatch(
        args: Parameters<Recorder["processEventBatch"]>[0],
      ): Promise<void> {
        atHead.push(args.checkpointOffset >= args.streamMaxOffset);
        await super.processEventBatch(args);
      }
    }
    const h = createProcessorHostHarness({
      catchUpPageSize: 2,
      build: (host) => ({ a: host.add((deps) => new GateRecorder(RecorderA, deps)) }),
    });
    await h.stream.append(
      { type: PING, payload: {} },
      { type: PING, payload: {} },
      {
        type: PING,
        payload: {},
      },
    );
    await h.deliverAll();
    expect(atHead).toEqual([false, true]);
  });
});

describe("the shared alarm", () => {
  it("arms the earliest slice and keeps other desires when one clears", async () => {
    const h = createProcessorHostHarness({
      build: (host) => ({ a: host.add((deps) => new Recorder(RecorderA, deps)) }),
    });
    h.host.setAlarmSlice("scheduler", h.clock.now + 60_000);
    await Promise.resolve(); // the alarm write chain is serialized async
    await vitestSettle();
    expect(h.store.alarm.at).toBe(h.clock.now + 60_000);
    expect(h.host.getAlarmSlice("scheduler")).toBe(h.clock.now + 60_000);

    // Keepalive work arms earlier; the merged alarm moves up.
    await h.stream.append({ type: PING, payload: {} });
    await h.deliverAll();
    await vitestSettle();
    expect(h.store.alarm.at).toBe(h.clock.now + 10_000);

    // The keepalive settles (quiet-clean fire) — the scheduler's desire wins back.
    await h.advance(10_000);
    await vitestSettle();
    expect(h.store.alarm.at).toBe(h.clock.now + 50_000);
  });

  it("adopts a previous incarnation's durable alarm instead of clobbering it", async () => {
    const h = createProcessorHostHarness({
      build: (host) => ({ a: host.add((deps) => new Recorder(RecorderA, deps)) }),
    });
    // A previous incarnation (say the scheduler's slice) left an alarm armed;
    // the fresh incarnation's in-memory slices know nothing about it.
    const inherited = h.clock.now + 120_000;
    h.store.alarm.at = inherited;
    h.crash();

    // Between fires, this incarnation's arming and clearing must not lose the
    // inherited desire. (AT a fire every subsystem re-derives its own desire,
    // which is why the fire may drop it — that path is production-covered by
    // the scheduler re-arming inside its alarm handler.)
    h.host.setAlarmSlice("x", h.clock.now + 5_000);
    await vitestSettle();
    expect(h.store.alarm.at).toBe(h.clock.now + 5_000); // earliest wins
    h.host.setAlarmSlice("x", null);
    await vitestSettle();
    expect(h.store.alarm.at).toBe(inherited); // restored, not deleted
  });
});

describe("live-state assembly", () => {
  // A recorder whose FOLD differs from the schema default — that difference is
  // what lets the test tell "loaded checkpoint" apart from "published default".
  class CountingRecorder extends Recorder {
    protected override reduce(args: Parameters<Recorder["reduce"]>[0]) {
      return args.event.type === PING ? { pings: args.state.pings + 1 } : args.state;
    }
  }

  it("refreshLive on a COLD incarnation loads the checkpoint instead of publishing schema defaults", async () => {
    const h = createProcessorHostHarness({
      build: (host) => ({ a: host.add((deps) => new CountingRecorder(RecorderA, deps)) }),
    });
    await h.stream.append({ type: PING, payload: {} });
    await h.deliverAll(); // checkpoint written; the ingest observer assembled live state
    expect(h.host.live.getState()).toEqual({ pings: 1 });

    h.crash(); // cold incarnation: the checkpoint is in storage, nothing loaded yet

    // The regression: a synchronous refresh on a cold DO (touchStreamActivity's
    // lane) must not publish the schema default ({ pings: 0 }) over the real
    // fold — it defers to load-then-assemble instead.
    h.host.refreshLive();
    expect(h.host.live.getState()).not.toEqual({ pings: 0 });
    await vi.waitFor(() => expect(h.host.live.getState()).toEqual({ pings: 1 }));
  });

  it("a checkpoint DISCARDED at load (schema mismatch) refolds from the journal before publishing", async () => {
    const h = createProcessorHostHarness({
      build: (host) => ({ a: host.add((deps) => new CountingRecorder(RecorderA, deps)) }),
    });
    await h.stream.append({ type: PING, payload: {} });
    await h.deliverAll();
    expect(h.host.live.getState()).toEqual({ pings: 1 });

    h.crash();
    // The aftermath of a state-shape deploy: the stored checkpoint no longer
    // fits the schema. Load discards it — and must NOT treat the resulting
    // schema default as the fold (isLoaded stays false until the refold).
    h.store.kv.set(`stream-processor:${RecorderA.slug}:snapshot`, {
      offset: 1,
      state: { pings: "corrupt" },
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The read lane (liveState.get/subscribe): load, catch the discarded
      // processor up from the journal, then assemble — never the default.
      await h.host.loadAndRefreshLive();
      expect(h.host.live.getState()).toEqual({ pings: 1 });
      expect(h.processors.a.isLoaded).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a discarded checkpoint over an EMPTY journal still becomes loaded (zero-batch catch-up)", async () => {
    const h = createProcessorHostHarness({
      build: (host) => ({ a: host.add((deps) => new CountingRecorder(RecorderA, deps)) }),
    });
    // Nothing ever appended; only a corrupt checkpoint exists. The catch-up
    // delivers zero batches, so only the host's markLoaded confirmation can
    // flip the gate — without it, liveState would serve the {} seed forever.
    h.store.kv.set(`stream-processor:${RecorderA.slug}:snapshot`, {
      offset: 0,
      state: { pings: "corrupt" },
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await h.host.loadAndRefreshLive();
      // The schema default IS the fold of an empty journal — published, not wedged.
      expect(h.host.live.getState()).toEqual({ pings: 0 });
      expect(h.processors.a.isLoaded).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });
});

/** Drain the microtask queue a few turns so serialized alarm writes land. */
async function vitestSettle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("subscriber metrics", () => {
  it("the wake handshake answers pings and merges self-measured metrics into getRuntimeState", async () => {
    const h = createProcessorHostHarness({
      build: (host) => ({ a: host.add((deps) => new Recorder(RecorderA, deps)) }),
    });
    const [ping] = await h.stream.append({ type: PING, payload: {} });
    const wake = await h.host.wakeStreamSubscriber({
      stream: { projectId: "prj_test", path: h.stream.path, streamMaxOffset: 1 },
      subscriptionKey: "wake:recorder-a",
      processorSlug: "recorder-a",
    });

    // The mutual ping's responder half: echoes t0, reports receive/reply
    // times on its own clock (see StreamPingReply in rpc-types.ts).
    const reply = await wake.ping!({ t0: 123 });
    expect(reply.t0).toBe(123);
    expect(reply.t2).toBeGreaterThanOrEqual(reply.t1);

    await wake.sink({
      projectId: "prj_test",
      path: h.stream.path,
      events: [ping!],
      streamMaxOffset: 1,
    } as Parameters<typeof wake.sink>[0]);
    await vi.waitFor(async () => {
      expect((await h.processors.a.snapshot()).offset).toBe(1);
    });

    // Metrics are merged into the handshake's getRuntimeState answer (never
    // fabricated: only genuinely measured stats are non-null).
    const state = await wake.getRuntimeState!();
    const metrics = (state.runtime as { metrics: SubscriberMetricsReport }).metrics;
    expect(metrics.batchesIngested).toBeGreaterThanOrEqual(1);
    expect(metrics.eventsIngested).toBeGreaterThanOrEqual(1);
    expect(metrics.ingestMs).not.toBeNull();
    expect(metrics.deliveryAgeMs).not.toBeNull();
    expect(metrics.consumeOwnAppendMs).toBeNull(); // no own appends were made
    expect(metrics.clockOffsetMs).not.toBeNull(); // the ping above fed it
  });
});
