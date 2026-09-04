// The processor engine's concurrency contract, rule by rule (stream/processor.ts's header): the
// per-event barrier under slow and nested blockers (rule 2), background work that never blocks the
// commit (rule 3), one durable commit per batch — all or nothing (rule 4), exactly one caughtUp per
// at-head batch (rule 5), waitUntilProcessed under gap repair and concurrent timeouts, the
// version-bump re-reduce's edges, a flaky live-state projection, and ephemeral windows across a stale
// push, an eviction and a non-contiguous push. The hook-by-hook spec is processor.test.ts; the
// in-memory stream and storage are stream/test-support.ts. Each processor is the pure author class
// (`new X()`), driven by a `ProcessorEngine` — the engine is what wakes, snapshots and takes pushes.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineProcessorContract } from "../sdk/processor-contract.ts";
import type { StreamEvent, StreamEventInput } from "./events.ts";
import {
  ProcessorEngine,
  StreamProcessor,
  type ProcessEventArgs,
  type ReduceArgs,
} from "./processor.ts";
import { memoryStorage, memoryStream, settle } from "./test-support.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const contractOf = (slug: string, version: string, consumes: readonly string[]) =>
  defineProcessorContract({
    slug,
    version,
    description: "",
    stateSchema: z.object({ n: z.number().default(0) }),
    events: {},
    consumes,
    emits: [],
  });

// ═══════════════════════════════ rule 2 — the per-event barrier ═══════════════════════════════

describe("rule 2 — per-event barrier under slow blockers", () => {
  test("event N's slow blocker completes (by timestamp) before event N+1's processEvent starts", async () => {
    const mem = memoryStream();
    const startAt = new Map<number, number>();
    const blockedDoneAt = new Map<number, number>();
    const Contract = contractOf("slowbar", "1", ["e"]);
    class SlowProcessor extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
        if (!args.event) return;
        const offset = args.event.offset;
        startAt.set(offset, performance.now());
        args.blockProcessorWhile(async () => {
          await sleep(30); // slow on purpose — a scheduling hiccup must not let N+1 sneak in
          blockedDoneAt.set(offset, performance.now());
        });
      }
    }
    const p = new ProcessorEngine(new SlowProcessor(), {
      stream: mem.stream,
      storage: memoryStorage(),
    });
    mem.stream.append({ type: "e" }, { type: "e" }, { type: "e" }) as StreamEvent[];
    await p.catchUpFromLog();
    for (const offset of [1, 2]) {
      expect(blockedDoneAt.get(offset)).toBeDefined();
      expect(startAt.get(offset + 1)!).toBeGreaterThanOrEqual(blockedDoneAt.get(offset)!);
    }
  });

  test("a blocker registered from INSIDE a blocker holds the cursor (rule 2 fixed point)", async () => {
    // A blockProcessorWhile call made while a blocker of the SAME event is running is still THIS
    // event's blocking work: the chain drains to a fixed point, so `nested-done 1` precedes
    // `start 2` (rule 2) and the batch cannot commit while nested work is in flight (rule 4).
    const mem = memoryStream();
    const trace: string[] = [];
    const Contract = contractOf("nested", "1", ["e"]);
    class NestedProcessor extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
        if (!args.event) return;
        const offset = args.event.offset;
        trace.push(`start ${offset}`);
        args.blockProcessorWhile(async () => {
          await sleep(10);
          args.blockProcessorWhile(async () => {
            await sleep(40);
            trace.push(`nested-done ${offset}`);
          });
          trace.push(`outer-done ${offset}`);
        });
      }
    }
    const p = new ProcessorEngine(new NestedProcessor(), {
      stream: mem.stream,
      storage: memoryStorage(),
    });
    mem.stream.append({ type: "e" }, { type: "e" }) as StreamEvent[];
    await p.catchUpFromLog();
    await sleep(120); // let stragglers land so the trace is complete either way
    expect(trace.indexOf("start 2")).toBeGreaterThan(trace.indexOf("nested-done 1"));
  });
});

