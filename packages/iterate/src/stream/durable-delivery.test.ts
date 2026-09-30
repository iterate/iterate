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
  // One pass admits and delivers one source page. The alarm owns the next head check.
  expect(read).toHaveBeenCalledTimes(1);
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
      terminal: async () => {},
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle();
  expect(read).toHaveBeenCalledTimes(1);
  await engine.processEventBatch([committedEvent(2, "work")], { after: 1, through: 2 });
  await settle();
  // The retry reuses its persisted range; its next head check belongs to the alarm pass.
  expect(read).toHaveBeenCalledTimes(1);
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

test("an unexpected fan-out cursor write retains a bounded recovery wake", async () => {
  const values = new Map<string, unknown>();
  let puts = 0;
  const storage: EngineKv = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key, value) => {
      if (++puts === 3) throw new Error("outcome write failed");
      values.set(key, structuredClone(value));
    },
    delete: (key) => values.delete(key),
  };
  const wakes: number[] = [];
  const processor = new DurableDeliveryProcessor({
    slug: "fanout-cursor-write-failure",
    consumes: ["work"],
    fanOut: true,
    runtime: {
      storage,
      read: async () => ({ offsets: [1], scannedThroughOffset: 1, atHead: true }),
      deliver: async () => {},
      deliverEphemeral: async () => {},
      scheduleWake: async (at) => {
        if (at !== null) wakes.push(at);
      },
      terminal: async () => {},
    },
  });
  processor.drive((work) => void work().catch(() => {}));
  await vi.waitFor(() => expect(wakes).toHaveLength(1));
  expect(wakes[0]).toBeGreaterThan(Date.now());
  expect(puts).toBe(3);
});

test("a persisted delivery error is capped at 1 KiB", async () => {
  const store = kv();
  const source = memoryStream();
  await source.stream.append({ type: "work" });
  const processor = new DurableDeliveryProcessor({
    slug: "bounded-error",
    consumes: ["work"],
    maxAttempts: 1,
    runtime: {
      storage: store,
      read: durableRead(source.stream.read, ["work"]),
      deliver: async () => {
        throw new Error("x".repeat(10_240));
      },
      deliverEphemeral: async () => {},
      scheduleWake: async () => {},
      terminal: async () => {},
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await vi.waitFor(() => expect(processor.snapshot().halted).toBeDefined());
  expect(processor.snapshot().halted?.error).toHaveLength(1_024);
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
      terminal: async () => {},
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([{ ...committedEvent(7, "poke"), ephemeral: true }], {
    after: 6,
    through: 7,
  });
  await settle();
  expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ offset: 7, type: "poke" }));
  expect(store.values.has("durable-delivery/delivery")).toBe(false);
});

