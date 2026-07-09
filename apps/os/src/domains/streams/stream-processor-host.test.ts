// Host-level recovery mechanics against the REAL createStreamProcessorHost:
// the revival pass (fact + catch-up + reconciliations), the crash-loop
// breaker driven full-stack by a genuinely poisoned batch, and the shared
// alarm's slice merging. The keepalive's own state machine has exhaustive
// unit coverage in stream-processor-keepalive.test.ts; these tests prove the
// wiring — storage keys, alarm plumbing, fenced streams, catch-up rethrow —
// against the same code the Durable Objects run.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineProcessorContract } from "./processor-contracts.ts";
import { StreamProcessor, type StreamProcessorConstructorArgs } from "./stream-processor.ts";
import { PROCESSOR_HOST_REVIVED_EVENT_TYPE } from "./stream-processor-host.ts";
import { revivalBackoffMs, type KeepaliveRecord } from "./stream-processor-keepalive.ts";
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

/** Drain the microtask queue a few turns so serialized alarm writes land. */
async function vitestSettle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}