// ═══════════════════════ rule 3 — background work never blocks the commit ═══════════════════════

describe("rule 3 — runInBackground never blocks the batch commit", () => {
  test("the batch commits (cursor persisted) while background work is still in flight; a bg failure never fails the batch", async () => {
    const mem = memoryStream();
    const storage = memoryStorage();
    let bgDone = false;
    const Contract = contractOf("bg", "1", ["e"]);
    class BgProcessor extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      override reduce({ state }: ReduceArgs<{ n: number }>) {
        return { n: state.n + 1 };
      }
      override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
        if (!args.event) return;
        args.runInBackground(async () => {
          await sleep(80);
          bgDone = true;
          throw new Error("background attempt failed — must be swallowed, never the batch");
        });
      }
    }
    const p = new ProcessorEngine(new BgProcessor(), { stream: mem.stream, storage });
    const committed = mem.stream.append({ type: "e" }) as StreamEvent[];
    await p.processEventBatch(committed, { after: 0, through: 1 });
    // The batch is durably committed BEFORE the background work lands (overtaking allowed):
    expect(bgDone).toBe(false);
    expect(storage.read("bg")).toMatchObject({ reducedThroughOffset: 1 });
    await sleep(120);
    expect(bgDone).toBe(true); // and the attempt did run (droppable, not dropped here)
    // the failed background attempt never poisoned the chain — the next batch still commits
    const next = mem.stream.append({ type: "e" }) as StreamEvent[];
    await p.processEventBatch(next, { after: 1, through: 2 });
    expect((await p.snapshot()).offset).toBe(2);
  });
});

// ═══════════════════════════ rule 4 — one durable commit per batch ═══════════════════════════

describe("rule 4 — one durable commit per batch, all-or-nothing", () => {
  test("a throwing REDUCE on the last event is contained: the batch still commits exactly once, the event is skipped", async () => {
    const mem = memoryStream();
    const storage = memoryStorage();
    const effects: number[] = [];
    const Contract = contractOf("redthrow", "1", ["e"]);
    class RedThrowProcessor extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      override reduce({ event, state }: ReduceArgs<{ n: number }>) {
        if ((event.payload as { boom?: boolean } | undefined)?.boom)
          throw new Error("hostile payload");
        return { n: state.n + 1 };
      }
      override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
        if (args.event) effects.push(args.event.offset);
      }
    }
    const p = new ProcessorEngine(new RedThrowProcessor(), { stream: mem.stream, storage });
    const committed = mem.stream.append(
      { type: "e" },
      { type: "e" },
      { type: "e", payload: { boom: true } },
    ) as StreamEvent[];
    const before = storage.writes;
    await p.processEventBatch(committed, { after: 0, through: 3 });
    expect(storage.writes - before).toBe(1); // ONE persist: the checkpoint row, nothing extra
    expect(effects).toEqual([1, 2, 3]); // each event's processEvent ran exactly once
    const snap = await p.snapshot();
    expect(snap.offset).toBe(3); // cursor covers the skipped event — no wedge, no retry loop
    expect(snap.state.n).toBe(2); // the throwing event contributed nothing
  });

  test("a throwing BLOCKER on the LAST event persists NOTHING; the wake retries the batch WHOLE", async () => {
    const mem = memoryStream();
    const storage = memoryStorage();
    const effects: number[] = [];
    let attempts = 0;
    const Contract = contractOf("lastfail", "1", ["e"]);
    class LastFailProcessor extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      override reduce({ state }: ReduceArgs<{ n: number }>) {
        return { n: state.n + 1 };
      }
      override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
        if (!args.event) return;
        const offset = args.event.offset;
        effects.push(offset);
        args.blockProcessorWhile(async () => {
          if (offset === 3 && ++attempts === 1) throw new Error("boom on the last event");
        });
      }
    }
    const p = new ProcessorEngine(new LastFailProcessor(), { stream: mem.stream, storage });
    const committed = mem.stream.append(
      { type: "e" },
      { type: "e" },
      { type: "e" },
    ) as StreamEvent[];
    await expect(p.processEventBatch(committed, { after: 0, through: 3 })).rejects.toThrow(/boom/);
    expect(storage.writes).toBe(0); // events 1+2 fully processed, yet NOTHING persisted
    await p.catchUpFromLog(); // retried whole — 1 and 2 run again (droppable-attempt semantics)
    expect(effects).toEqual([1, 2, 3, 1, 2, 3]);
    expect(storage.writes).toBe(1); // and then exactly one persist
    expect((await p.snapshot()).state.n).toBe(3); // the reduce restarted from the persisted state
  });
});

