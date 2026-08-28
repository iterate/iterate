// processor.failing.test.ts — BUG-HUNT tests for the StreamProcessor base class.
// Every test asserts CORRECT behavior per the concurrency contract in core/processor.ts's
// header. Tests marked `test.fails` document a verified bug (they fail against today's code —
// vitest fails-semantics keeps the file green); plain tests pass and pin behavior that the
// existing suite does not cover. Helpers are COPIED from processor.test.ts (do not import
// across test files).
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineProcessorContract, type StreamEvent, type StreamEventInput } from "./events.ts";
import {
  LIVE_STATE_CHANGED,
  StreamProcessor,
  type ProcessEventArgs,
  type ProcessorStream,
  type ReduceArgs,
} from "./processor.ts";

// ── helpers (copied from processor.test.ts, faithful to the DO's commit semantics) ──

function memoryStream(path = "/") {
  const events: StreamEvent[] = [];
  const pushed: StreamEvent[] = []; // every committed event, ephemerals included (the pump's view)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const procs: StreamProcessor<any>[] = [];
  let maxAssigned = 0;
  let reads = 0;
  const stream: ProcessorStream = {
    append: (...inputs: StreamEventInput[]) => {
      const scannedAfterOffset = maxAssigned;
      const committed = inputs.map((input) => {
        maxAssigned += 1;
        const event: StreamEvent = {
          ...input,
          offset: maxAssigned,
          createdAt: new Date(0).toISOString(),
          path,
        };
        if (!input.ephemeral) events.push(event);
        return event;
      });
      pushed.push(...committed);
      if (maxAssigned > scannedAfterOffset) {
        const scannedOffsetRange = { scannedAfterOffset, scannedThroughOffset: maxAssigned };
        // THE PUMP: fire-and-forget, exactly like the DO.
        for (const p of procs)
          void p.processEventBatch(committed, scannedOffsetRange).catch(() => {});
      }
      return committed;
    },
    read: (afterOffset = 0, limit = 500) => {
      reads += 1;
      const page = events.filter((e) => e.offset > afterOffset).slice(0, limit);
      return Promise.resolve({
        events: page,
        scannedThroughOffset:
          page.length === limit ? page[page.length - 1].offset : Math.max(afterOffset, maxAssigned),
      });
    },
  };
  return {
    stream,
    events,
    pushed,
    procs,
    get reads() {
      return reads;
    },
  };
}

