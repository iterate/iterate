// Host-level recovery mechanics against the REAL createStreamProcessorHost:
// the revival pass (fact + catch-up + reconciliations), the crash-loop
// breaker driven full-stack by a genuinely poisoned batch, and the shared
// alarm's slice merging. The keepalive's own state machine has exhaustive
// unit coverage in stream-processor-keepalive.test.ts; these tests prove the
// wiring — storage keys, alarm plumbing, fenced streams, catch-up rethrow —
// against the same code the Durable Objects run.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { recordedSpans, resetRecordedSpans } from "../../test/cloudflare-workers-shim.ts";
import { defineProcessorContract } from "./processor-contracts.ts";
import type { StreamProcessorEventBatch } from "./rpc-types.ts";
import type { StreamEvent } from "./schemas.ts";
import { StreamProcessor, type StreamProcessorConstructorArgs } from "./stream-processor.ts";
import { PROCESSOR_HOST_REVIVED_EVENT_TYPE } from "./stream-processor-host.ts";
import { revivalBackoffMs, type KeepaliveRecord } from "./stream-processor-keepalive.ts";
import type { SubscriberMetricsReport } from "./subscriber-metrics.ts";
import { appendTestEvents, createProcessorHostHarness } from "./test-helpers.ts";

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

const snapshotKey = (contract: { slug: string; version: string }) =>
  `stream-processor:${contract.slug}:${contract.version}:snapshot`;

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

function eventBatch(event: StreamEvent): StreamProcessorEventBatch {
  return {
    events: [event],
    deliveryThroughOffset: event.offset,
    streamMaxOffset: event.offset,
  };
}

describe("wake sink failure fence", () => {
  it("makes one handshake terminal after the first failed ingest and replays the exact suffix", async () => {
    const h = createProcessorHostHarness({
      build: (host) => ({
        a: host.add((deps) => new Recorder(RecorderA, deps)),
      }),
    });
    const attemptedOffsets: number[] = [];
    const successfulOffsets: number[] = [];
    let failOnceAtOffset: number | undefined = 2;
    const ingestThrough = h.processors.a.ingestThrough.bind(h.processors.a);
    vi.spyOn(h.processors.a, "ingestThrough").mockImplementation(async (args) => {
      const offset = args.events[0]?.offset;
      if (offset !== undefined) attemptedOffsets.push(offset);
      if (offset === failOnceAtOffset) {
        failOnceAtOffset = undefined;
        throw new Error(`injected ingest failure at offset ${offset}`);
      }
      await ingestThrough(args);
      if (offset !== undefined) successfulOffsets.push(offset);
    });
    const events = await appendTestEvents(
      h.stream,
      { type: PING, payload: {} },
      { type: PING, payload: {} },
      { type: PING, payload: {} },
      { type: PING, payload: {} },
    );
    const wake = await h.host.wakeStreamSubscriber({
      stream: { projectId: "prj_test", path: h.stream.path, streamMaxOffset: 4 },
      subscriptionKey: "wake:recorder-a",
      processorSlug: "recorder-a",
    });

    // Queue every call before the first ingest runs. Once offset 2 fails, this
    // returned sink is terminal: offsets 3-4 must reject without processing.
    const firstAttempt = await Promise.allSettled(
      events.map((event) => wake.sink(eventBatch(event))),
    );
    expect(firstAttempt.map(({ status }) => status)).toEqual([
      "fulfilled",
      "rejected",
      "rejected",
      "rejected",
    ]);
    expect(attemptedOffsets).toEqual([1, 2]);
    expect(successfulOffsets).toEqual([1]);
    expect((await h.processors.a.snapshot()).offset).toBe(1);

    const replay = await h.host.wakeStreamSubscriber({
      stream: { projectId: "prj_test", path: h.stream.path, streamMaxOffset: 4 },
      subscriptionKey: "wake:recorder-a",
      processorSlug: "recorder-a",
    });
    expect(replay.checkpointOffset).toBe(1);
    await Promise.all(events.slice(1).map((event) => replay.sink(eventBatch(event))));

    expect(attemptedOffsets).toEqual([1, 2, 2, 3, 4]);
    expect(successfulOffsets).toEqual([1, 2, 3, 4]);
    expect((await h.processors.a.snapshot()).offset).toBe(4);
  });
});

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
    resetRecordedSpans();
    void h.host.setAlarmSlice("scheduler", h.clock.now + 30_000);
    await vitestSettle();
    expect(h.store.alarm.at).toBe(h.clock.now + 30_000);

    await h.advance(30_000); // the scheduler slice fires
    await vitestSettle();
    // Its owner did not re-arm (this test has no scheduler body); the desire
    // is gone rather than re-armed in the past.
    expect(h.host.getAlarmSlice("scheduler")).toBeNull();
    expect(h.store.alarm.at).toBeNull();
    expect(recordedSpans).toContainEqual({
      name: "alarm processor keepalive",
      attributes: {
        "iterate.alarm.action": "not_due",
        "iterate.alarm.kind": "processor_keepalive",
      },
    });
  });
});