// ═══════════════════════════════ rule 5 — exactly one caughtUp ═══════════════════════════════

const deliveryRecorder = (slug: string, consumes: readonly string[]) => {
  const deliveries: { offset: number | null; caughtUp: boolean }[] = [];
  const Contract = contractOf(slug, "1", consumes);
  class RecProcessor extends StreamProcessor<{ n: number }> {
    readonly contract = Contract;
    override reduce({ state }: ReduceArgs<{ n: number }>) {
      return { n: state.n + 1 };
    }
    override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
      deliveries.push({ offset: args.event?.offset ?? null, caughtUp: args.delivery.caughtUp });
    }
    // Opt out of the default live-state emit — these suites assert exact offsets, and a constant
    // projection never diffs (so no ephemeral delta consumes an offset under test).
    override projectLiveState() {
      return null;
    }
  }
  return { RecProcessor, deliveries };
};

describe("rule 5 — exactly one caughtUp per at-head batch", () => {
  test("last event of the batch NOT consumable → the last CONSUMABLE event carries the one caughtUp (no extra eventless pass)", async () => {
    const mem = memoryStream();
    const { RecProcessor, deliveries } = deliveryRecorder("lastfiltered", ["tick"]);
    const p = new ProcessorEngine(new RecProcessor(), {
      stream: mem.stream,
      storage: memoryStorage(),
    });
    const committed = mem.stream.append({ type: "tick" }, { type: "noise" }) as StreamEvent[];
    await p.processEventBatch(committed, { after: 0, through: 2 });
    expect(deliveries.filter((d) => d.caughtUp)).toHaveLength(1);
    expect(deliveries).toEqual([{ offset: 1, caughtUp: true }]); // the tick, not a null pass
  });

  test("no consumable event at all → exactly one eventless caughtUp pass", async () => {
    const mem = memoryStream();
    const { RecProcessor, deliveries } = deliveryRecorder("nonecons", ["tick"]);
    const p = new ProcessorEngine(new RecProcessor(), {
      stream: mem.stream,
      storage: memoryStorage(),
    });
    const committed = mem.stream.append({ type: "noise" }, { type: "noise" }) as StreamEvent[];
    await p.processEventBatch(committed, { after: 0, through: 2 });
    expect(deliveries).toEqual([{ offset: null, caughtUp: true }]);
  });

  test("a catch-up whose log length is an exact page multiple (500) still delivers caughtUp", async () => {
    // A FULL page that in fact ended at the head is no proof of "not at head": when the follow-up
    // read finds nothing new, the eventless at-head pass still runs — a log whose length is an
    // exact page multiple must not stall the at-head recovery work (obligation sweeps, "am I done").
    const mem = memoryStream();
    const { RecProcessor, deliveries } = deliveryRecorder("page500", ["tick"]);
    const p = new ProcessorEngine(new RecProcessor(), {
      stream: mem.stream,
      storage: memoryStorage(),
    });
    mem.stream.append(
      ...Array.from({ length: 500 }, () => ({ type: "tick" }) as StreamEventInput),
    ) as StreamEvent[];
    await p.catchUpFromLog();
    expect((await p.snapshot()).offset).toBe(500); // the reduce DID reach the head…
    expect(deliveries.filter((d) => d.caughtUp).length).toBeGreaterThanOrEqual(1); // …silently
  });
});

// ═══════════════════════════════════ waitUntilProcessed ═══════════════════════════════════