const memoryStorage = () => {
  const map = new Map<string, unknown>();
  let writes = 0;
  return {
    get: <T>(k: string) => map.get(k) as T | undefined,
    put: (k: string, v: unknown) => (writes++, void map.set(k, structuredClone(v))),
    get writes() {
      return writes;
    },
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = (ms = 25) => sleep(ms); // let fire-and-forget pushes land

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
    class Slow extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      protected override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
        if (!args.event) return;
        const offset = args.event.offset;
        startAt.set(offset, performance.now());
        args.blockProcessorWhile(async () => {
          await sleep(30); // slow on purpose — a scheduling hiccup must not let N+1 sneak in
          blockedDoneAt.set(offset, performance.now());
        });
      }
    }
    const p = new Slow({ stream: mem.stream, storage: memoryStorage(), path: "/", projectId: "p" });
    mem.stream.append({ type: "e" }, { type: "e" }, { type: "e" }) as StreamEvent[];
    await p.wake();
    for (const offset of [1, 2]) {
      expect(blockedDoneAt.get(offset)).toBeDefined();
      expect(startAt.get(offset + 1)!).toBeGreaterThanOrEqual(blockedDoneAt.get(offset)!);
    }
  });

  test("a blocker registered from INSIDE a blocker holds the cursor (rule 2 fixed point)", async () => {
    // FIXED: `runOne` used to snapshot `await blockers` once; a blockProcessorWhile call made
    //   while a blocker of the SAME event was running reassigned the local `blockers` chain that
    //   nobody awaited anymore. It now DRAINS to a fixed point, so work registered mid-blocker is
    //   still THIS event's blocking work — `nested-done 1` precedes `start 2` (rule 2), and the
    //   batch cannot commit while nested blocking work is in flight (rule 4).
    const mem = memoryStream();
    const trace: string[] = [];
    const Contract = contractOf("nested", "1", ["e"]);
    class Nested extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      protected override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
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
    const p = new Nested({
      stream: mem.stream,
      storage: memoryStorage(),
      path: "/",
      projectId: "p",
    });
    mem.stream.append({ type: "e" }, { type: "e" }) as StreamEvent[];
    await p.wake();
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
    class Bg extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      protected override reduce({ state }: ReduceArgs<{ n: number }>) {
        return { n: state.n + 1 };
      }
      protected override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
        if (!args.event) return;
        args.runInBackground(async () => {
          await sleep(80);
          bgDone = true;
          throw new Error("background attempt failed — must be swallowed, never the batch");
        });
      }
    }
    const p = new Bg({ stream: mem.stream, storage, path: "/", projectId: "p" });
    const committed = mem.stream.append({ type: "e" }) as StreamEvent[];
    await p.processEventBatch(committed, { scannedAfterOffset: 0, scannedThroughOffset: 1 });
    // The batch is durably committed BEFORE the background work lands (overtaking allowed):
    expect(bgDone).toBe(false);
    expect(storage.get<{ reducedThroughOffset: number }>("processor:bg:progress")).toMatchObject({
      reducedThroughOffset: 1,
    });
    await sleep(120);
    expect(bgDone).toBe(true); // and the attempt did run (droppable, not dropped here)
    // the failed background attempt never poisoned the chain — the next batch still commits
    const next = mem.stream.append({ type: "e" }) as StreamEvent[];
    await p.processEventBatch(next, { scannedAfterOffset: 1, scannedThroughOffset: 2 });
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
    class RedThrow extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      protected override reduce({ event, state }: ReduceArgs<{ n: number }>) {
        if ((event.payload as { boom?: boolean } | undefined)?.boom)
          throw new Error("hostile payload");
        return { n: state.n + 1 };
      }
      protected override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
        if (args.event) effects.push(args.event.offset);
      }
    }
    const p = new RedThrow({ stream: mem.stream, storage, path: "/", projectId: "p" });
    const committed = mem.stream.append(
      { type: "e" },
      { type: "e" },
      { type: "e", payload: { boom: true } },
    ) as StreamEvent[];
    const before = storage.writes;
    await p.processEventBatch(committed, { scannedAfterOffset: 0, scannedThroughOffset: 3 });
    expect(storage.writes - before).toBe(2); // ONE persist: cursor + state, nothing extra
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
    class LastFail extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      protected override reduce({ state }: ReduceArgs<{ n: number }>) {
        return { n: state.n + 1 };
      }
      protected override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
        if (!args.event) return;
        const offset = args.event.offset;
        effects.push(offset);
        args.blockProcessorWhile(async () => {
          if (offset === 3 && ++attempts === 1) throw new Error("boom on the last event");
        });
      }
    }
    const p = new LastFail({ stream: mem.stream, storage, path: "/", projectId: "p" });
    const committed = mem.stream.append(
      { type: "e" },
      { type: "e" },
      { type: "e" },
    ) as StreamEvent[];
    await expect(
      p.processEventBatch(committed, { scannedAfterOffset: 0, scannedThroughOffset: 3 }),
    ).rejects.toThrow(/boom/);
    expect(storage.writes).toBe(0); // events 1+2 fully processed, yet NOTHING persisted
    await p.wake(); // retried whole — 1 and 2 run again (droppable-attempt semantics)
    expect(effects).toEqual([1, 2, 3, 1, 2, 3]);
    expect(storage.writes).toBe(2); // and then exactly one persist
    expect((await p.snapshot()).state.n).toBe(3); // the reduce restarted from the persisted state
  });
});

// ═══════════════════════════════ rule 5 — exactly one caughtUp ═══════════════════════════════

