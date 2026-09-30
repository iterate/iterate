import { expect, test, vi } from "vitest";
import { DurableDeliveryProcessor } from "./durable-delivery.ts";
import { ProcessorEngine, type EngineKv } from "./processor.ts";
import { committedEvent, memoryStorage, memoryStream, settle } from "./test-support.ts";

type Runtime = ReturnType<typeof runtime>;

test("an ordered runner replays its persisted pending range after interruption and advances in source order", async () => {
  const source = memoryStream();
  await source.stream.append(
    { type: "work", payload: { n: 1 } },
    { type: "work", payload: { n: 2 } },
  );
  const shared = kv();
  let releaseFirst!: () => void;
  const first = runtime(
    shared,
    source.stream.read,
    () => new Promise<void>((resolve) => (releaseFirst = resolve)),
  );
  await drive(ordered(first), 1);
  await settle();
  expect(shared.values.get("durable-delivery/orders")).toMatchObject({
    pending: { after: 0, through: 2 },
  });

  const replayed: number[][] = [];
  const second = runtime(
    shared,
    source.stream.read,
    ({ events }) => void replayed.push(events.map((event) => event.offset)),
  );
  vi.useFakeTimers({ now: Date.now() + 20_001, toFake: ["Date"] });
  try {
    await drive(ordered(second), 2);
    await settle();
  } finally {
    vi.useRealTimers();
  }
  expect(replayed).toEqual([[1, 2]]);
  expect(shared.values.get("durable-delivery/orders")).toEqual({ confirmedOffset: 2 });
  releaseFirst();
});

test("omitting consumes keeps the normal subscription default: every durable event", async () => {
  const source = memoryStream();
  await source.stream.append({ type: "alpha" }, { type: "beta" });
  const received: string[] = [];
  const processor = new DurableDeliveryProcessor({
    slug: "all",
    runtime: runtime(
      kv(),
      source.stream.read,
      ({ events }) => void received.push(...events.map((event) => event.type)),
    ),
  });
  await drive(processor, 1);
  await settle();
  expect(received).toEqual(["alpha", "beta"]);
  expect(processor.contract).toMatchObject({ consumes: ["*"] });
});

test("fan-out recovery replays only pending source offsets after interruption", async () => {
  const source = memoryStream();
  await source.stream.append({ type: "work" }, { type: "work" }, { type: "work" });
  const shared = kv();
  const blocked = runtime(shared, source.stream.read, () => new Promise<void>(() => {}));
  await drive(fanOut(blocked), 1);
  await settle();
  expect(shared.values.get("durable-delivery/fan")).toMatchObject({
    fanOut: { admittedThrough: 3, pending: [{ offset: 1 }, { offset: 2 }, { offset: 3 }] },
  });

  const replayed: number[] = [];
  const recovered = runtime(
    shared,
    source.stream.read,
    ({ events }) => void replayed.push(events[0]!.offset),
  );
  vi.useFakeTimers({ now: Date.now() + 20_001, toFake: ["Date"] });
  try {
    await drive(fanOut(recovered), 2);
    await settle(100);
  } finally {
    vi.useRealTimers();
  }
  expect(replayed.sort()).toEqual([1, 2, 3]);
  expect(shared.values.get("durable-delivery/fan")).toMatchObject({
    fanOut: { admittedThrough: 3, pending: [] },
  });
});

test("a fan-out terminal is selectively resumed without replaying already acknowledged offsets", async () => {
  const source = memoryStream();
  await source.stream.append({ type: "work" }, { type: "work" });
  const shared = kv();
  const terminal = runtime(shared, source.stream.read, ({ events }) => {
    if (events[0]!.offset === 1) throw new Error("only first fails");
  });
  const processor = new DurableDeliveryProcessor({
    slug: "selective",
    consumes: ["work"],
    fanOut: true,
    maxAttempts: 1,
    runtime: terminal,
  });
  await drive(processor, 1);
  await settle();
  expect(terminal).toMatchObject({
    terminals: [{ afterOffset: 0, attempts: 1, error: "only first fails", fanOut: true }],
  });
  const replayed: number[] = [];
  terminal.deliver = async ({ events }) => void replayed.push(events[0]!.offset);
  expect(processor.resume(undefined, 1, 101)).toBe(true);
  await drive(processor, 2);
  await settle();
  expect(replayed).toEqual([1]);
});

