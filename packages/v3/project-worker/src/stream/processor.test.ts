// Executable spec for the processor layer — each block names the concurrency rule it proves.
// The in-memory stream (stream/test-support.ts) mirrors the DO's commit semantics: one shared
// offset sequence (ephemerals consume offsets but never land in the log), the scanned-offset-range
// proof on both pushes and reads, and a fire-and-forget push to every registered processor after
// each append. The rule-by-rule spec under slow blockers, failing batches and version bumps is
// processor-rules.test.ts.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineProcessorContract, type StreamEvent } from "./events.ts";
import {
  consumesEvent,
  StreamProcessor,
  type ProcessEventArgs,
  type ReduceArgs,
} from "./processor.ts";
import { memoryStorage, memoryStream, settle } from "./test-support.ts";

// ── a counter processor exercising every hook ──

const CounterContract = defineProcessorContract({
  slug: "counter",
  version: "1.0.0",
  description: "counts ticks; emits a milestone every 3",
  stateSchema: z.object({ ticks: z.number().default(0) }),
  events: {
    "events.iterate.com/counter/milestone": {
      payloadSchema: z.object({ at: z.number() }),
    },
  },
  consumes: ["events.iterate.com/counter/ticked"],
  emits: ["events.iterate.com/counter/milestone"],
});

class CounterProcessor extends StreamProcessor<{ ticks: number }> {
  readonly contract = CounterContract;
  readonly trace: string[] = [];

  protected override reduce({ event, state }: ReduceArgs<{ ticks: number }>) {
    if (event.type !== "events.iterate.com/counter/ticked") return undefined;
    return { ticks: state.ticks + 1 };
  }

  protected override processEvent(args: ProcessEventArgs<{ ticks: number }>): undefined {
    if (args.event === null) {
      this.trace.push(`at-head ticks=${args.state.ticks}`);
      return;
    }
    const offset = args.event.offset;
    this.trace.push(`start ${offset}`);
    args.blockProcessorWhile(async () => {
      await new Promise((r) => setTimeout(r, 5)); // slow on purpose: proves the barrier
      this.trace.push(`blocked-done ${offset}`);
    });
    if (args.state.ticks % 3 === 0)
      args.blockProcessorWhile(() =>
        args.append(
          this.contract.buildEvent({
            type: "events.iterate.com/counter/milestone",
            payload: { at: args.state.ticks },
            idempotencyKey: this.idempotencyKey(`milestone-${args.state.ticks}`),
          }),
        ),
      );
  }
}

const setup = () => {
  const mem = memoryStream();
  const storage = memoryStorage();
  const processor = new CounterProcessor({
    stream: mem.stream,
    storage,
    path: "/",
    projectId: "prj_t",
  });
  mem.procs.push(processor);
  return {
    ...mem,
    storage,
    processor,
    tick: () =>
      (mem.stream.append({ type: "events.iterate.com/counter/ticked" }) as StreamEvent[])[0],
  };
};

describe("contract", () => {
  test("stateSchema must default {} (initial state rule)", () => {
    expect(() =>
      defineProcessorContract({
        slug: "bad",
        version: "1",
        description: "",
        stateSchema: z.object({ required: z.string() }),
        events: {},
        consumes: [],
        emits: [],
      }),
    ).toThrow(/parse \{\}/);
  });

  test("buildEvent validates payload against the owned schema", () => {
    expect(() =>
      CounterContract.buildEvent({
        type: "events.iterate.com/counter/milestone",
        payload: { at: "x" },
      }),
    ).toThrow();
    expect(() =>
      CounterContract.buildEvent({ type: "events.iterate.com/other", payload: {} }),
    ).toThrow(/not owned/);
  });
});

describe("consumesEvent — THE ONE consumes rule (engine, delivery loop, inline reduces)", () => {
  test('"*" delivers every durable event but NEVER sweeps ephemerals', () => {
    expect(consumesEvent(["*"], { type: "a" })).toBe(true);
    expect(consumesEvent(["*"], { type: "b" })).toBe(true);
    expect(consumesEvent(["*"], { type: "eph", ephemeral: true })).toBe(false);
  });

  test("undefined consumes = every durable event, no ephemerals (a subscriber's default)", () => {
    expect(consumesEvent(undefined, { type: "a" })).toBe(true);
    expect(consumesEvent(undefined, { type: "eph", ephemeral: true })).toBe(false);
  });

  test("a NAMED type opts that type in, INCLUDING when ephemeral", () => {
    expect(consumesEvent(["eph"], { type: "eph", ephemeral: true })).toBe(true);
    expect(consumesEvent(["eph"], { type: "other", ephemeral: true })).toBe(false);
    expect(consumesEvent(["a"], { type: "a" })).toBe(true);
    expect(consumesEvent(["a"], { type: "b" })).toBe(false);
  });

  test("a live-state delta is an ephemeral like any other here: never swept by default or '*', delivered when NAMED", () => {
    // (That no PROCESSOR may fold a delta is the engine's `foldsEvent`, not this rule: a
    // SUBSCRIPTION names the type to watch live state.)
    const t = "events.iterate.com/live-state/changed";
    expect(consumesEvent(undefined, { type: t, ephemeral: true })).toBe(false);
    expect(consumesEvent(["*"], { type: t, ephemeral: true })).toBe(false);
    expect(consumesEvent([t], { type: t, ephemeral: true })).toBe(true);
  });
});

