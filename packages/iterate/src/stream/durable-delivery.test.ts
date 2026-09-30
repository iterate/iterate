import { expect, test, vi } from "vitest";
import { codedError } from "../lib.ts";
import { DurableDeliveryProcessor } from "./durable-delivery.ts";
import { type EngineKv, type StreamEvent } from "./processor.ts";
import { committedEvent, memoryStream, settle } from "./test-support.ts";

test("persists selected offsets with the scanned range for its first invoke", async () => {
  const store = kv();
  const source = memoryStream();
  const read = vi.fn(durableRead(source.stream.read, ["work"]));
  const delivered = vi.fn(async () => {});
  await source.stream.append({ type: "work" }, { type: "noise" }, { type: "work" });
  const processor = new DurableDeliveryProcessor({
    slug: "delivery",
    consumes: ["work"],
    runtime: {
      storage: store,
      read,
      deliver: delivered,
      deliverEphemeral: async () => {},
      scheduleWake: async () => {},
      tryReservePendingEphemeral: testEphemeralReservation,
      terminal: async () => {},
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle();
  expect(delivered).toHaveBeenCalledWith(
    expect.objectContaining({
      offsets: [1, 3],
      range: { after: 0, through: 3 },
    }),
  );
  expect(store.values.get("durable-delivery/delivery")).toEqual({ confirmedOffset: 3 });
  // One metadata read admits the range; the second observes the caught-up head.
  expect(read).toHaveBeenCalledTimes(2);
});

test("a core terminal receipt invalidates an older in-flight runner generation", async () => {
  const store = kv();
  const source = memoryStream();
  await source.stream.append({ type: "work" });
  let rejectDelivery!: (error: Error) => void;
  const processor = new DurableDeliveryProcessor({
    slug: "core-halt",
    consumes: ["work"],
    runtime: {
      storage: store,
      read: durableRead(source.stream.read, ["work"]),
      deliver: async () =>
        await new Promise<void>((_, reject) => {
          rejectDelivery = reject;
        }),
      deliverEphemeral: async () => {},
      scheduleWake: async () => {},
      tryReservePendingEphemeral: testEphemeralReservation,
      terminal: async () => {},
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await vi.waitFor(() => expect(rejectDelivery).toBeTypeOf("function"));
  expect(processor.halt(0, 15, "core terminal")).toBe(true);
  rejectDelivery(new Error("configured subscription no longer accepts delivery"));
  await settle();
  expect(processor.snapshot()).toEqual({
    confirmedOffset: 0,
    halted: { after: 0, attempts: 15, error: "core terminal", terminalReported: true },
  });
});

test("a disposed runner cannot restore a deleted cursor after a late target result", async () => {
  const source = memoryStream();
  await source.stream.append({ type: "work" });
  for (const outcome of ["success", "failure"] as const) {
    const store = kv();
    let settleDelivery!: () => void;
    const terminal = vi.fn(async () => {});
    const scheduleWake = vi.fn(async () => {});
    const processor = new DurableDeliveryProcessor({
      slug: `disposed-${outcome}`,
      consumes: ["work"],
      maxAttempts: 1,
      runtime: {
        storage: store,
        read: durableRead(source.stream.read, ["work"]),
        deliver: async () =>
          await new Promise<void>((resolve, reject) => {
            settleDelivery = () => (outcome === "success" ? resolve() : reject(new Error("late")));
          }),
        deliverEphemeral: async () => {},
        scheduleWake,
        tryReservePendingEphemeral: testEphemeralReservation,
        terminal,
      },
    });
    const engine = driver(processor);
    await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
    await vi.waitFor(() => expect(settleDelivery).toBeTypeOf("function"));
    processor[Symbol.dispose]();
    store.values.delete(`durable-delivery/disposed-${outcome}`);
    settleDelivery();
    await settle();
    expect(store.values.has(`durable-delivery/disposed-${outcome}`)).toBe(false);
    expect(scheduleWake).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
  }
});

test("a disposed runner does not reclaim a wake when its source read rejects late", async () => {
  const store = kv();
  let rejectRead!: (error: Error) => void;
  const scheduleWake = vi.fn(async () => {});
  const processor = new DurableDeliveryProcessor({
    slug: "disposed-read",
    runtime: {
      storage: store,
      read: async () =>
        await new Promise<never>((_, reject) => {
          rejectRead = reject;
        }),
      deliver: async () => {},
      deliverEphemeral: async () => {},
      scheduleWake,
      tryReservePendingEphemeral: testEphemeralReservation,
      terminal: async () => {},
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await vi.waitFor(() => expect(rejectRead).toBeTypeOf("function"));
  processor[Symbol.dispose]();
  rejectRead(new Error("context gone"));
  await settle();
  expect(store.values.has("durable-delivery/disposed-read")).toBe(false);
  expect(scheduleWake).not.toHaveBeenCalled();
});

test("persists a pending scanned range, retries it, then halts through the terminal callback", async () => {
  const store = kv();
  const wakes: number[] = [];
  const terminal = vi.fn(async () => {});
  const source = memoryStream();
  await await source.stream.append({ type: "work" });
  const processor = new DurableDeliveryProcessor({
    slug: "delivery",
    consumes: ["work"],
    maxAttempts: 1,
    runtime: {
      storage: store,
      read: durableRead(source.stream.read, ["work"]),
      deliver: async () => {
        throw new Error("down");
      },
      deliverEphemeral: async () => {},
      scheduleWake: async (at) => {
        if (at !== null) wakes.push(at);
      },
      tryReservePendingEphemeral: testEphemeralReservation,
      terminal,
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle();
  expect(terminal).toHaveBeenCalledWith(
    expect.objectContaining({ afterOffset: 0, attempts: 1, error: "down" }),
  );
  expect(store.values.get("durable-delivery/delivery")).toMatchObject({
    halted: { after: 0, attempts: 1 },
  });
});

test("retries a persisted ordered range without another metadata read", async () => {
  const store = kv();
  const source = memoryStream();
  await source.stream.append({ type: "work" });
  const read = vi.fn(durableRead(source.stream.read, ["work"]));
  let calls = 0;
  const processor = new DurableDeliveryProcessor({
    slug: "retry-without-read",
    consumes: ["work"],
    retryDelayMs: () => 0,
    runtime: {
      storage: store,
      read,
      deliver: async () => {
        calls++;
        if (calls === 1) throw new Error("transient");
      },
      deliverEphemeral: async () => {},
      scheduleWake: async () => {},
      tryReservePendingEphemeral: testEphemeralReservation,
      terminal: async () => {},
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle();
  expect(read).toHaveBeenCalledTimes(1);
  await engine.processEventBatch([committedEvent(2, "work")], { after: 1, through: 2 });
  await settle();
  // The only second read is the caught-up check after successful delivery. The retry reused
  // offsets persisted with the range instead of rereading source metadata.
  expect(read).toHaveBeenCalledTimes(2);
  expect(store.values.get("durable-delivery/retry-without-read")).toEqual({ confirmedOffset: 1 });
});

test("a metadata read failure schedules a bounded wake without an attempt or terminal", async () => {
  const store = kv();
  const wakes: (number | null)[] = [];
  const terminal = vi.fn(async () => {});
  const processor = new DurableDeliveryProcessor({
    slug: "read-failure",
    runtime: {
      storage: store,
      read: async () => {
        throw new Error("context unavailable");
      },
      deliver: async () => {},
      deliverEphemeral: async () => {},
      scheduleWake: async (at) => void wakes.push(at),
      tryReservePendingEphemeral: testEphemeralReservation,
      terminal,
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle();
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toBeGreaterThan(Date.now());
  expect(store.values.has("durable-delivery/read-failure")).toBe(false);
  expect(terminal).not.toHaveBeenCalled();
});

test("named ephemeral events are best effort and never enter the durable cursor", async () => {
  const store = kv();
  const delivered = vi.fn(async () => {});
  const processor = new DurableDeliveryProcessor({
    slug: "delivery",
    consumes: ["poke"],
    runtime: {
      storage: store,
      read: async () => ({ offsets: [], scannedThroughOffset: 0, atHead: true }),
      deliver: delivered,
      deliverEphemeral: delivered,
      scheduleWake: async () => {},
      tryReservePendingEphemeral: testEphemeralReservation,
      terminal: async () => {},
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([{ ...committedEvent(7, "poke"), ephemeral: true }], {
    after: 6,
    through: 7,
  });
  await settle();
  expect(delivered).toHaveBeenCalledWith(
    expect.objectContaining({ event: expect.objectContaining({ offset: 7 }) }),
  );
  expect(store.values.has("durable-delivery/delivery")).toBe(false);
});

test("fan-out persists bounded offsets then calls each event independently", async () => {
  const store = kv();
  const source = memoryStream();
  await source.stream.append({ type: "work" }, { type: "work" }, { type: "work" });
  let active = 0;
  let high = 0;
  const delivered: number[] = [];
  const processor = new DurableDeliveryProcessor({
    slug: "fan",
    consumes: ["work"],
    fanOut: true,
    concurrency: 2,
    runtime: {
      storage: store,
      read: durableRead(source.stream.read, ["work"]),
      deliver: async ({ offsets }) => {
        active++;
        high = Math.max(high, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        delivered.push(offsets[0]!);
        active--;
      },
      deliverEphemeral: async () => {},
      scheduleWake: async () => {},
      tryReservePendingEphemeral: testEphemeralReservation,
      terminal: async () => {},
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle(40);
  expect(delivered.sort()).toEqual([1, 2, 3]);
  expect(high).toBe(2);
  expect(store.values.get("durable-delivery/fan")).toMatchObject({
    fanOut: { admittedThrough: 3, pending: [] },
  });
});

test("fan-out continues from a non-head metadata page without another push", async () => {
  const store = kv();
  const source = memoryStream();
  await source.stream.append(...Array.from({ length: 101 }, () => ({ type: "work" })));
  const delivered: number[] = [];
  const processor = new DurableDeliveryProcessor({
    slug: "fan-catch-up",
    consumes: ["work"],
    fanOut: true,
    concurrency: 100,
    maxPending: 100,
    runtime: {
      storage: store,
      read: durableRead(source.stream.read, ["work"]),
      deliver: async ({ offsets }) => void delivered.push(offsets[0]!),
      deliverEphemeral: async () => {},
      scheduleWake: async () => {},
      tryReservePendingEphemeral: testEphemeralReservation,
      terminal: async () => {},
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle(100);
  expect(delivered).toHaveLength(101);
  expect(store.values.get("durable-delivery/fan-catch-up")).toMatchObject({
    fanOut: { admittedThrough: 101, pending: [] },
  });
});

test("ordered ephemerals queue bounded one-offset pushes while fan-out excludes them", async () => {
  const store = kv();
  const ordered = vi.fn(async () => {});
  const runtime = {
    storage: store,
    read: async () => ({ offsets: [], scannedThroughOffset: 0, atHead: true }),
    deliver: ordered,
    deliverEphemeral: ordered,
    scheduleWake: async () => {},
    tryReservePendingEphemeral: testEphemeralReservation,
    terminal: async () => {},
  };
  const processor = new DurableDeliveryProcessor({
    slug: "ordered-ephemerals",
    consumes: ["poke"],
    runtime,
  });
  const engine = driver(processor);
  await engine.processEventBatch(
    [
      { ...committedEvent(1, "poke"), ephemeral: true },
      { ...committedEvent(2, "poke"), ephemeral: true },
    ],
    { after: 0, through: 2 },
  );
  await settle();
  expect(ordered).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      event: expect.objectContaining({ offset: 1 }),
    }),
  );
  expect(ordered).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      event: expect.objectContaining({ offset: 2 }),
    }),
  );

  const fanOutDeliver = vi.fn(async () => {});
  const fanOut = new DurableDeliveryProcessor({
    slug: "fan-ephemerals",
    consumes: ["poke"],
    fanOut: true,
    runtime: { ...runtime, deliver: fanOutDeliver },
  });
  const fanEngine = driver(fanOut);
  await fanEngine.processEventBatch([{ ...committedEvent(3, "poke"), ephemeral: true }], {
    after: 2,
    through: 3,
  });
  await settle();
  expect(fanOutDeliver).not.toHaveBeenCalled();
});

test("ordered ephemerals share the persisted delivery chain", async () => {
  const store = kv();
  const source = memoryStream();
  await source.stream.append({ type: "work" });
  let releaseEphemeral!: () => void;
  const deliver = vi.fn(async () => {});
  const deliverEphemeral = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        releaseEphemeral = resolve;
      }),
  );
  const processor = new DurableDeliveryProcessor({
    slug: "ordered-chain",
    consumes: ["poke", "work"],
    runtime: {
      storage: store,
      read: durableRead(source.stream.read, ["work"]),
      deliver,
      deliverEphemeral,
      scheduleWake: async () => {},
      tryReservePendingEphemeral: testEphemeralReservation,
      terminal: async () => {},
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([{ ...committedEvent(2, "poke"), ephemeral: true }], {
    after: 1,
    through: 2,
  });
  await settle();
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle();
  expect(deliverEphemeral).toHaveBeenCalledTimes(1);
  releaseEphemeral();
  await settle();
  expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ offsets: [1] }));
});

test("deliveryBusy reschedules ordered work without spending an attempt", async () => {
  const store = kv();
  const source = memoryStream();
  await source.stream.append({ type: "work" });
  const wakes: number[] = [];
  const terminal = vi.fn(async () => {});
  const processor = new DurableDeliveryProcessor({
    slug: "busy",
    consumes: ["work"],
    maxAttempts: 1,
    runtime: {
      storage: store,
      read: durableRead(source.stream.read, ["work"]),
      deliver: async () => {
        throw codedError("UNAVAILABLE", "busy", { deliveryBusy: true });
      },
      deliverEphemeral: async () => {},
      scheduleWake: async (at) => {
        if (at !== null) wakes.push(at);
      },
      tryReservePendingEphemeral: testEphemeralReservation,
      terminal,
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle();
  expect(store.values.get("durable-delivery/busy")).toMatchObject({
    pending: { attempt: 0 },
  });
  expect(wakes).toHaveLength(1);
  expect(terminal).not.toHaveBeenCalled();
});

test("an unresolved expression retries through the configured attempt bound", async () => {
  const store = kv();
  const source = memoryStream();
  await source.stream.append({ type: "work" });
  const terminal = vi.fn(async () => {});
  const processor = new DurableDeliveryProcessor({
    slug: "target-retry",
    consumes: ["work"],
    maxAttempts: 2,
    retryDelayMs: () => 0,
    runtime: {
      storage: store,
      read: durableRead(source.stream.read, ["work"]),
      deliver: async () => {
        throw codedError("NO_ITX_EXPRESSION_MATCH", "target is not ready");
      },
      deliverEphemeral: async () => {},
      scheduleWake: async () => {},
      tryReservePendingEphemeral: testEphemeralReservation,
      terminal,
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle();
  expect(store.values.get("durable-delivery/target-retry")).toMatchObject({
    pending: { attempt: 1 },
  });
  await engine.processEventBatch([committedEvent(2, "work")], { after: 1, through: 2 });
  await settle();
  expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ attempts: 2 }));
});

test("a context resume fence does not turn a stale ordered call into a halt", async () => {
  const store = kv();
  const source = memoryStream();
  await source.stream.append({ type: "work" });
  const terminal = vi.fn(async () => {});
  const wakes: number[] = [];
  const processor = new DurableDeliveryProcessor({
    slug: "stale-resume",
    consumes: ["work"],
    maxAttempts: 1,
    runtime: {
      storage: store,
      read: durableRead(source.stream.read, ["work"]),
      deliver: async () => {
        throw codedError("GONE", "configured subscription resumed", { resumeAtOffset: 9 });
      },
      deliverEphemeral: async () => {},
      scheduleWake: async (at) => {
        if (at !== null) wakes.push(at);
      },
      tryReservePendingEphemeral: testEphemeralReservation,
      terminal,
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle();
  expect(store.values.get("durable-delivery/stale-resume")).toMatchObject({
    pending: { attempt: 0 },
  });
  expect(wakes).toHaveLength(1);
  expect(terminal).not.toHaveBeenCalled();
});

test("a context resume fence does not dead-letter stale fan-out work", async () => {
  const store = kv();
  const source = memoryStream();
  await source.stream.append({ type: "work" });
  const terminal = vi.fn(async () => {});
  const processor = new DurableDeliveryProcessor({
    slug: "fanout-stale-resume",
    consumes: ["work"],
    fanOut: true,
    maxAttempts: 1,
    runtime: {
      storage: store,
      read: durableRead(source.stream.read, ["work"]),
      deliver: async () => {
        throw codedError("GONE", "configured subscription resumed", { resumeAtOffset: 9 });
      },
      deliverEphemeral: async () => {},
      scheduleWake: async () => {},
      tryReservePendingEphemeral: testEphemeralReservation,
      terminal,
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle();
  expect(store.values.get("durable-delivery/fanout-stale-resume")).toMatchObject({
    fanOut: { pending: [{ offset: 1, attempt: 0 }] },
  });
  expect(terminal).not.toHaveBeenCalled();
});

test("deliveryBusy reschedules fan-out work without spending an attempt", async () => {
  const store = kv();
  const source = memoryStream();
  await source.stream.append({ type: "work" });
  const wakes: number[] = [];
  const terminal = vi.fn(async () => {});
  const processor = new DurableDeliveryProcessor({
    slug: "fanout-busy",
    consumes: ["work"],
    fanOut: true,
    maxAttempts: 1,
    runtime: {
      storage: store,
      read: durableRead(source.stream.read, ["work"]),
      deliver: async () => {
        throw codedError("UNAVAILABLE", "busy", { deliveryBusy: true });
      },
      deliverEphemeral: async () => {},
      scheduleWake: async (at) => {
        if (at !== null) wakes.push(at);
      },
      tryReservePendingEphemeral: testEphemeralReservation,
      terminal,
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle();
  expect(store.values.get("durable-delivery/fanout-busy")).toMatchObject({
    fanOut: { pending: [{ offset: 1, attempt: 0 }] },
  });
  expect(wakes).toHaveLength(1);
  expect(terminal).not.toHaveBeenCalled();
});

test("queued ephemeral reservations remain held through delivery and release afterward", async () => {
  const store = kv();
  let held = 0;
  let release!: () => void;
  const processor = new DurableDeliveryProcessor({
    slug: "ephemeral-lease",
    consumes: ["poke"],
    runtime: {
      storage: store,
      read: async () => ({ offsets: [], scannedThroughOffset: 0, atHead: true }),
      deliver: async () => {},
      deliverEphemeral: async () => await new Promise<void>((resolve) => (release = resolve)),
      scheduleWake: async () => {},
      tryReservePendingEphemeral: (chars) => {
        held += chars;
        let disposed = false;
        return {
          [Symbol.dispose]: () => {
            if (!disposed) held -= chars;
            disposed = true;
          },
        };
      },
      terminal: async () => {},
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([{ ...committedEvent(1, "poke"), ephemeral: true }], {
    after: 0,
    through: 1,
  });
  await settle();
  expect(held).toBeGreaterThan(0);
  release();
  await settle();
  expect(held).toBe(0);
});

const testEphemeralReservation = (): Disposable => ({ [Symbol.dispose]: () => {} });

/** The subscriptions facet feeds pushes directly into the private runner. */
const driver = (runner: DurableDeliveryProcessor) => ({
  processEventBatch: async (events: StreamEvent[], _range?: unknown) => {
    for (const event of events) runner.push(event);
    runner.drive((work) => void work());
  },
});

const durableRead =
  (
    read: (
      after: number,
      limit: number,
    ) => Promise<{
      events: StreamEvent[];
      scannedThroughOffset: number;
      atHead: boolean;
    }>,
    consumes: readonly string[],
  ) =>
  async (after: number, limit: number) => {
    const page = await read(after, limit);
    return {
      offsets: page.events
        .filter((event) => !event.ephemeral && consumes.includes(event.type))
        .map((event) => event.offset),
      scannedThroughOffset: page.scannedThroughOffset,
      atHead: page.atHead,
    };
  };

const kv = (): EngineKv & { values: Map<string, unknown> } => {
  const values = new Map<string, unknown>();
  return {
    values,
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key, value) => values.set(key, structuredClone(value)),
    delete: (key) => values.delete(key),
  };
};