test("an ephemeral-only gap does not write a cursor before the following durable admission", async () => {
  const values = new Map<string, unknown>();
  const writes: unknown[] = [];
  const storage: EngineKv = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key: string, value) => {
      writes.push(structuredClone(value));
      values.set(key, structuredClone(value));
    },
    delete: (key) => values.delete(key),
  };
  const delivered: string[] = [];
  const processor = new DurableDeliveryProcessor({
    slug: "ephemeral-gap",
    consumes: ["poke", "work"],
    afterOffset: 10,
    runtime: {
      storage,
      read: async () => ({ offsets: [14], scannedThroughOffset: 14, atHead: true }),
      deliver: async ({ offsets }) => void delivered.push(`D${offsets[0]}`),
      deliverEphemeral: async ({ offset }) => void delivered.push(`E${offset}`),
      scheduleWake: async () => {},
      terminal: async () => {},
    },
  });
  for (const offset of [11, 12, 13])
    processor.push({ ...committedEvent(offset, "poke"), ephemeral: true });
  processor.drive((work) => void work());
  await vi.waitFor(() => expect(delivered).toEqual(["E11", "E12", "E13", "D14"]));
  expect(writes).toHaveLength(3);
  expect(writes).not.toContainEqual(expect.objectContaining({ confirmedOffset: 11 }));
  expect(writes).not.toContainEqual(expect.objectContaining({ confirmedOffset: 12 }));
  expect(writes).not.toContainEqual(expect.objectContaining({ confirmedOffset: 13 }));
});
test("fan-out persists bounded offsets then calls each event independently", async () => {
  const store = kv();
  const source = memoryStream();
  await source.stream.append(...Array.from({ length: 16 }, () => ({ type: "work" })));
  let active = 0;
  let high = 0;
  const delivered: number[] = [];
  const processor = new DurableDeliveryProcessor({
    slug: "fan",
    consumes: ["work"],
    fanOut: true,
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
      terminal: async () => {},
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle(40);
  await engine.processEventBatch([], { after: 16, through: 16 });
  await settle(40);
  expect(delivered.sort((a, b) => a - b)).toEqual(
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
  expect(high).toBe(8);
  expect(store.values.get("durable-delivery/fan")).not.toHaveProperty("fanOut");
});

test("a 128-call fan-out takes two one-page alarm passes", async () => {
  const store = kv();
  const source = memoryStream();
  await source.stream.append(...Array.from({ length: 128 }, () => ({ type: "work" })));
  const delivered: number[] = [];
  const wakes: (number | null)[] = [];
  const processor = new DurableDeliveryProcessor({
    slug: "fan-catch-up",
    consumes: ["work"],
    fanOut: true,
    runtime: {
      storage: store,
      read: durableRead(source.stream.read, ["work"]),
      deliver: async ({ offsets }) => void delivered.push(offsets[0]!),
      deliverEphemeral: async () => {},
      scheduleWake: async (at) => void wakes.push(at),
      terminal: async () => {},
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle(100);
  expect(delivered).toHaveLength(100);
  expect(wakes.at(-1)).not.toBeNull();
  await engine.processEventBatch([], { after: 100, through: 100 });
  await settle(100);
  expect(store.values.get("durable-delivery/fan-catch-up")).not.toHaveProperty("fanOut");
  expect(delivered).toHaveLength(128);
  expect(wakes.at(-1)).toBeNull();
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
  expect(ordered).toHaveBeenNthCalledWith(1, expect.objectContaining({ offset: 1, type: "poke" }));
  expect(ordered).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 2, type: "poke" }));

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
      terminal,
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle();
  expect(store.values.get("durable-delivery/fanout-stale-resume")).toMatchObject({
    fanOut: [{ offset: 1, attempt: 0 }],
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
      terminal,
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle();
  expect(store.values.get("durable-delivery/fanout-busy")).toMatchObject({
    fanOut: [{ offset: 1, attempt: 0 }],
  });
  expect(wakes).toHaveLength(1);
  expect(terminal).not.toHaveBeenCalled();
});

test("queued ephemeral delivery retains only an offset and type", async () => {
  const store = kv();
  const delivered = vi.fn(async () => {});
  const processor = new DurableDeliveryProcessor({
    slug: "ephemeral-offset",
    consumes: ["poke"],
    runtime: {
      storage: store,
      read: async () => ({ offsets: [], scannedThroughOffset: 0, atHead: true }),
      deliver: async () => {},
      deliverEphemeral: delivered,
      scheduleWake: async () => {},
      terminal: async () => {},
    },
  });
  const engine = driver(processor);
  await engine.processEventBatch(
    [{ ...committedEvent(1, "poke"), ephemeral: true, payload: { large: "x".repeat(10_240) } }],
    { after: 0, through: 1 },
  );
  await settle();
  expect(delivered).toHaveBeenCalledWith({ offset: 1, type: "poke", resumeAtOffset: undefined });
  expect(processor.snapshot()).toEqual({ confirmedOffset: 0 });
});

test("an evicted ephemeral is observable best-effort loss and does not move the durable cursor", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const store = kv();
    const delivered = vi.fn(async () => {
      throw codedError("GONE", "ephemeral no longer in ring");
    });
    const processor = new DurableDeliveryProcessor({
      slug: "evicted-ephemeral",
      consumes: ["poke"],
      runtime: {
        storage: store,
        read: async () => ({ offsets: [], scannedThroughOffset: 0, atHead: true }),
        deliver: async () => {},
        deliverEphemeral: delivered,
        scheduleWake: async () => {},
        terminal: async () => {},
      },
    });
    processor.push({ ...committedEvent(1, "poke"), ephemeral: true });
    processor.drive((work) => void work());
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
    expect(processor.snapshot()).toEqual({ confirmedOffset: 0 });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "durable-delivery.ephemeral-failed", offset: 1 }),
    );
  } finally {
    warn.mockRestore();
  }
});

test("the ephemeral descriptor queue keeps its newest bounded page and reports dropped offsets", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const delivered: number[] = [];
    const processor = new DurableDeliveryProcessor({
      slug: "ephemeral-count",
      consumes: ["poke"],
      runtime: {
        storage: kv(),
        read: async () => ({ offsets: [], scannedThroughOffset: 0, atHead: true }),
        deliver: async () => {},
        deliverEphemeral: async ({ offset }) => void delivered.push(offset),
        scheduleWake: async () => {},
        terminal: async () => {},
      },
    });
    for (let offset = 1; offset <= 101; offset++)
      processor.push({ ...committedEvent(offset, "poke"), ephemeral: true });
    processor.drive((work) => void work());
    await vi.waitFor(() => expect(delivered).toHaveLength(100));
    expect(delivered).toEqual(Array.from({ length: 100 }, (_, index) => index + 2));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "durable-delivery.ephemeral-dropped", offset: 1 }),
    );
  } finally {
    warn.mockRestore();
  }
});

test("an ephemeral overtaken by an admitted durable range is dropped without rolling that range back", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const store = kv();
    store.put("durable-delivery/overtaken", {
      confirmedOffset: 9,
      pending: { after: 9, through: 12, offsets: [10, 12], attempt: 0 },
    });
    const deliverEphemeral = vi.fn(async () => {});
    const processor = new DurableDeliveryProcessor({
      slug: "overtaken",
      consumes: ["poke"],
      runtime: {
        storage: store,
        read: async () => ({ offsets: [], scannedThroughOffset: 12, atHead: true }),
        deliver: async () => {},
        deliverEphemeral,
        scheduleWake: async () => {},
        terminal: async () => {},
      },
    });
    processor.push({ ...committedEvent(11, "poke"), ephemeral: true });
    expect(processor.snapshot()).toMatchObject({ pending: { after: 9, through: 12 } });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "durable-delivery.ephemeral-overtaken", offset: 11 }),
    );
    processor.drive((work) => void work());
    await settle();
    expect(deliverEphemeral).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

/** The context feeds pushes directly into the private runner. */
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