describe("waitUntilProcessed", () => {
  test("resolves for an offset that arrives via GAP REPAIR (no push ever delivered)", async () => {
    const mem = memoryStream();
    const { RecProcessor } = deliveryRecorder("gapwait", ["tick"]);
    const p = new ProcessorEngine(new RecProcessor(), {
      stream: mem.stream,
      storage: memoryStorage(),
    });
    // Three durable events exist but the processor was never pushed (fresh incarnation).
    mem.stream.append({ type: "tick" }, { type: "tick" }, { type: "tick" }) as StreamEvent[];
    await expect(p.waitUntilProcessed({ offset: 3, timeoutMs: 2000 })).resolves.toBeUndefined();
    expect((await p.snapshot()).offset).toBe(3);
  });

  test("a waiter timing out concurrently with a resolving batch neither leaks nor disturbs other waiters", async () => {
    const mem = memoryStream();
    const Contract = contractOf("waiters", "1", ["e"]);
    class SlowProcessor extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      override reduce({ state }: ReduceArgs<{ n: number }>) {
        return { n: state.n + 1 };
      }
      override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
        if (args.event?.offset === 1) args.blockProcessorWhile(() => sleep(60));
      }
      override projectLiveState() {
        return null; // exact-offset suite: opt out of the default live-state emit
      }
    }
    const p = new ProcessorEngine(new SlowProcessor(), {
      stream: mem.stream,
      storage: memoryStorage(),
    });
    mem.engines.push(p);
    mem.stream.append({ type: "e" }, { type: "e" }) as StreamEvent[];
    // A: unreachable offset, times out at ~25ms — DURING the batch's 60ms blocker.
    const a = p.waitUntilProcessed({ offset: 999, timeoutMs: 25 }).then(
      () => "resolved",
      () => "rejected",
    );
    // B and C: satisfied by the batch that commits at ~60ms.
    const b = p.waitUntilProcessed({ offset: 1, timeoutMs: 5000 });
    const c = p.waitUntilProcessed({ offset: 2, timeoutMs: 5000 });
    await expect(a).resolves.toBe("rejected");
    await expect(b).resolves.toBeUndefined();
    await expect(c).resolves.toBeUndefined();
    // The timed-out waiter left no residue: a NEW waiter for the next offset still works.
    const d = p.waitUntilProcessed({ offset: 3, timeoutMs: 5000 });
    mem.stream.append({ type: "e" }) as StreamEvent[];
    await expect(d).resolves.toBeUndefined();
  });
});

// ═══════════════════ version bump — the reduce-only re-reduce (#rereduceIfVersionChanged) ═══════════════════

const makeVersioned = (
  mem: ReturnType<typeof memoryStream>,
  storage: ReturnType<typeof memoryStorage>,
  version: string,
  effects: string[],
) => {
  const Contract = contractOf("vbump", version, ["e"]);
  return new ProcessorEngine(
    new (class extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      override reduce({ state }: ReduceArgs<{ n: number }>) {
        return { n: state.n + 1 };
      }
      override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
        if (args.event) effects.push(`effect ${args.event.offset}`);
      }
      override projectLiveState() {
        return null; // exact-offset suite: opt out of the default live-state emit
      }
    })(),
    { stream: mem.stream, storage },
  );
};

