// Executable spec for the processor layer — each block names the concurrency rule it proves.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type StreamEvent,
  type StreamEventInput,
} from "./events.ts";
import {
  createStreamProcessorRegistry,
  defineProcessorContract,
  StreamProcessor,
  type ProcessEventArgs,
  type ProcessorStream,
  type ReduceArgs,
} from "./processor.ts";

// ── a tiny in-memory stream + storage, faithful to the DO's commit semantics ──

function memoryStream(path = "/") {
  const events: StreamEvent[] = [];
  const byKey = new Map<string, StreamEvent>();
  const stream: ProcessorStream = {
    append: (...inputs: StreamEventInput[]) =>
      inputs.map((input) => {
        if (input.idempotencyKey) {
          const existing = byKey.get(input.idempotencyKey);
          if (existing) {
            if (sameIdempotentEvent(existing, input)) return existing;
            throw new Error(idempotencyConflictMessage(input.idempotencyKey, existing.offset));
          }
        }
        const event: StreamEvent = {
          ...input,
          offset: events.length + 1,
          createdAt: new Date(0).toISOString(),
          path,
        };
        events.push(event);
        if (input.idempotencyKey) byKey.set(input.idempotencyKey, event);
        return event;
      }),
    read: (afterOffset = 0, limit = 500) =>
      events.filter((e) => e.offset > afterOffset).slice(0, limit),
  };
  return { stream, events };
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
  const { stream, events } = memoryStream();
  const storage = memoryStorage();
  const registry = createStreamProcessorRegistry({
    storage,
    stream,
    path: "/",
    projectId: "prj_t",
  });
  const processor = registry.register(
    new CounterProcessor({ stream, path: "/", projectId: "prj_t" }),
  );
  const tick = () =>
    (stream.append({ type: "events.iterate.com/counter/ticked" }) as StreamEvent[])[0];
  return { stream, events, storage, registry, processor, tick };
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
    const { registry, processor, tick } = setup();
    tick();
    tick();
    tick();
    await registry.deliver();
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
    const { stream, registry } = setup();
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
    registry.register(new Bg({ stream, path: "/", projectId: "p" }));
    stream.append({ type: "e" }, { type: "e" }) as StreamEvent[];
    await registry.deliver();
    expect(order).toEqual(["fg 1", "fg 2"]); // background hasn't landed — it overtakes/loiters
    await new Promise((r) => setTimeout(r, 30));
    expect(order.slice(2).sort()).toEqual(["bg 1", "bg 2"]);
  });

  test("rule 4 — one persist per batch, cursor advances only after", async () => {
    const { registry, storage, tick } = setup();
    tick();
    tick();
    tick();
    const before = storage.writes;
    await registry.deliver();
    // one progress write for the whole 3-event batch (+ the milestone append is stream-side)
    expect(storage.writes - before).toBe(1);
  });

  test("rule 5 — at-head pass fires exactly once when the batch reaches the head", async () => {
    const { registry, processor, stream } = setup();
    stream.append({ type: "unrelated" }) as StreamEvent[]; // consumed by nobody
    await registry.deliver();
    expect(processor.trace).toEqual(["at-head ticks=0"]); // no consumable events → eventless pass
  });

  test("redelivery dedupes against the persisted cursor", async () => {
    const { registry, processor, tick } = setup();
    tick();
    await registry.deliver();
    await registry.deliver(); // same batch again
    expect(processor.trace.filter((t) => t === "start 1")).toHaveLength(1);
  });

  test("a failing batch persists nothing and catchUp retries it whole", async () => {
    const { stream, storage } = setup();
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
    const registry = createStreamProcessorRegistry({ storage, stream, path: "/", projectId: "p" });
    const flaky = registry.register(new Flaky({ stream, path: "/", projectId: "p" }));
    stream.append({ type: "e" }) as StreamEvent[];
    await expect(registry.deliver()).rejects.toThrow("boom");
    expect(storage.get("processor:flaky:progress")).toBeUndefined(); // nothing persisted
    await registry.catchUp("flaky"); // retried whole
    expect(attempts).toBe(2);
    const snap = await registry.reads(flaky).snapshot();
    expect(snap.state.seen).toBe(1);
  });
});