describe("filtered wake-lane delivery", () => {
  it("checkpoints through a filtered tail without a second journal read", async () => {
    const h = createProcessorHostHarness({
      build: (host) => ({ a: host.add((deps) => new Recorder(RecorderA, deps)) }),
    });
    const [ping] = await appendTestEvents(h.stream, { type: PING, payload: {} });
    await h.stream.append({ type: "events.iterate.com/other/presence-fact", payload: {} });
    let reads = 0;
    h.stream.readEvents = () => {
      reads += 1;
      throw new Error("filtered delivery must not pull the journal again");
    };

    const wake = await h.host.wakeStreamSubscriber({
      stream: { projectId: "prj_test", path: h.stream.path, streamMaxOffset: 2 },
      subscriptionKey: "wake:recorder-a",
      processorSlug: "recorder-a",
    });
    await wake.sink({
      events: [ping!],
      deliveryThroughOffset: 2,
      streamMaxOffset: 2,
    });

    await expect(h.processors.a.snapshot()).resolves.toMatchObject({ offset: 2 });
    expect(h.processors.a.batches.at(-1)).toEqual([PING]);
    expect(reads).toBe(0);
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

  it("a prior-version checkpoint refolds from the journal before publishing", async () => {
    const h = createProcessorHostHarness({
      build: (host) => ({ a: host.add((deps) => new CountingRecorder(RecorderA, deps)) }),
    });
    await h.stream.append({ type: PING, payload: {} });
    await h.deliverAll();
    expect(h.host.live.getState()).toEqual({ pings: 1 });
    expect(h.store.kv.get(snapshotKey(RecorderA))).toEqual({
      offset: 1,
      state: { pings: 1 },
    });

    h.crash();
    // State-shape deploys bump the contract version. The old checkpoint key
    // becomes a cache miss, and live state must wait for the journal refold.
    h.store.kv.delete(snapshotKey(RecorderA));
    h.store.kv.set(snapshotKey({ ...RecorderA, version: "previous" }), {
      offset: 1,
      state: { pings: "corrupt" },
    });

    // The read lane (liveState.get/subscribe): load the cache miss, catch the
    // processor up from the journal, then assemble — never the default.
    await h.host.loadAndRefreshLive();
    expect(h.host.live.getState()).toEqual({ pings: 1 });
    expect(h.processors.a.isLoaded).toBe(true);
  });

  it("a prior-version checkpoint over an EMPTY journal becomes loaded", async () => {
    const h = createProcessorHostHarness({
      build: (host) => ({ a: host.add((deps) => new CountingRecorder(RecorderA, deps)) }),
    });
    // Nothing ever appended; only an old checkpoint exists. The catch-up
    // delivers zero batches, so only the host's markLoaded confirmation can
    // flip the gate — without it, liveState would serve the {} seed forever.
    h.store.kv.set(snapshotKey({ ...RecorderA, version: "previous" }), {
      offset: 0,
      state: { pings: "corrupt" },
    });

    await h.host.loadAndRefreshLive();
    // The schema default IS the fold of an empty journal — published, not wedged.
    expect(h.host.live.getState()).toEqual({ pings: 0 });
    expect(h.processors.a.isLoaded).toBe(true);
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
    const [ping] = await appendTestEvents(h.stream, { type: PING, payload: {} });
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
      events: [ping!],
      deliveryThroughOffset: 1,
      streamMaxOffset: 1,
    });
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
    // Same clock domain as the stream: the ping answers but deliberately does
    // NOT record a clock offset (raw t1−t0 would book transport delay as skew).
    expect(metrics.clockOffsetMs).toBeNull();
  });
});