describe("version bump re-reduce", () => {
  test("a push in flight on a bumped incarnation keeps the NEW event's processEvent", async () => {
    // The re-reduce's ceiling is the STORED cursor, not the current head: old events replay through
    // reduce only (their effects already ran), and a durable event that landed while the processor
    // was behind is NEW work whose processEvent runs exactly once — "deploy a new version" plus
    // "traffic during the deploy" is the normal case, and its side effects must not vanish.
    const mem = memoryStream();
    const storage = memoryStorage();
    const effects: string[] = [];
    const p1 = makeVersioned(mem, storage, "1.0.0", effects);
    mem.stream.append({ type: "e" }, { type: "e" }) as StreamEvent[];
    await p1.catchUpFromLog(); // v1 processed offsets 1,2 — cursor 2 persisted
    expect(effects).toEqual(["effect 1", "effect 2"]);
    const committed = mem.stream.append({ type: "e" }) as StreamEvent[]; // offset 3 — v1 never saw it
    const p2 = makeVersioned(mem, storage, "2.0.0", effects);
    // The in-flight push lands on the bumped incarnation's chain (contiguous with the durable cursor).
    await p2.processEventBatch(committed, { after: 2, through: 3 });
    expect((await p2.snapshot()).state.n).toBe(3); // the reduce saw it…
    // …its side effects ran exactly once, and the re-reduce replayed NONE of the old ones
    expect(effects).toEqual(["effect 1", "effect 2", "effect 3"]);
  });

  test("waitUntilProcessed before the first chain slot keeps the re-reduce reduce-only", async () => {
    // Whether a version bump re-runs years of side effects must not depend on which verb touches
    // the facet first after the deploy: a read-your-writes barrier (exactly what fires right after
    // one) must re-reduce like snapshot() does, never through the ordinary catch-up WITH processEvent.
    const mem = memoryStream();
    const storage = memoryStorage();
    const effects: string[] = [];
    const p1 = makeVersioned(mem, storage, "1.0.0", effects);
    mem.stream.append({ type: "e" }, { type: "e" }) as StreamEvent[];
    await p1.catchUpFromLog(); // v1 processed 1,2 — effects ran once
    expect(effects).toEqual(["effect 1", "effect 2"]);
    const p2 = makeVersioned(mem, storage, "2.0.0", effects);
    await p2.waitUntilProcessed({ offset: 2, timeoutMs: 2000 });
    expect((await p2.snapshot()).state.n).toBe(2); // re-reduced state is right…
    expect(effects).toEqual(["effect 1", "effect 2"]); // …but effects must NOT have re-run
  });
});

// ═══════════════════════════════ live state — flaky projections ═══════════════════════════════

describe("live state with a projection that throws only sometimes", () => {
  test("state advances through the throwing window; the chain resumes and stays linked", async () => {
    const mem = memoryStream();
    const Contract = contractOf("flakyproj", "1", ["tick"]);
    class FlakyProcessor extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      override reduce({ state }: ReduceArgs<{ n: number }>) {
        return { n: state.n + 1 };
      }
      override projectLiveState(state: { n: number }): unknown {
        if (state.n === 1) throw new Error("projection cannot render n=1"); // SOMETIMES
        return { n: state.n };
      }
    }
    const p = new ProcessorEngine(new FlakyProcessor(), {
      stream: mem.stream,
      storage: memoryStorage(),
    });
    mem.engines.push(p);
    const changes = () =>
      mem.pushedEvents.filter((e) => e.type === "events.iterate.com/live-state/changed");

    mem.stream.append({ type: "tick" }) as StreamEvent[]; // n: 0→1 — projecting NEW state throws
    await settle();
    expect((await p.snapshot()).state.n).toBe(1); // the batch committed anyway
    expect(changes()).toHaveLength(0); // only the notification was lost

    mem.stream.append({ type: "tick" }) as StreamEvent[]; // n: 1→2 — projects again; the holder HEALS
    await settle();
    expect((await p.snapshot()).state.n).toBe(2);
    // The holder diffs the LAST GOOD projection it stored ({n:0}) against the new one ({n:2}),
    // COALESCING the lost n=1 window into one delta — it heals the moment it can project again,
    // not only once both sides of a step project.
    expect(changes()).toHaveLength(1);
    const healed = changes()[0].payload as { from: number; to: number; patch: unknown };
    expect(healed.patch).toEqual([{ op: "replace", path: "/n", value: 2 }]);

    mem.stream.append({ type: "tick" }) as StreamEvent[]; // n: 2→3 — the chain continues, linked
    await settle();
    expect((await p.snapshot()).state.n).toBe(3);
    expect(changes()).toHaveLength(2);
    const next = changes()[1].payload as { from: number; to: number };
    expect(next.from).toBe(healed.to); // linked exactly — from === the previous emission's to
  });
});