describe("the concurrency contract", () => {
  test("rules 1+2 — strict per-event barrier: blocked work finishes before the next event starts", async () => {
    const { processor, tick } = setup();
    tick();
    tick();
    tick();
    await processor.wake();
    const starts = processor.trace.filter((t) => t.startsWith("start"));
    const dones = processor.trace.filter((t) => t.startsWith("blocked-done"));
    expect(starts).toEqual(["start 1", "start 2", "start 3"]);
    expect(dones).toEqual(["blocked-done 1", "blocked-done 2", "blocked-done 3"]);
    // interleaving check: start N+1 never appears before blocked-done N
    expect(processor.trace.indexOf("start 2")).toBeGreaterThan(
      processor.trace.indexOf("blocked-done 1"),
    );
    expect(processor.trace.indexOf("start 3")).toBeGreaterThan(
      processor.trace.indexOf("blocked-done 2"),
    );
  });

  test("rule 3 — runInBackground escapes the barrier", async () => {
    const mem = memoryStream();
    const order: string[] = [];
    const Contract = defineProcessorContract({
      slug: "bg",
      version: "1",
      description: "",
      stateSchema: z.object({}),
      events: {},
      consumes: ["e"],
      emits: [],
    });
    class Bg extends StreamProcessor<object> {
      readonly contract = Contract;
      protected override processEvent(args: ProcessEventArgs<object>): undefined {
        if (!args.event) return;
        args.runInBackground(async () => {
          await new Promise((r) => setTimeout(r, 20));
          order.push(`bg ${args.event!.offset}`);
        });
        order.push(`fg ${args.event.offset}`);
      }
    }
    const bg = new Bg({ stream: mem.stream, storage: memoryStorage(), path: "/", projectId: "p" });
    mem.stream.append({ type: "e" }, { type: "e" }) as StreamEvent[];
    await bg.wake();
    expect(order).toEqual(["fg 1", "fg 2"]); // background hasn't landed — it overtakes/loiters
    await new Promise((r) => setTimeout(r, 30));
    expect(order.slice(2).sort()).toEqual(["bg 1", "bg 2"]);
  });

  test("rule 4 — one persist per pushed scannedOffsetRange, cursor advances only after", async () => {
    const { storage, processor, stream } = setup();
    const before = storage.writes;
    stream.append(
      { type: "events.iterate.com/counter/ticked" },
      { type: "events.iterate.com/counter/ticked" },
      { type: "events.iterate.com/counter/ticked" },
    ) as StreamEvent[];
    await processor.wake();
    await settle();
    // the whole 3-event scannedOffsetRange persists ONCE: cursor + state (2 writes). The milestone lands
    // as its own scannedOffsetRange — cursor only, its reduce didn't change state (1 write, no state blob).
    expect(storage.writes - before).toBe(3);
  });

  test("rule 5 — at-head pass fires exactly once when the scannedOffsetRange reaches the head", async () => {
    const { processor, stream } = setup();
    stream.append({ type: "unrelated" }) as StreamEvent[]; // consumed by nobody
    await processor.wake();
    expect(processor.trace).toEqual(["at-head ticks=0"]); // no consumable events → eventless pass
  });

  test("redelivery dedupes against the persisted cursor", async () => {
    const { processor, tick } = setup();
    tick();
    await processor.wake();
    await processor.wake(); // nothing new — no re-processing
    expect(processor.trace.filter((t) => t === "start 1")).toHaveLength(1);
  });

  test("a failing scannedOffsetRange persists nothing and the next wake retries it whole", async () => {
    const mem = memoryStream();
    const storage = memoryStorage();
    let attempts = 0;
    const Contract = defineProcessorContract({
      slug: "flaky",
      version: "1",
      description: "",
      stateSchema: z.object({ seen: z.number().default(0) }),
      events: {},
      consumes: ["e"],
      emits: [],
    });
    class Flaky extends StreamProcessor<{ seen: number }> {
      readonly contract = Contract;
      protected override reduce({ state }: ReduceArgs<{ seen: number }>) {
        return { seen: state.seen + 1 };
      }
      protected override processEvent(args: ProcessEventArgs<{ seen: number }>): undefined {
        if (!args.event) return;
        args.blockProcessorWhile(async () => {
          attempts++;
          if (attempts === 1) throw new Error("boom");
        });
      }
    }
    const flaky = new Flaky({ stream: mem.stream, storage, path: "/", projectId: "p" });
    mem.procs.push(flaky);
    mem.stream.append({ type: "e" }) as StreamEvent[]; // the auto-push fails (attempt 1)
    await settle();
    expect(storage.get("reduce:flaky:progress")).toBeUndefined(); // nothing persisted
    await flaky.wake(); // retried whole
    expect(attempts).toBe(2);
    const snap = await flaky.snapshot();
    expect(snap.state.seen).toBe(1);
  });
});