type Delivery = { offset: number | null; caughtUp: boolean };
const deliveryRecorder = (slug: string, consumes: readonly string[]) => {
  const deliveries: Delivery[] = [];
  const Contract = contractOf(slug, "1", consumes);
  class Rec extends StreamProcessor<{ n: number }> {
    readonly contract = Contract;
    protected override reduce({ state }: ReduceArgs<{ n: number }>) {
      return { n: state.n + 1 };
    }
    protected override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
      deliveries.push({ offset: args.event?.offset ?? null, caughtUp: args.delivery.caughtUp });
    }
  }
  return { Rec, deliveries };
};

describe("rule 5 — exactly one caughtUp per at-head batch", () => {
  test("last event of the batch NOT consumable → the last CONSUMABLE event carries the one caughtUp (no extra eventless pass)", async () => {
    const mem = memoryStream();
    const { Rec, deliveries } = deliveryRecorder("lastfiltered", ["tick"]);
    const p = new Rec({ stream: mem.stream, storage: memoryStorage(), path: "/", projectId: "p" });
    const committed = mem.stream.append({ type: "tick" }, { type: "noise" }) as StreamEvent[];
    await p.processEventBatch(committed, { scannedAfterOffset: 0, scannedThroughOffset: 2 });
    expect(deliveries.filter((d) => d.caughtUp)).toHaveLength(1);
    expect(deliveries).toEqual([{ offset: 1, caughtUp: true }]); // the tick, not a null pass
  });

  test("no consumable event at all → exactly one eventless caughtUp pass", async () => {
    const mem = memoryStream();
    const { Rec, deliveries } = deliveryRecorder("nonecons", ["tick"]);
    const p = new Rec({ stream: mem.stream, storage: memoryStorage(), path: "/", projectId: "p" });
    const committed = mem.stream.append({ type: "noise" }, { type: "noise" }) as StreamEvent[];
    await p.processEventBatch(committed, { scannedAfterOffset: 0, scannedThroughOffset: 2 });
    expect(deliveries).toEqual([{ offset: null, caughtUp: true }]);
  });

  test("a catch-up whose log length is an exact page multiple (500) still delivers caughtUp", async () => {
    // FIXED: #catchUpBody used `atHead = page.events.length < 500`; a FULL page that in fact ended
    //   at the stream head was judged not-at-head, and the follow-up empty read short-circuited
    //   BEFORE any #processBatch call — so rule 5's at-head pass never ran, and the processor only
    //   learned it was at head when the NEXT append arrived. #catchUpBody now remembers it saw a
    //   full page and, when the next read finds nothing new (at head), delivers the eventless
    //   at-head pass — so a log whose length is an exact multiple of the page size is not a silent
    //   stall for the at-head-triggered recovery work (obligation sweeps, "am I done" transitions).
    const mem = memoryStream();
    const { Rec, deliveries } = deliveryRecorder("page500", ["tick"]);
    const p = new Rec({ stream: mem.stream, storage: memoryStorage(), path: "/", projectId: "p" });
    mem.stream.append(
      ...Array.from({ length: 500 }, () => ({ type: "tick" }) as StreamEventInput),
    ) as StreamEvent[];
    await p.wake();
    expect((await p.snapshot()).offset).toBe(500); // the reduce DID reach the head…
    expect(deliveries.filter((d) => d.caughtUp).length).toBeGreaterThanOrEqual(1); // …silently
  });
});

// ═══════════════════════════════════ waitUntilProcessed ═══════════════════════════════════