// ═══════════════════════════ ephemeral windows, eviction, repair ═══════════════════════════

describe("ephemeral windows and repair", () => {
  const EphContract = contractOf("ephwin", "1", ["tick", "chunk"]); // chunk arrives ephemeral — NAMED
  class EphProcessor extends StreamProcessor<{ n: number }> {
    readonly contract = EphContract;
    readonly seen: string[] = [];
    override reduce({ event, state }: ReduceArgs<{ n: number }>) {
      this.seen.push(`${event.type}@${event.offset}`);
      return { n: state.n + 1 };
    }
    override projectLiveState() {
      return null; // exact-offset suite: opt out of the default live-state emit
    }
  }

  test("LIVE instance: a durable push whose scannedAfterOffset is BEFORE the in-memory-only cursor repairs without double-consuming the ephemerals", async () => {
    const mem = memoryStream();
    const storage = memoryStorage();
    const a = new EphProcessor();
    const engine = new ProcessorEngine(a, { stream: mem.stream, storage });
    mem.engines.push(engine);

    mem.stream.append({ type: "tick" }) as StreamEvent[]; // offset 1 — durable, cursor 1 persisted
    await settle();
    const writesAfterDurable = storage.writes;
    mem.stream.append({ type: "chunk", ephemeral: true }) as StreamEvent[]; // offset 2
    mem.stream.append({ type: "chunk", ephemeral: true }) as StreamEvent[]; // offset 3
    await settle();
    expect(a.seen).toEqual(["tick@1", "chunk@2", "chunk@3"]); // in-memory cursor rode to 3…
    expect(storage.writes).toBe(writesAfterDurable); // …for ZERO storage writes (the ephemeral rule)

    // A durable push with a STALE scannedAfterOffset (1 — before the in-memory-only cursor 3):
    mem.engines.length = 0; // hand-deliver, so the pump doesn't also push the true range
    const [t4] = mem.stream.append({ type: "tick" }) as StreamEvent[]; // offset 4
    await engine.processEventBatch([t4], { after: 1, through: 4 });
    // The ephemerals were NOT consumed a second time and tick@4 arrived exactly once.
    expect(a.seen).toEqual(["tick@1", "chunk@2", "chunk@3", "tick@4"]);
    expect((await engine.snapshot()).state.n).toBe(4);
    expect((await engine.snapshot()).offset).toBe(4);
  });

  test("EVICTION after an ephemeral-only window: the rebuilt incarnation repairs from its durable cursor; dead ephemerals are gaps, durables appear exactly once", async () => {
    const mem = memoryStream();
    const storage = memoryStorage();
    mem.engines.push(new ProcessorEngine(new EphProcessor(), { stream: mem.stream, storage })); // the doomed incarnation
    mem.stream.append({ type: "tick" }) as StreamEvent[]; // offset 1 — durable, cursor 1 persisted
    await settle();
    const writesAfterDurable = storage.writes;
    mem.stream.append({ type: "chunk", ephemeral: true }) as StreamEvent[]; // offset 2
    mem.stream.append({ type: "chunk", ephemeral: true }) as StreamEvent[]; // offset 3
    await settle();
    expect(storage.writes).toBe(writesAfterDurable); // the window persisted NOTHING (regression on eviction is by design)

    // EVICTION: the old incarnation dies; a fresh one shares its storage (durable cursor 1).
    mem.engines.length = 0;
    const b = new EphProcessor();
    const engineB = new ProcessorEngine(b, { stream: mem.stream, storage });
    mem.engines.push(engineB);
    const readsBefore = mem.reads;
    mem.stream.append({ type: "tick" }) as StreamEvent[]; // offset 4 — pushed as range (3,4]
    await settle();
    // (3,4] is non-contiguous with b's durable cursor 1 → gap repair from the log: the dead
    // ephemerals are simply offset gaps; the durable events each reduce exactly once.
    expect(b.seen).toEqual(["tick@4"]); // reduce calls THIS incarnation made (tick@1 came from the checkpoint)
    expect((await engineB.snapshot()).state.n).toBe(2); // tick@1 (persisted reduce) + tick@4 — no double-consume
    expect((await engineB.snapshot()).offset).toBe(4);
    expect(mem.reads).toBeGreaterThan(readsBefore); // it really was a repair, not a blind fast path
  });

  test("fresh NAMED ephemerals riding a non-contiguous push are delivered (repair the gap, then process the push)", async () => {
    // An ephemeral is lost only when nobody could deliver it. Here the processor is alive and WAS
    // handed the event: a non-contiguous push repairs the log up to its scannedAfterOffset and then
    // consumes the pushed batch itself — otherwise one transient failure would swallow a whole
    // window of the named ephemerals voice/telemetry lanes ride (pushes are their ONLY delivery).
    const mem = memoryStream();
    const storage = memoryStorage();
    let attempts = 0;
    const Contract = contractOf("ephdrop", "1", ["tick", "chunk"]);
    class FlakyProcessor extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      readonly seen: string[] = [];
      override reduce({ event, state }: ReduceArgs<{ n: number }>) {
        this.seen.push(`${event.type}@${event.offset}`);
        return { n: state.n + 1 };
      }
      override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
        if (!args.event) return;
        args.blockProcessorWhile(async () => {
          if (++attempts === 1) throw new Error("transient");
        });
      }
    }
    const p = new FlakyProcessor();
    mem.engines.push(new ProcessorEngine(p, { stream: mem.stream, storage }));
    mem.stream.append({ type: "tick" }) as StreamEvent[]; // offset 1 — its push FAILS once (cursor stays 0)
    await settle();
    // One push carrying a fresh named ephemeral + a durable event, range (1,3] — non-contiguous
    // with the (still unrepaired) cursor 0.
    mem.stream.append({ type: "chunk", ephemeral: true }, { type: "tick" }) as StreamEvent[];
    await settle(50);
    expect(p.seen).toContain("tick@1"); // repaired from the log
    expect(p.seen).toContain("tick@3"); // repaired from the log
    expect(p.seen).toContain("chunk@2"); // delivered by push — must not be thrown away
  });

  test('consumes ["*"] PLUS a named ephemeral in one contract: durables swept, the named ephemeral consumed, unnamed ephemerals skipped', async () => {
    const mem = memoryStream();
    const Contract = contractOf("starplus", "1", ["*", "chunk"]);
    class StarPlusProcessor extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      readonly seen: string[] = [];
      override reduce({ event, state }: ReduceArgs<{ n: number }>) {
        this.seen.push(`${event.type}@${event.offset}`);
        return { n: state.n + 1 };
      }
      override projectLiveState(state: { n: number }): unknown {
        return { n: state.n }; // emits live-state/changed — which the ENGINE never reduces, even for "*"+named (reducesEvent, not consumesEvent, is the guard)
      }
    }
    const p = new StarPlusProcessor();
    const engine = new ProcessorEngine(p, { stream: mem.stream, storage: memoryStorage() });
    mem.engines.push(engine);
    mem.stream.append({ type: "tick" }) as StreamEvent[]; // durable → swept by "*" (emits a live-state change)
    await settle();
    mem.stream.append({ type: "chunk", ephemeral: true }) as StreamEvent[]; // named → consumed
    mem.stream.append({ type: "noise", ephemeral: true }) as StreamEvent[]; // unnamed → skipped
    mem.stream.append({ type: "tock" }) as StreamEvent[]; // durable → swept
    await settle();
    const liveStateOffsets = mem.pushedEvents
      .filter((e) => e.type === "events.iterate.com/live-state/changed")
      .map((e) => `${e.type}@${e.offset}`);
    expect(liveStateOffsets.length).toBeGreaterThan(0); // the projection did emit…
    expect(p.seen).toEqual(["tick@1", "chunk@3", "tock@5"]); // …and nothing consumed it or the noise
    expect((await engine.snapshot()).state.n).toBe(3);
  });
});