describe("the push door (scan scannedOffsetRanges)", () => {
  test("a contiguous push reduces WITHOUT reading the log (the fast path)", async () => {
    const mem = setup();
    mem.tick();
    await settle();
    expect(mem.processor.trace).toContain("start 1");
    expect(mem.reads).toBe(0); // the batch itself was enough — zero log reads
  });

  test("a gapped push triggers repair from the own cursor (nothing skipped)", async () => {
    const mem = memoryStream();
    mem.stream.append({ type: "events.iterate.com/counter/ticked" }) as StreamEvent[]; // history
    const storage = memoryStorage();
    const late = new CounterProcessor({ stream: mem.stream, storage, path: "/", projectId: "p" });
    mem.procs.push(late); // registered AFTER history exists
    mem.stream.append({ type: "events.iterate.com/counter/ticked" }) as StreamEvent[]; // gapped push
    await settle();
    expect(late.trace.filter((t) => t.startsWith("start"))).toEqual(["start 1", "start 2"]);
    expect(mem.reads).toBeGreaterThan(0); // repair read the gap
  });

  test("a stale scannedOffsetRange (already behind the cursor) is a no-op", async () => {
    const { processor, tick } = setup();
    tick();
    await processor.wake();
    await processor.processEventBatch([], { after: 0, through: 1 });
    expect(processor.trace.filter((t) => t.startsWith("start"))).toEqual(["start 1"]);
  });
});

// ── the at-head pass is tied to the SHOWN head ──

function ev(offset: number, type = "t"): StreamEvent {
  return {
    type,
    payload: { n: offset },
    createdAt: new Date(offset).toISOString(),
    offset,
    path: "/",
  };
}

const CaughtUpContract = defineProcessorContract({
  slug: "caughtup-probe",
  version: "1.0.0",
  description: "counts delivery.caughtUp firings — the at-head-pass probe",
  stateSchema: z.object({ n: z.number().default(0) }),
  events: {},
  consumes: ["*"],
  emits: [],
});
class CaughtUpProbe extends StreamProcessor<{ n: number }> {
  readonly contract = CaughtUpContract;
  caughtUps = 0;
  protected override reduce({ state }: ReduceArgs<{ n: number }>) {
    return { n: state.n + 1 };
  }
  protected override processEvent(args: ProcessEventArgs<{ n: number }>): undefined {
    if (args.delivery.caughtUp) this.caughtUps++;
  }
}
/** A probe over a stream with nothing to read; `readFails` makes every self-pull reject. */
const caughtUpProbe = (readFails?: Error) =>
  new CaughtUpProbe({
    stream: {
      append: () => [],
      read: () =>
        readFails
          ? Promise.reject(readFails)
          : Promise.resolve({ events: [], scannedThroughOffset: 0 }),
    },
    storage: memoryStorage(),
    path: "/",
    projectId: "prj_t",
  });

describe("delivery.caughtUp is tied to the SHOWN head", () => {
  test("two contiguous pushes enqueued back-to-back — only the one reaching the shown head fires caughtUp", async () => {
    // Both pushes sit on the chain before either runs, so the processor has been SHOWN through=2
    // when the through=1 batch runs: that batch is not at head. Contiguity alone never earns the
    // at-head pass — the reconcile work it triggers must run against the head fold, not a stale one.
    const p = caughtUpProbe();
    const first = p.processEventBatch([ev(1)], { after: 0, through: 1 });
    const second = p.processEventBatch([ev(2)], { after: 1, through: 2 });
    await Promise.all([first, second]);
    expect(p.caughtUps).toBe(1);
  });

  test("a single push that reaches the shown head fires caughtUp once", async () => {
    const p = caughtUpProbe();
    await p.processEventBatch([ev(1)], { after: 0, through: 1 });
    expect(p.caughtUps).toBe(1);
  });
});