describe("review round 1 regressions", () => {
  test("⚠️ a processor that AWAITS its own append inside a blocker must not deadlock (re-entrant deliver)", async () => {
    const { stream, events } = memoryStream();
    const storage = memoryStorage();
    const registry = createStreamProcessorRegistry({ storage, stream, path: "/", projectId: "p" });
    // the REAL DO shape: append re-enters deliver (awaited) — the in-memory stream now mimics it
    const rawAppend = stream.append.bind(stream);
    stream.append = async (...inputs: StreamEventInput[]) => {
      const committed = rawAppend(...inputs) as StreamEvent[];
      await registry.deliver();
      return committed;
    };
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
    registry.register(new Echoer({ stream, path: "/", projectId: "p" }));
    await stream.append({ type: "ping" }); // would hang forever pre-fix
    await registry.catchUp();
    expect(events.some((e) => e.type === "echoed")).toBe(true);
  }, 5000);

  test("delivery is cursor-driven: a late-enabled processor never skips history", async () => {
    const { stream } = memoryStream();
    stream.append({ type: "a" }, { type: "b" }) as StreamEvent[]; // history BEFORE registration
    const storage = memoryStorage();
    const registry = createStreamProcessorRegistry({ storage, stream, path: "/", projectId: "p" });
    const seen: string[] = [];
    const Contract = defineProcessorContract({
      slug: "late",
      version: "1",
      description: "",
      stateSchema: z.object({}),
      events: {},
      consumes: ["*"],
      emits: [],
    });
    class Late extends StreamProcessor<object> {
      readonly contract = Contract;
      protected override processEvent(args: ProcessEventArgs<object>): undefined {
        if (args.event) seen.push(args.event.type);
      }
    }
    registry.register(new Late({ stream, path: "/", projectId: "p" }));
    stream.append({ type: "c" }) as StreamEvent[];
    await registry.deliver(); // pre-fix: only "c" — the a/b gap was skipped forever
    expect(seen).toEqual(["a", "b", "c"]);
  });
});

describe("fold cache + refold", () => {
  test("version bump refolds via reduce only — effects never re-run", async () => {
    const { stream } = setup();
    const storage = memoryStorage();
    const make = (version: string, effects: string[]) => {
      const Contract = defineProcessorContract({
        slug: "fold",
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
      })({ stream, path: "/", projectId: "p" });
    };
    const effects: string[] = [];
    const r1 = createStreamProcessorRegistry({ storage, stream, path: "/", projectId: "p" });
    r1.register(make("1.0.0", effects));
    stream.append(
      { type: "events.iterate.com/counter/ticked" },
      { type: "events.iterate.com/counter/ticked" },
    ) as StreamEvent[];
    await r1.deliver();
    expect(effects).toHaveLength(2);
    // new incarnation with a bumped contract version: refold, but NO new effects for old events
    const r2 = createStreamProcessorRegistry({ storage, stream, path: "/", projectId: "p" });
    const p2 = r2.register(make("2.0.0", effects));
    const snap = await r2.reads(p2).snapshot();
    expect(snap.state.n).toBe(2); // refolded
    expect(effects).toHaveLength(2); // side effects did NOT re-run
  });
});

describe("emit rules + idempotency", () => {
  test("milestone emitted with provenance stamp + idempotency key; duplicate deliver dedupes", async () => {
    const { registry, tick, events } = setup();
    tick();
    tick();
    tick();
    tick(); // ticks: 1,2,3,4 — milestone at state.ticks===3 (after 3rd tick)
    await registry.deliver();
    const milestones = events.filter((e) => e.type === "events.iterate.com/counter/milestone");
    expect(milestones).toHaveLength(1);
    expect(milestones[0].payload).toEqual({ at: 3 });
    expect(milestones[0].source?.processor?.slug).toBe("counter");
    expect(milestones[0].source?.processor?.whileProcessing?.offset).toBe(3);
    // the milestone append itself lands on the stream and re-delivers — drive again, still one
    await registry.catchUp();
    expect(events.filter((e) => e.type === "events.iterate.com/counter/milestone")).toHaveLength(1);
  });

  test("undeclared emit throws", async () => {
    const { stream, storage } = setup();
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
    const registry = createStreamProcessorRegistry({ storage, stream, path: "/", projectId: "p" });
    registry.register(new Rogue({ stream, path: "/", projectId: "p" }));
    stream.append({ type: "e" }) as StreamEvent[];
    await expect(registry.deliver()).rejects.toThrow(/without declaring/);
  });

  test("waitUntilProcessed resolves at the cursor", async () => {
    const { registry, processor, tick } = setup();
    tick();
    const wait = registry.reads(processor).waitUntilProcessed({ offset: 1, timeoutMs: 1000 });
    await registry.deliver();
    await expect(wait).resolves.toBeUndefined();
  });
});