describe("waitUntilProcessed", () => {
  test("resolves for an offset that arrives via GAP REPAIR (no push ever delivered)", async () => {
    const mem = memoryStream();
    const { Rec } = deliveryRecorder("gapwait", ["tick"]);
    const p = new Rec({ stream: mem.stream, storage: memoryStorage(), path: "/", projectId: "p" });
    // Three durable events exist but the processor was never pushed (fresh incarnation).
    mem.stream.append({ type: "tick" }, { type: "tick" }, { type: "tick" }) as StreamEvent[];
    await expect(p.waitUntilProcessed({ offset: 3, timeoutMs: 2000 })).resolves.toBeUndefined();
    expect((await p.snapshot()).offset).toBe(3);
  });

  test("a waiter timing out concurrently with a resolving batch neither leaks nor disturbs other waiters", async () => {
    const mem = memoryStream();
    const Contract = contractOf("waiters", "1", ["e"]);
    class Slow extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      protected override reduce({ state }: ReduceArgs<{ n: number }>) {
        return { n: state.n + 1 };
      }
      protected override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
        if (args.event?.offset === 1) args.blockProcessorWhile(() => sleep(60));
      }
    }
    const p = new Slow({ stream: mem.stream, storage: memoryStorage(), path: "/", projectId: "p" });
    mem.procs.push(p);
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

// ═══════════════════ version bump — the reduce-only refold (#rereduceIfVersionChanged) ═══════════════════

const makeVersioned = (
  mem: ReturnType<typeof memoryStream>,
  storage: ReturnType<typeof memoryStorage>,
  version: string,
  effects: string[],
) => {
  const Contract = contractOf("vbump", version, ["e"]);
  return new (class extends StreamProcessor<{ n: number }> {
    readonly contract = Contract;
    protected override reduce({ state }: ReduceArgs<{ n: number }>) {
      return { n: state.n + 1 };
    }
    protected override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
      if (args.event) effects.push(`effect ${args.event.offset}`);
    }
  })({ stream: mem.stream, storage, path: "/", projectId: "p" });
};

describe("version bump re-reduce", () => {
  test("FIXED (defect 18): a push in flight on a bumped incarnation keeps the NEW event's processEvent", async () => {
    // BUG: #rereduceIfVersionChanged refolds all the way to the CURRENT head (including events
    //      no incarnation ever processed), then the pushed range is judged a stale redelivery
    //      (`scannedThroughOffset > progress.reducedThroughOffset` is false) and skipped.
    // EXPECTED: the refold replays OLD events through reduce only ("side effects never
    //      re-run" — they already ran); a durable event that arrived while the processor was
    //      behind is NEW work whose processEvent must run exactly once, like any gap-repaired
    //      event.
    // ACTUAL: the new event is folded into state by the version refold and its processEvent is
    //      swallowed — it runs under NEITHER version. Effects for it are lost forever (no
    //      retry, no wake heals it: the cursor already covers the offset).
    // WHY IT MATTERS: "deploy new processor version" + "traffic during the deploy" is the
    //      normal case, not the edge. Every durable event that lands between the old
    //      incarnation's last commit and the new incarnation's first push silently loses its
    //      side effects (deliveries, appends, notifications) with no error anywhere.
    const mem = memoryStream();
    const storage = memoryStorage();
    const effects: string[] = [];
    const p1 = makeVersioned(mem, storage, "1.0.0", effects);
    mem.stream.append({ type: "e" }, { type: "e" }) as StreamEvent[];
    await p1.wake(); // v1 processed offsets 1,2 — cursor 2 persisted
    expect(effects).toEqual(["effect 1", "effect 2"]);
    const committed = mem.stream.append({ type: "e" }) as StreamEvent[]; // offset 3 — v1 never saw it
    const p2 = makeVersioned(mem, storage, "2.0.0", effects);
    // The in-flight push lands on the bumped incarnation's chain (contiguous with the durable cursor).
    await p2.processEventBatch(committed, { scannedAfterOffset: 2, scannedThroughOffset: 3 });
    expect((await p2.snapshot()).state.n).toBe(3); // the reduce saw it…
    expect(effects).toContain("effect 3"); // …but its side effects must have run too
  });

  test("FIXED (defect 17): waitUntilProcessed before the first chain slot keeps the refold reduce-only", async () => {
    // BUG: waitUntilProcessed's fast-path check calls #loadProgress(), which CACHES the
    //      version-mismatch fallback ({version: new, offset: 0, state: initial}) into
    //      #progress; #rereduceIfVersionChanged's `if (this.#progress) return` then skips the
    //      refold entirely, and the ordinary catch-up path replays the whole log WITH
    //      processEvent.
    // EXPECTED: "bumping contract.version re-reduces from offset 0 through reduce only (never
    //      re-running side effects)" — regardless of which read verb touches the processor
    //      first. snapshot() (which guards #loadProgress behind #pushedThroughOffset) gets
    //      this right; waitUntilProcessed must too.
    // ACTUAL: every already-processed event's processEvent runs AGAIN under the new version —
    //      appends re-fire (saved only by idempotency keys where authors used them), webhooks
    //      and deliveries double.
    // WHY IT MATTERS: whether a version bump re-runs years of side effects must not depend on
    //      which verb happened to touch the facet first after the deploy. The same class of
    //      callers (read-your-writes barriers) is exactly what fires right after a deploy.
    const mem = memoryStream();
    const storage = memoryStorage();
    const effects: string[] = [];
    const p1 = makeVersioned(mem, storage, "1.0.0", effects);
    mem.stream.append({ type: "e" }, { type: "e" }) as StreamEvent[];
    await p1.wake(); // v1 processed 1,2 — effects ran once
    expect(effects).toEqual(["effect 1", "effect 2"]);
    const p2 = makeVersioned(mem, storage, "2.0.0", effects);
    await p2.waitUntilProcessed({ offset: 2, timeoutMs: 2000 });
    expect((await p2.snapshot()).state.n).toBe(2); // refolded state is right…
    expect(effects).toEqual(["effect 1", "effect 2"]); // …but effects must NOT have re-run
  });
});

// ═══════════════════════════════ live state — flaky projections ═══════════════════════════════

describe("live state with a projection that throws only sometimes", () => {
  test("state advances through the throwing window; the chain resumes and stays linked", async () => {
    const mem = memoryStream();
    const Contract = contractOf("flakyproj", "1", ["tick"]);
    class Flaky extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      protected override reduce({ state }: ReduceArgs<{ n: number }>) {
        return { n: state.n + 1 };
      }
      liveState(state: { n: number }): unknown {
        if (state.n === 1) throw new Error("projection cannot render n=1"); // SOMETIMES
        return { n: state.n };
      }
    }
    const p = new Flaky({
      stream: mem.stream,
      storage: memoryStorage(),
      path: "/",
      projectId: "p",
    });
    mem.procs.push(p);
    const changes = () => mem.pushed.filter((e) => e.type === LIVE_STATE_CHANGED);

    mem.stream.append({ type: "tick" }) as StreamEvent[]; // n: 0→1 — projecting NEW state throws
    await settle();
    expect((await p.snapshot()).state.n).toBe(1); // the batch committed anyway
    expect(changes()).toHaveLength(0); // only the notification was lost

    mem.stream.append({ type: "tick" }) as StreamEvent[]; // n: 1→2 — projecting the OLD state throws
    await settle();
    expect((await p.snapshot()).state.n).toBe(2);
    expect(changes()).toHaveLength(0);

    mem.stream.append({ type: "tick" }) as StreamEvent[]; // n: 2→3 — both sides project: HEALS
    await settle();
    expect((await p.snapshot()).state.n).toBe(3);
    expect(changes()).toHaveLength(1);
    const healed = changes()[0].payload as { from: number; to: number; patch: unknown };
    expect(healed.to).toBe(3); // the healed emission is anchored at the commit cursor
    // (its `from` skips the lost window — a chain hole, which is the client's re-seed signal)

    mem.stream.append({ type: "tick" }) as StreamEvent[]; // n: 3→4 — the chain continues
    await settle();
    expect(changes()).toHaveLength(2);
    const next = changes()[1].payload as { from: number; to: number };
    expect(next.from).toBe(healed.to); // linked exactly — no permanent chain damage
  });
});