describe("ephemeral events", () => {
  const EphContract = defineProcessorContract({
    slug: "eph",
    version: "1",
    description: "",
    stateSchema: z.object({ seen: z.array(z.string()).default([]) }),
    events: {},
    consumes: ["loud", "chunk"], // "chunk" arrives ephemeral — NAMED, so it is consumed
    emits: [],
  });
  class Eph extends StreamProcessor<{ seen: string[] }> {
    readonly contract = EphContract;
    protected override reduce({ event, state }: ReduceArgs<{ seen: string[] }>) {
      return { seen: [...state.seen, `${event.type}@${event.offset}`] };
    }
    // This suite asserts exact offsets; opt out of the default live-state emit (a constant projection
    // never diffs) so its ephemeral deltas don't consume offsets under test.
    protected override projectLiveState() {
      return null;
    }
  }
  const StarContract = defineProcessorContract({
    slug: "star",
    version: "1",
    description: "",
    stateSchema: z.object({ seen: z.array(z.string()).default([]) }),
    events: {},
    consumes: ["*"], // star NEVER sweeps ephemerals
    emits: [],
  });
  class Star extends StreamProcessor<{ seen: string[] }> {
    readonly contract = StarContract;
    protected override reduce({ event, state }: ReduceArgs<{ seen: string[] }>) {
      return { seen: [...state.seen, `${event.type}@${event.offset}`] };
    }
    protected override projectLiveState() {
      return null;
    }
  }

  test("shared offsets; named-type opt-in; '*' never sweeps; zero persists for ephemeral-only scannedOffsetRanges", async () => {
    const mem = memoryStream();
    const ephStorage = memoryStorage();
    const starStorage = memoryStorage();
    const eph = new Eph({ stream: mem.stream, storage: ephStorage, path: "/", projectId: "p" });
    const star = new Star({ stream: mem.stream, storage: starStorage, path: "/", projectId: "p" });
    mem.procs.push(eph, star);

    mem.stream.append({ type: "loud" }) as StreamEvent[]; // offset 1, durable
    await settle();
    const ephWrites = ephStorage.writes;
    const starWrites = starStorage.writes;

    mem.stream.append({ type: "chunk", ephemeral: true }) as StreamEvent[]; // offset 2, ephemeral
    mem.stream.append({ type: "chunk", ephemeral: true }) as StreamEvent[]; // offset 3
    await settle();
    // the NAMED consumer reduced both ephemerals in memory…
    expect((await eph.snapshot()).state.seen).toEqual(["loud@1", "chunk@2", "chunk@3"]);
    // …the "*" consumer saw neither…
    expect((await star.snapshot()).state.seen).toEqual(["loud@1"]);
    // …and the ephemeral-only scannedOffsetRanges persisted NOTHING for either.
    expect(ephStorage.writes).toBe(ephWrites);
    expect(starStorage.writes).toBe(starWrites);

    mem.stream.append({ type: "loud" }) as StreamEvent[]; // offset 4 — durable, AFTER the gap
    await settle();
    expect((await star.snapshot()).state.seen).toEqual(["loud@1", "loud@4"]); // holes invisible
  });

  test("a rebuilt reduce omits ephemerals (never derive durable truth from one)", async () => {
    const mem = memoryStream();
    const storage = memoryStorage();
    const a = new Eph({ stream: mem.stream, storage, path: "/", projectId: "p" });
    mem.procs.push(a);
    mem.stream.append({ type: "loud" }) as StreamEvent[];
    mem.stream.append({ type: "chunk", ephemeral: true }) as StreamEvent[];
    mem.stream.append({ type: "loud" }) as StreamEvent[];
    await settle();
    expect((await a.snapshot()).state.seen).toEqual(["loud@1", "chunk@2", "loud@3"]);
    // a fresh incarnation over the same storage: the ephemeral is gone from the log — the reduce
    // regresses to durable truth only, and the offsets are simply gaps
    const b = new Eph({ stream: mem.stream, storage, path: "/", projectId: "p" });
    // (simulate: the last durable persist covered through offset 3; state includes chunk@2 only
    //  because that scannedOffsetRange ALSO contained a durable event — the documented divergence rule)
    expect((await b.snapshot()).state.seen).toContain("loud@3");
  });

  test("a barrier that reaches the head BEFORE the commit's own push still leaves the named ephemeral delivered", async () => {
    // The wake behind a read-your-writes barrier catches up the durable log and, via the
    // head-clamped proof, advances the cursor OVER the ephemeral's offset while consuming only the
    // durable. The commit's fire-and-forget push then arrives wholly behind the cursor: it must fold
    // nothing twice yet still deliver its named ephemeral (pushes are an ephemeral's ONLY delivery,
    // and a live processor was handed it).
    const mem = memoryStream();
    const p = new Eph({ stream: mem.stream, storage: memoryStorage(), path: "/", projectId: "p" });
    mem.stream.append({ type: "loud" }); // offset 1, durable
    await p.wake();
    // one commit: durable loud@2 + ephemeral chunk@3 → range (1,3]; hand-delivered below
    const committed = mem.stream.append(
      { type: "loud" },
      { type: "chunk", ephemeral: true },
    ) as StreamEvent[];
    await p.waitUntilProcessed({ offset: 3, timeoutMs: 1000 }); // the barrier's wake wins the race…
    await p.processEventBatch(committed, { after: 1, through: 3 }); // …then the push lands
    expect((await p.snapshot()).state.seen).toEqual(["loud@1", "loud@2", "chunk@3"]);
  });
});