test("terminal ordered work stays halted until an explicit resume, then replays from the fenced offset", async () => {
  const source = memoryStream();
  await source.stream.append({ type: "work" });
  const shared = kv();
  const failed = runtime(shared, source.stream.read, () => {
    throw new Error("down");
  });
  const processor = ordered(failed, { maxAttempts: 1 });
  await drive(processor, 1);
  await settle();
  expect(failed).toMatchObject({ terminals: [{ afterOffset: 0, attempts: 1, error: "down" }] });
  expect(processor.snapshot()).toMatchObject({ halted: { after: 0 } });

  const replayed: number[] = [];
  failed.deliver = async ({ events }) => void replayed.push(...events.map((event) => event.offset));
  expect(processor.resume()).toBe(true);
  await drive(processor, 2);
  await settle();
  expect(replayed).toEqual([1]);
  expect(processor.snapshot()).toEqual({ confirmedOffset: 1 });
});

test("a delayed ordered terminal carries the resume fence that was current when it was created", async () => {
  const source = memoryStream();
  await source.stream.append({ type: "work" });
  const shared = kv();
  let receiveTerminal!: (value: void) => void;
  const terminals: unknown[] = [];
  const delayed = runtime(
    shared,
    source.stream.read,
    () => {
      throw new Error("down");
    },
    async (input) => {
      terminals.push(input);
      await new Promise<void>((resolve) => (receiveTerminal = resolve));
    },
  );
  const processor = ordered(delayed, { maxAttempts: 1, resumeAtOffset: 7 });
  await drive(processor, 1);
  await settle();
  expect(processor.resume(undefined, undefined, 8)).toBe(true);
  receiveTerminal();
  await settle();
  expect(terminals).toEqual([expect.objectContaining({ resumeAtOffset: 7 })]);
  expect(processor.snapshot()).toEqual({ confirmedOffset: 0 });
});

test("an interrupted never-settling ordered call retains one bounded scanned range for a fresh runner", async () => {
  const source = memoryStream();
  await source.stream.append(...Array.from({ length: 250 }, () => ({ type: "work" })));
  const shared = kv();
  const blocked = runtime(shared, source.stream.read, () => new Promise<void>(() => {}));
  await drive(ordered(blocked), 1);
  await settle();
  expect(orderedSnapshot(shared)).toMatchObject({
    pending: { after: 0, through: 100, attempt: 1 },
  });
  expect(JSON.stringify(orderedSnapshot(shared))).not.toContain('"payload"');
});

test("a replacement generation has isolated progress while its predecessor still has an unsettled call", async () => {
  const source = memoryStream();
  await source.stream.append({ type: "work" });
  const shared = kv();
  let releaseOld!: () => void;
  const oldRuntime = runtime(
    shared,
    source.stream.read,
    () => new Promise<void>((resolve) => (releaseOld = resolve)),
  );
  const old = new DurableDeliveryProcessor({
    slug: "subscription@1",
    consumes: ["work"],
    runtime: oldRuntime,
  });
  await drive(old, 1);
  await settle();

  const replacementCalls: number[] = [];
  const replacementRuntime = runtime(
    shared,
    source.stream.read,
    ({ events }) => void replacementCalls.push(...events.map((event) => event.offset)),
  );
  const replacement = new DurableDeliveryProcessor({
    slug: "subscription@2",
    consumes: ["work"],
    runtime: replacementRuntime,
  });
  await drive(replacement, 2);
  await settle();
  releaseOld();
  await settle();
  expect(replacementCalls).toEqual([1]);
  expect(shared.values.get("durable-delivery/subscription@2")).toEqual({ confirmedOffset: 1 });
});