// ═══════════════════════════ ephemeral windows, eviction, repair ═══════════════════════════

describe("ephemeral windows and repair", () => {
  const EphContract = contractOf("ephwin", "1", ["tick", "chunk"]); // chunk arrives ephemeral — NAMED
  class Eph extends StreamProcessor<{ n: number }> {
    readonly contract = EphContract;
    readonly seen: string[] = [];
    protected override reduce({ event, state }: ReduceArgs<{ n: number }>) {
      this.seen.push(`${event.type}@${event.offset}`);
      return { n: state.n + 1 };
    }
  }

  test("LIVE instance: a durable push whose scannedAfterOffset is BEFORE the in-memory-only cursor repairs without double-consuming the ephemerals", async () => {
    const mem = memoryStream();
    const storage = memoryStorage();
    const a = new Eph({ stream: mem.stream, storage, path: "/", projectId: "p" });
    mem.procs.push(a);

    mem.stream.append({ type: "tick" }) as StreamEvent[]; // offset 1 — durable, cursor 1 persisted
    await settle();
    const writesAfterDurable = storage.writes;
    mem.stream.append({ type: "chunk", ephemeral: true }) as StreamEvent[]; // offset 2
    mem.stream.append({ type: "chunk", ephemeral: true }) as StreamEvent[]; // offset 3
    await settle();
    expect(a.seen).toEqual(["tick@1", "chunk@2", "chunk@3"]); // in-memory cursor rode to 3…
    expect(storage.writes).toBe(writesAfterDurable); // …for ZERO storage writes (the ephemeral rule)

    // A durable push with a STALE scannedAfterOffset (1 — before the in-memory-only cursor 3):
    mem.procs.length = 0; // hand-deliver, so the pump doesn't also push the true range
    const [t4] = mem.stream.append({ type: "tick" }) as StreamEvent[]; // offset 4
    await a.processEventBatch([t4], { scannedAfterOffset: 1, scannedThroughOffset: 4 });
    // The ephemerals were NOT consumed a second time and tick@4 arrived exactly once.
    expect(a.seen).toEqual(["tick@1", "chunk@2", "chunk@3", "tick@4"]);
    expect((await a.snapshot()).state.n).toBe(4);
    expect((await a.snapshot()).offset).toBe(4);
  });

  test("EVICTION after an ephemeral-only window: the rebuilt incarnation repairs from its durable cursor; dead ephemerals are gaps, durables appear exactly once", async () => {
    const mem = memoryStream();
    const storage = memoryStorage();
    const a = new Eph({ stream: mem.stream, storage, path: "/", projectId: "p" });
    mem.procs.push(a);
    mem.stream.append({ type: "tick" }) as StreamEvent[]; // offset 1 — durable, cursor 1 persisted
    await settle();
    const writesAfterDurable = storage.writes;
    mem.stream.append({ type: "chunk", ephemeral: true }) as StreamEvent[]; // offset 2
    mem.stream.append({ type: "chunk", ephemeral: true }) as StreamEvent[]; // offset 3
    await settle();
    expect(storage.writes).toBe(writesAfterDurable); // the window persisted NOTHING (regression on eviction is by design)

    // EVICTION: the old incarnation dies; a fresh one shares its storage (durable cursor 1).
    mem.procs.length = 0;
    const b = new Eph({ stream: mem.stream, storage, path: "/", projectId: "p" });
    mem.procs.push(b);
    const readsBefore = mem.reads;
    mem.stream.append({ type: "tick" }) as StreamEvent[]; // offset 4 — pushed as range (3,4]
    await settle();
    // (3,4] is non-contiguous with b's durable cursor 1 → gap repair from the log: the dead
    // ephemerals are simply offset gaps; the durable events each reduce exactly once.
    expect(b.seen).toEqual(["tick@4"]); // reduce calls THIS incarnation made (tick@1 came from the checkpoint)
    expect((await b.snapshot()).state.n).toBe(2); // tick@1 (persisted fold) + tick@4 — no double-consume
    expect((await b.snapshot()).offset).toBe(4);
    expect(mem.reads).toBeGreaterThan(readsBefore); // it really was a repair, not a blind fast path
  });

  test.fails("BUG: fresh NAMED ephemerals riding a non-contiguous push are silently dropped by gap repair", async () => {
    // BUG: processEventBatch treats any non-contiguous range as "repair from the log" and
    //      IGNORES the pushed events entirely — including the batch's own fresh ephemeral
    //      events, which the log can never return (reads are durable-only).
    // EXPECTED: an ephemeral is lost only when nobody could deliver it ("an ephemeral missed
    //      while a facet rebuilds is gone by design"). Here the processor is alive and WAS
    //      handed the event in the push; correct repair reads the log up to the push's
    //      scannedAfterOffset and then consumes the pushed batch itself.
    // ACTUAL: one failed batch (a transient blocker error) leaves the cursor behind; the next
    //      push is then non-contiguous, and its named ephemerals — deliverable, delivered —
    //      are discarded while only the durable rows are repaired.
    // WHY IT MATTERS: "at-most-once for ephemerals" quietly degrades to "drop everything for
    //      one whole push after any hiccup". Voice/telemetry lanes ride named ephemerals
    //      precisely because pushes are their ONLY delivery; a single transient failure
    //      swallows an arbitrary window of them with no trace.
    const mem = memoryStream();
    const storage = memoryStorage();
    let attempts = 0;
    const Contract = contractOf("ephdrop", "1", ["tick", "chunk"]);
    class Flaky extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      readonly seen: string[] = [];
      protected override reduce({ event, state }: ReduceArgs<{ n: number }>) {
        this.seen.push(`${event.type}@${event.offset}`);
        return { n: state.n + 1 };
      }
      protected override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
        if (!args.event) return;
        args.blockProcessorWhile(async () => {
          if (++attempts === 1) throw new Error("transient");
        });
      }
    }
    const p = new Flaky({ stream: mem.stream, storage, path: "/", projectId: "p" });
    mem.procs.push(p);
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
    class StarPlus extends StreamProcessor<{ n: number }> {
      readonly contract = Contract;
      readonly seen: string[] = [];
      protected override reduce({ event, state }: ReduceArgs<{ n: number }>) {
        this.seen.push(`${event.type}@${event.offset}`);
        return { n: state.n + 1 };
      }
      liveState(state: { n: number }): unknown {
        return { n: state.n }; // emits LIVE_STATE_CHANGED — which even "*"+named must never consume
      }
    }
    const p = new StarPlus({
      stream: mem.stream,
      storage: memoryStorage(),
      path: "/",
      projectId: "p",
    });
    mem.procs.push(p);
    mem.stream.append({ type: "tick" }) as StreamEvent[]; // durable → swept by "*" (emits a live-state change)
    await settle();
    mem.stream.append({ type: "chunk", ephemeral: true }) as StreamEvent[]; // named → consumed
    mem.stream.append({ type: "noise", ephemeral: true }) as StreamEvent[]; // unnamed → skipped
    mem.stream.append({ type: "tock" }) as StreamEvent[]; // durable → swept
    await settle();
    const liveStateOffsets = mem.pushed
      .filter((e) => e.type === LIVE_STATE_CHANGED)
      .map((e) => `${e.type}@${e.offset}`);
    expect(liveStateOffsets.length).toBeGreaterThan(0); // the projection did emit…
    expect(p.seen).toEqual(["tick@1", "chunk@3", "tock@5"]); // …and nothing consumed it or the noise
    expect((await p.snapshot()).state.n).toBe(3);
  });
});

// Speculative (not verified against a concrete contract clause — parked, not asserted):
test.todo(
  "a processEvent that MUTATES `state` in place poisons previousState and the liveState diff baseline — is containment specified?",
);
test.todo(
  "10k waiters against a never-arriving offset: the waiter list is swept per batch — O(waiters) per commit; is there a bound?",
);