describe("review round 1 regressions", () => {
  test("⚠️ a processor that AWAITS its own append inside a blocker must not deadlock", async () => {
    const mem = memoryStream();
    const storage = memoryStorage();
    const Contract = defineProcessorContract({
      slug: "echoer",
      version: "1",
      description: "",
      stateSchema: z.object({}),
      events: { echoed: { payloadSchema: z.object({}) } },
      consumes: ["ping"],
      emits: ["echoed"],
    });
    class Echoer extends StreamProcessor<object> {
      readonly contract = Contract;
      protected override processEvent(args: ProcessEventArgs<object>): undefined {
        if (args.event?.type !== "ping") return;
        args.blockProcessorWhile(() => args.append({ type: "echoed", idempotencyKey: "once" }));
      }
    }
    mem.procs.push(new Echoer({ stream: mem.stream, storage, path: "/", projectId: "p" }));
    mem.stream.append({ type: "ping" }) as StreamEvent[]; // pre-fix shape: would hang forever
    await settle();
    expect(mem.events.some((e) => e.type === "echoed")).toBe(true);
  }, 5000);
});

describe("reduce cache + refold", () => {
  test("version bump refolds via reduce only — effects never re-run", async () => {
    const mem = memoryStream();
    const storage = memoryStorage();
    const make = (version: string, effects: string[]) => {
      const Contract = defineProcessorContract({
        slug: "reduce",
        version,
        description: "",
        stateSchema: z.object({ n: z.number().default(0) }),
        events: {},
        consumes: ["events.iterate.com/counter/ticked"],
        emits: [],
      });
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
    const effects: string[] = [];
    const p1 = make("1.0.0", effects);
    mem.stream.append(
      { type: "events.iterate.com/counter/ticked" },
      { type: "events.iterate.com/counter/ticked" },
    ) as StreamEvent[];
    await p1.wake();
    expect(effects).toHaveLength(2);
    // new incarnation with a bumped contract version: refold, but NO new effects for old events
    const p2 = make("2.0.0", effects);
    const snap = await p2.snapshot();
    expect(snap.state.n).toBe(2); // refolded
    expect(effects).toHaveLength(2); // side effects did NOT re-run
  });
});

describe("emit rules + idempotency", () => {
  test("milestone emitted with provenance stamp + idempotency key; re-wake dedupes", async () => {
    const { processor, tick, events } = setup();
    tick();
    tick();
    tick();
    tick(); // ticks: 1,2,3,4 — milestone at state.ticks===3 (after 3rd tick)
    await processor.wake();
    await settle();
    const milestones = events.filter((e) => e.type === "events.iterate.com/counter/milestone");
    expect(milestones).toHaveLength(1);
    expect(milestones[0].payload).toEqual({ at: 3 });
    expect(milestones[0].source?.processor?.slug).toBe("counter");
    expect(milestones[0].source?.processor?.whileProcessing?.offset).toBe(3);
    // the milestone append itself lands on the stream and re-delivers — wake again, still one
    await processor.wake();
    expect(events.filter((e) => e.type === "events.iterate.com/counter/milestone")).toHaveLength(1);
  });

  test("undeclared emit throws", async () => {
    const mem = memoryStream();
    const Contract = defineProcessorContract({
      slug: "rogue",
      version: "1",
      description: "",
      stateSchema: z.object({}),
      events: {},
      consumes: ["e"],
      emits: [],
    });
    class Rogue extends StreamProcessor<object> {
      readonly contract = Contract;
      protected override processEvent(args: ProcessEventArgs<object>): undefined {
        if (args.event) args.blockProcessorWhile(() => args.append({ type: "not-declared" }));
      }
    }
    const rogue = new Rogue({
      stream: mem.stream,
      storage: memoryStorage(),
      path: "/",
      projectId: "p",
    });
    mem.stream.append({ type: "e" }) as StreamEvent[];
    await expect(rogue.wake()).rejects.toThrow(/without declaring/);
  });

  test("waitUntilProcessed resolves at the cursor", async () => {
    const { processor, tick } = setup();
    tick();
    await expect(
      processor.waitUntilProcessed({ offset: 1, timeoutMs: 1000 }),
    ).resolves.toBeUndefined();
  });
});

describe("live state (the delta patches on the wire)", () => {
  const contract = defineProcessorContract({
    slug: "tally",
    version: "1.0.0",
    description: "counts events; projects a trimmed live shape",
    stateSchema: z.object({ count: z.number().default(0), secret: z.string().default("hidden") }),
    events: {},
    consumes: ["tick"],
    emits: [],
  });
  class Tally extends StreamProcessor<z.infer<typeof contract.stateSchema>> {
    contract = contract;
    reduce({ event, state }: ReduceArgs<z.infer<typeof contract.stateSchema>>) {
      if (event.type === "tick") return { ...state, count: state.count + 1 };
      return undefined;
    }
    projectLiveState(state: z.infer<typeof contract.stateSchema>) {
      return { count: state.count }; // the projection REDACTS — diffs never see `secret`
    }
  }

  const changes = (mem: ReturnType<typeof memoryStream>) =>
    mem.pushed.filter((e) => e.type === "events.iterate.com/live-state/changed");

  test("a reduce that changes the projection emits ONE ephemeral change event carrying the patch", async () => {
    const mem = memoryStream();
    const p = new Tally({
      stream: mem.stream,
      storage: memoryStorage(),
      path: "/",
      projectId: "p",
    });
    mem.procs.push(p);
    mem.stream.append({ type: "tick" }) as StreamEvent[];
    await settle();
    expect(changes(mem)).toHaveLength(1); // ONE change event per changed scannedOffsetRange, not per event
    const [c] = changes(mem);
    expect(c.ephemeral).toBe(true);
    expect(c.payload).toMatchObject({
      key: "tally",
      patch: [{ op: "replace", path: "/count", value: 1 }],
    });
  });

  test("revisions chain: each emission's `from` equals the previous emission's `to`", async () => {
    const mem = memoryStream();
    const p = new Tally({
      stream: mem.stream,
      storage: memoryStorage(),
      path: "/",
      projectId: "p",
    });
    mem.procs.push(p);
    mem.stream.append({ type: "tick" }) as StreamEvent[];
    await settle();
    mem.stream.append({ type: "other" }) as StreamEvent[]; // not consumed — a silent batch
    await settle();
    mem.stream.append({ type: "tick" }) as StreamEvent[];
    await settle();
    const [c1, c2] = changes(mem).map((e) => e.payload as { from: number; to: number });
    expect(c2.from).toBe(c1.to); // the silent batch did NOT break the chain
  });

  test("liveSnapshot() mints the rev the next emission chains from ({rev,state} atomically)", async () => {
    const mem = memoryStream();
    const p = new Tally({
      stream: mem.stream,
      storage: memoryStorage(),
      path: "/",
      projectId: "p",
    });
    mem.procs.push(p);
    mem.stream.append({ type: "other" }) as StreamEvent[]; // advance the cursor, no projection change
    await settle();
    const seed = await p.liveSnapshot();
    expect(seed.state).toEqual({ count: 0 });
    mem.stream.append({ type: "tick" }) as StreamEvent[];
    await settle();
    const [c] = changes(mem).map((e) => e.payload as { from: number });
    expect(c.from).toBe(seed.rev); // seed → first patch, no re-seed needed
  });

  test("no emission when consumed events leave the projection unchanged", async () => {
    const contract2 = defineProcessorContract({
      slug: "flat",
      version: "1.0.0",
      description: "consumes but never changes its projection",
      stateSchema: z.object({ seen: z.number().default(0) }),
      events: {},
      consumes: ["tick"],
      emits: [],
    });
    class Flat extends StreamProcessor<z.infer<typeof contract2.stateSchema>> {
      contract = contract2;
      reduce({ state }: ReduceArgs<z.infer<typeof contract2.stateSchema>>) {
        return { seen: state.seen + 1 };
      }
      projectLiveState() {
        return { steady: true };
      }
    }
    const mem = memoryStream();
    const p = new Flat({ stream: mem.stream, storage: memoryStorage(), path: "/", projectId: "p" });
    mem.procs.push(p);
    mem.stream.append({ type: "tick" }, { type: "tick" }) as StreamEvent[];
    await settle();
    expect(changes(mem)).toHaveLength(0);
  });

  test("the loop guard: a processor's reduce never sees a live-state delta, even when its contract names the type", async () => {
    // The refusal lives in the ENGINE (`foldsEvent`), not in `consumesEvent`: naming
    // `events.iterate.com/live-state/changed` in a SUBSCRIPTION's `consumes` is how a live tab
    // receives deltas, so `consumesEvent` says yes to a named delta — and the engine still never
    // folds one (a delta feeding a reduce is the feedback-loop class, made unspellable here).
    const contract3 = defineProcessorContract({
      slug: "sneaky",
      version: "1.0.0",
      description: "tries to consume the platform live-state type",
      stateSchema: z.object({ seen: z.number().default(0) }),
      events: {},
      consumes: ["*", "events.iterate.com/live-state/changed"],
      emits: [],
    });
    class Sneaky extends StreamProcessor<z.infer<typeof contract3.stateSchema>> {
      contract = contract3;
      reduce({ state }: ReduceArgs<z.infer<typeof contract3.stateSchema>>) {
        return { seen: state.seen + 1 };
      }
      // Opt out of its OWN live-state emit so the assertion counts only tally's change event — the
      // point here is that Sneaky never CONSUMES a change event (the loop guard), not what it emits.
      protected override projectLiveState() {
        return null;
      }
    }
    const mem = memoryStream();
    const tally = new Tally({
      stream: mem.stream,
      storage: memoryStorage(),
      path: "/",
      projectId: "p",
    });
    const sneaky = new Sneaky({
      stream: mem.stream,
      storage: memoryStorage(),
      path: "/",
      projectId: "p",
    });
    mem.procs.push(tally, sneaky);
    mem.stream.append({ type: "tick" }) as StreamEvent[]; // tally emits a change event
    await settle();
    expect(changes(mem)).toHaveLength(1);
    expect((await sneaky.snapshot()).state.seen).toBe(1); // the tick — NOT the change event
  });
});

describe("live state emission failure is contained", () => {
  test("a throwing/unserializable projection loses the notification, never the batch", async () => {
    const contract = defineProcessorContract({
      slug: "biggie",
      version: "1.0.0",
      description: "keeps a BigInt in state — the projection cannot serialize",
      stateSchema: z.object({ n: z.number().default(0) }),
      events: {},
      consumes: ["tick"],
      emits: [],
    });
    class Biggie extends StreamProcessor<z.infer<typeof contract.stateSchema>> {
      contract = contract;
      reduce({ state }: ReduceArgs<z.infer<typeof contract.stateSchema>>) {
        return { n: state.n + 1 };
      }
      projectLiveState() {
        return { big: 10n }; // JSON.stringify throws TypeError on BigInt
      }
    }
    const mem = memoryStream();
    const p = new Biggie({
      stream: mem.stream,
      storage: memoryStorage(),
      path: "/",
      projectId: "p",
    });
    mem.procs.push(p);
    mem.stream.append({ type: "tick" }) as StreamEvent[];
    await settle();
    // the reduce committed and the read surface works — the failure was only the notification
    await expect(p.snapshot()).resolves.toMatchObject({ state: { n: 1 } });
    expect(
      mem.pushed.filter((e) => e.type === "events.iterate.com/live-state/changed"),
    ).toHaveLength(0);
  });
});

// ── the persisted cursor across evictions and version bumps; the barrier's failure modes ──

/** Reduces ticks AND records an effect per consumed event — the two things a refold and an
 *  eviction must treat differently (state is rebuilt from the log; effects never re-run). */
const CountContract = (version: string) =>
  defineProcessorContract({
    slug: "count",
    version,
    description: "counts ticks, records an effect per consumed event",
    stateSchema: z.object({ ticks: z.number().default(0) }),
    events: {},
    consumes: ["tick"],
    emits: [],
  });
class CountProcessor extends StreamProcessor<{ ticks: number }> {
  readonly contract: ReturnType<typeof CountContract>;
  readonly effects: number[] = []; // offsets whose processEvent fired
  constructor(args: ConstructorParameters<typeof StreamProcessor>[0], version = "1.0.0") {
    super(args);
    this.contract = CountContract(version);
  }
  protected override reduce({ event, state }: ReduceArgs<{ ticks: number }>) {
    return event.type === "tick" ? { ticks: state.ticks + 1 } : undefined;
  }
  protected override processEvent(args: ProcessEventArgs<{ ticks: number }>): undefined {
    if (args.event) this.effects.push(args.event.offset);
  }
  protected override projectLiveState() {
    return null; // exact-offset suite: opt out of the default live-state emit
  }
}
/** A reduce that NEVER changes state — so the state key is never written, only the cursor. */
const EffectOnlyContract = defineProcessorContract({
  slug: "eff",
  version: "1.0.0",
  description: "pure side-effect processor: reduce never changes state",
  stateSchema: z.object({}),
  events: {},
  consumes: ["*"],
  emits: [],
});
class EffectOnlyProcessor extends StreamProcessor<Record<string, never>> {
  readonly contract = EffectOnlyContract;
  readonly effects: number[] = [];
  protected override reduce(): undefined {
    return undefined;
  }
  protected override processEvent(args: ProcessEventArgs<Record<string, never>>): undefined {
    if (args.event) this.effects.push(args.event.offset);
  }
}

describe("eviction honors the persisted cursor", () => {
  test("a caught-up EFFECT-ONLY processor does not replay effects across an eviction", async () => {
    // #loadProgress accepts the persisted cursor whenever the version matches, materializing
    // initialState() when the state key is absent — a processor that never changed state must not
    // fall back to offset 0 and re-drive the whole log WITH effects on every idle quiesce.
    const mem = memoryStream();
    const storage = memoryStorage();
    const p1 = new EffectOnlyProcessor({
      stream: mem.stream,
      storage,
      path: "/",
      projectId: "prj_t",
    });
    mem.procs.push(p1);
    for (let i = 0; i < 4; i++) mem.stream.append({ type: "boop" });
    await p1.wake();
    expect(p1.effects).toEqual([1, 2, 3, 4]);
    // The cursor IS persisted (rule 4), even though state never changed.
    expect(storage.get("reduce:eff:progress")).toMatchObject({ reducedThroughOffset: 4 });

    // Eviction: fresh instance, SAME storage + log, SAME version.
    const p2 = new EffectOnlyProcessor({
      stream: mem.stream,
      storage,
      path: "/",
      projectId: "prj_t",
    });
    mem.procs.length = 0;
    mem.procs.push(p2);
    await p2.wake();
    expect(p2.effects).toEqual([]); // the persisted cursor (4) means nothing to re-do
  });

  test("CONTROL: a state-changing processor does not replay effects across an eviction either", async () => {
    const mem = memoryStream();
    const storage = memoryStorage();
    const p1 = new CountProcessor({ stream: mem.stream, storage, path: "/", projectId: "prj_t" });
    mem.procs.push(p1);
    for (let i = 0; i < 4; i++) mem.stream.append({ type: "tick" });
    await p1.wake();
    expect(p1.effects).toEqual([1, 2, 3, 4]);

    const p2 = new CountProcessor({ stream: mem.stream, storage, path: "/", projectId: "prj_t" });
    mem.procs.length = 0;
    mem.procs.push(p2);
    await p2.wake();
    expect(p2.effects).toEqual([]); // cursor honored — no replay
  });

  test("a version bump over a stored cursor at offset 0 terminates and yields the initial state", async () => {
    const mem = memoryStream();
    const storage = memoryStorage();
    // A v1 cursor at offset 0 (as if nothing was ever consumed), then a v2 incarnation.
    storage.put("reduce:count:progress", { reducerVersion: "1.0.0", reducedThroughOffset: 0 });
    const p2 = new CountProcessor(
      { stream: mem.stream, storage, path: "/", projectId: "prj_t" },
      "2.0.0",
    );
    mem.procs.push(p2);
    expect(await p2.snapshot()).toEqual({ offset: 0, state: { ticks: 0 } });
  });
});

describe("waitUntilProcessed — resolution and failure modes", () => {
  test("resolves a waiter whose offset the version refold reached (no batch was ever pushed)", async () => {
    const mem = memoryStream();
    const storage = memoryStorage();
    const p1 = new CountProcessor({ stream: mem.stream, storage, path: "/", projectId: "prj_t" });
    mem.procs.push(p1);
    for (let i = 0; i < 3; i++) mem.stream.append({ type: "tick" });
    await p1.wake();

    // A bumped incarnation waits for an offset the refold (ceiling = 3) covers. No new push, so
    // the wake's catch-up reads an empty page and never runs a batch — only the refold advances
    // progress; the post-wake re-check must still resolve the waiter.
    const p2 = new CountProcessor(
      { stream: mem.stream, storage, path: "/", projectId: "prj_t" },
      "2.0.0",
    );
    mem.procs.length = 0;
    mem.procs.push(p2);
    await expect(p2.waitUntilProcessed({ offset: 3, timeoutMs: 2000 })).resolves.toBeUndefined();
    expect(p2.effects).toEqual([]); // and the refold stayed reduce-only
  });

  test("does not spuriously resolve a waiter whose offset was NOT reached", async () => {
    const mem = memoryStream();
    const storage = memoryStorage();
    const p = new CountProcessor({ stream: mem.stream, storage, path: "/", projectId: "prj_t" });
    mem.procs.push(p);
    mem.stream.append({ type: "tick" }); // only offset 1 exists
    await p.wake();
    await expect(p.waitUntilProcessed({ offset: 5, timeoutMs: 120 })).rejects.toThrow(
      /did not reach offset 5/,
    );
  });

  test("a self-pull that THROWS rejects the barrier with the read failure — promptly, not the generic timeout", async () => {
    // wake enqueues the catch-up on the serial chain, whose failure the chain swallows (a failed
    // batch must not wedge it); the waiter must still be told, so a transient read error is one
    // fast rejection the caller can retry instead of a full-timeout park.
    const p = caughtUpProbe(new Error("self-pull read failed: boom"));
    await expect(p.waitUntilProcessed({ offset: 5, timeoutMs: 1500 })).rejects.toThrow(/boom/);
  });
});
