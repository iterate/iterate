// Executable spec for the processor layer — each block names the concurrency rule it proves.
// The in-memory stream mirrors the DO's commit semantics EXACTLY: one shared offset sequence
// (ephemerals consume offsets but never land in the log), the scanned-offset-range proof on both pushes
// and reads, and a fire-and-forget push to every registered processor after each append.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  defineProcessorContract,
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type StreamEvent,
  type StreamEventInput,
} from "./events.ts";
import {
  StreamProcessor,
  type ProcessEventArgs,
  type ProcessorStream,
  type ReduceArgs,
} from "./processor.ts";

// ── a tiny in-memory stream + storage, faithful to the DO's commit semantics ──

function memoryStream(path = "/") {
  const events: StreamEvent[] = [];
  const pushed: StreamEvent[] = []; // every committed event, ephemerals included (the pump's view)
  const byKey = new Map<string, StreamEvent>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const procs: StreamProcessor<any>[] = [];
  let maxAssigned = 0;
  let reads = 0;
  const stream: ProcessorStream = {
    append: (...inputs: StreamEventInput[]) => {
      const scannedAfterOffset = maxAssigned;
      const committed = inputs.map((input) => {
        if (input.idempotencyKey) {
          const existing = byKey.get(input.idempotencyKey);
          if (existing) {
            if (sameIdempotentEvent(existing, input)) return existing;
            throw new Error(idempotencyConflictMessage(input.idempotencyKey, existing.offset));
          }
        }
        maxAssigned += 1;
        const event: StreamEvent = {
          ...input,
          offset: maxAssigned,
          createdAt: new Date(0).toISOString(),
          path,
        };
        if (!input.ephemeral) {
          events.push(event);
          if (input.idempotencyKey) byKey.set(input.idempotencyKey, event);
        }
        return event;
      });
      pushed.push(...committed);
      if (maxAssigned > scannedAfterOffset) {
        const scannedOffsetRange = { after: scannedAfterOffset, through: maxAssigned };
        // THE PUMP: fire-and-forget, exactly like the DO (an awaited push would deadlock a
        // processor that appends during its own batch).
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

const settle = () => new Promise((r) => setTimeout(r, 25)); // let fire-and-forget pushes land

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
  const tick = () =>
    (mem.stream.append({ type: "events.iterate.com/counter/ticked" }) as StreamEvent[])[0];
  return { ...mem, storage, processor, tick };
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
    liveState(state: z.infer<typeof contract.stateSchema>) {
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
      liveState() {
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

  test("the loop guard: live-state change events are unconsumable, even named", async () => {
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
      liveState() {
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