test("seeded recovery worlds preserve each ordered source prefix across retries and fresh runner instances", async () => {
  for (let seed = 1; seed <= 32; seed++) {
    const source = memoryStream();
    const eventCount = 1 + (seed % 7);
    await source.stream.append(
      ...Array.from({ length: eventCount }, (_, n) => ({ type: "work", payload: { n } })),
    );
    const shared = kv();
    const delivered: number[] = [];
    let calls = 0;
    for (let generation = 0; generation < 4; generation++) {
      const current = runtime(shared, source.stream.read, ({ events }) => {
        calls++;
        if ((seed + generation + calls) % 5 === 0) throw new Error("transient");
        delivered.push(...events.map((event) => event.offset));
      });
      await drive(ordered(current, { retryDelayMs: () => 0, maxAttempts: 8 }), generation + 1);
      await settle(25);
      if (orderedSnapshot(shared).confirmedOffset === eventCount) break;
    }
    expect(orderedSnapshot(shared), `seed ${seed}`).toMatchObject({ confirmedOffset: eventCount });
    expect(delivered.at(-1), `seed ${seed}`).toBe(eventCount);
    expect(delivered.every((offset) => offset >= 1 && offset <= eventCount)).toBe(true);
  }
});

function ordered(runtime: Runtime, overrides: Record<string, unknown> = {}) {
  return new DurableDeliveryProcessor({
    slug: "orders",
    consumes: ["work"],
    runtime,
    ...overrides,
  });
}
function fanOut(runtime: Runtime) {
  return new DurableDeliveryProcessor({
    slug: "fan",
    consumes: ["work"],
    fanOut: true,
    concurrency: 3,
    runtime,
  });
}
async function drive(processor: DurableDeliveryProcessor, offset: number) {
  const engine = new ProcessorEngine(processor, {
    stream: memoryStream().stream,
    storage: memoryStorage(),
    kv: kv(),
  });
  await engine.processEventBatch([committedEvent(offset, "work")], {
    after: offset - 1,
    through: offset,
  });
}
type RuntimeRead = (
  after: number,
  limit: number,
) => Promise<{
  events: import("./processor.ts").StreamEvent[];
  scannedThroughOffset: number;
  atHead: boolean;
}>;

function runtime(
  storage: ReturnType<typeof kv>,
  read: RuntimeRead,
  deliver: RuntimeDeliver,
  terminal: (input: Terminal) => void | Promise<void> = () => {},
) {
  const terminals: Terminal[] = [];
  return {
    storage,
    read,
    deliver: async (input: Parameters<RuntimeDeliver>[0]) => await deliver(input),
    scheduleWake: async () => {},
    abort: (reason: string): never => {
      throw new Error(reason);
    },
    tryReservePendingEphemeral: () => ({ [Symbol.dispose]: () => {} }),
    terminal: async (input: Terminal) => {
      terminals.push(input);
      await terminal(input);
    },
    terminals,
  };
}
type RuntimeDeliver = (input: {
  events: import("./processor.ts").StreamEvent[];
}) => void | Promise<void>;
type Terminal = {
  afterOffset: number;
  attempts: number;
  error: string;
  fanOut?: true;
  resumeAtOffset?: number;
};
function orderedSnapshot(storage: ReturnType<typeof kv>) {
  return storage.values.get("durable-delivery/orders") as {
    confirmedOffset?: number;
    pending?: { after: number; through: number; attempt: number };
  };
}
function kv(): EngineKv & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: <T>(key: string) => {
      const value = values.get(key);
      return value === undefined ? undefined : (structuredClone(value) as T);
    },
    put: (key, value) => values.set(key, structuredClone(value)),
    delete: (key) => values.delete(key),
  };
}
