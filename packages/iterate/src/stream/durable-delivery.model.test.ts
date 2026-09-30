import { expect, test, vi } from "vitest";
import { codedError } from "../lib.ts";
import { DurableDeliveryProcessor } from "./durable-delivery.ts";
import { type EngineKv } from "./processor.ts";
import { committedEvent, memoryStream, settle } from "./test-support.ts";

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
  const second = runtime(shared, source.stream.read, ({ offsets }) => void replayed.push(offsets));
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

test.each([false, true])(
  "interrupted delivery stops at its persisted attempt limit (fan-out=%s)",
  async (fanOut) => {
    const source = memoryStream();
    await source.stream.append({ type: "work" });
    const shared = kv();
    shared.put("durable-delivery/interrupted", {
      confirmedOffset: 0,
      ...(fanOut
        ? { fanOut: { admittedThrough: 1, pending: [{ offset: 1, attempt: 2 }] } }
        : { pending: { after: 0, through: 1, offsets: [1], attempt: 2 } }),
    });
    const invoke = vi.fn();
    const host = runtime(shared, source.stream.read, invoke);
    const processor = new DurableDeliveryProcessor({
      slug: "interrupted",
      consumes: ["work"],
      fanOut,
      maxAttempts: 2,
      runtime: host,
    });
    await drive(processor, 1);
    await settle(50);
    expect(invoke).not.toHaveBeenCalled();
    expect(host.terminals).toEqual([
      expect.objectContaining({
        attempts: 2,
        error: "delivery did not settle before its host restarted",
      }),
    ]);
  },
);

test("omitting consumes delivers every durable event", async () => {
  const source = memoryStream();
  await source.stream.append({ type: "alpha" }, { type: "beta" });
  const received: number[] = [];
  const processor = new DurableDeliveryProcessor({
    slug: "all",
    runtime: runtime(kv(), source.stream.read, ({ offsets }) => void received.push(...offsets)),
  });
  await drive(processor, 1);
  await settle();
  expect(received).toEqual([1, 2]);
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
    ({ offsets }) => void replayed.push(offsets[0]!),
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

test("the D10, E11, D12, E13, D14 model preserves the ephemeral position without persisting its body", async () => {
  const storage = kv();
  const delivered: string[] = [];
  const processor = new DurableDeliveryProcessor({
    slug: "D10-E11-D12",
    consumes: ["work", "poke"],
    afterOffset: 9,
    runtime: {
      storage,
      read: async (after) =>
        after < 10
          ? { offsets: [10, 12, 14], scannedThroughOffset: 14, atHead: true }
          : after < 12
            ? { offsets: [12, 14], scannedThroughOffset: 14, atHead: true }
            : after < 14
              ? { offsets: [14], scannedThroughOffset: 14, atHead: true }
              : { offsets: [], scannedThroughOffset: 14, atHead: true },
      deliver: async ({ offsets }) => void delivered.push(`D${offsets.join(",")}`),
      deliverEphemeral: async ({ offset }) => void delivered.push(`E${offset}`),
      scheduleWake: async () => {},
      terminal: async () => {},
    },
  });
  processor.push({ ...committedEvent(11, "poke"), ephemeral: true });
  processor.push({ ...committedEvent(13, "poke"), ephemeral: true });
  processor.drive((work) => void work());
  await vi.waitFor(() => expect(delivered).toEqual(["D10", "E11", "D12", "E13", "D14"]));
  expect(JSON.stringify(processor.snapshot())).not.toContain("poke");
});
test("a fan-out backoff still admits the following source page", async () => {
  const source = memoryStream();
  await source.stream.append(...Array.from({ length: 101 }, () => ({ type: "work" })));
  const shared = kv();
  const delivered: number[] = [];
  const delayed = runtime(shared, source.stream.read, ({ offsets }) => {
    if (offsets[0] === 1) throw new Error("first event retries later");
    delivered.push(offsets[0]!);
  });
  const processor = new DurableDeliveryProcessor({
    slug: "fan-backoff",
    consumes: ["work"],
    fanOut: true,
    concurrency: 100,
    retryDelayMs: () => 60_000,
    runtime: delayed,
  });
  await drive(processor, 1);
  await settle(100);
  expect(delivered).toHaveLength(99);
  await drive(processor, 2);
  await settle(100);
  expect(delivered).toHaveLength(100);
  expect(processor.snapshot()).toMatchObject({
    fanOut: { admittedThrough: 101, pending: [{ offset: 1, attempt: 1 }] },
  });
});

test("a fan-out terminal is selectively resumed without replaying already acknowledged offsets", async () => {
  const source = memoryStream();
  await source.stream.append({ type: "work" }, { type: "work" });
  const shared = kv();
  const terminal = runtime(shared, source.stream.read, ({ offsets }) => {
    if (offsets[0] === 1) throw new Error("only first fails");
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
  await drive(processor, 2);
  await settle();
  expect(terminal).toMatchObject({
    terminals: [{ afterOffset: 0, attempts: 1, error: "only first fails", fanOut: true }],
  });
  const replayed: number[] = [];
  terminal.deliver = async ({ offsets }) => void replayed.push(offsets[0]!);
  expect(processor.resume(undefined, 1, 101)).toBe(true);
  await drive(processor, 2);
  await settle();
  expect(replayed).toEqual([1]);
});

test("a fan-out target 410 halts the row and a resume retries its admitted offsets", async () => {
  const source = memoryStream();
  await source.stream.append({ type: "work" });
  const shared = kv();
  const failed = runtime(shared, source.stream.read, () => {
    throw codedError("GONE", "receiver returned 410");
  });
  const processor = fanOut(failed);
  await drive(processor, 1);
  await settle();
  expect(failed).toMatchObject({
    terminals: [expect.objectContaining({ afterOffset: 1, attempts: 1 })],
  });
  expect(failed.terminals[0]?.fanOut).toBeUndefined();
  expect(processor.snapshot()).toMatchObject({
    halted: { after: 1, attempts: 1 },
    fanOut: { admittedThrough: 1, pending: [{ offset: 1, attempt: 1 }] },
  });

  const replayed: number[] = [];
  failed.deliver = async ({ offsets }) => void replayed.push(offsets[0]!);
  expect(processor.resume(undefined, undefined, 77)).toBe(true);
  await drive(processor, 2);
  await settle();
  expect(replayed).toEqual([1]);
  expect(processor.snapshot()).toMatchObject({
    fanOut: { admittedThrough: 1, pending: [] },
  });
  expect(processor.snapshot().halted).toBeUndefined();
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
  failed.deliver = async ({ offsets }) => void replayed.push(...offsets);
  expect(processor.resume()).toBe(true);
  await drive(processor, 2);
  await settle();
  expect(replayed).toEqual([1]);
  expect(processor.snapshot()).toEqual({ confirmedOffset: 1 });
});

test("a long failed delivery message stays bounded through retry and halt", async () => {
  const source = memoryStream();
  await source.stream.append({ type: "work" });
  const message = "x".repeat(10_240);
  const failed = runtime(kv(), source.stream.read, () => {
    throw new Error(message);
  });
  const processor = ordered(failed, { maxAttempts: 2, retryDelayMs: () => 0 });
  await drive(processor, 1);
  await settle();
  expect(processor.snapshot()).toMatchObject({
    pending: { attempt: 1, error: "x".repeat(1024) },
  });

  await drive(processor, 2);
  await settle();
  expect(processor.snapshot()).toMatchObject({
    halted: { attempts: 2, error: "x".repeat(1024) },
  });
  expect(failed).toMatchObject({
    terminals: [expect.objectContaining({ error: "x".repeat(1024) })],
  });
});

test("a resume seek replaces an in-flight ordered range", async () => {
  const source = memoryStream();
  await source.stream.append({ type: "work" }, { type: "work" });
  const shared = kv();
  let releaseFirst!: () => void;
  let first = true;
  const delivered: number[][] = [];
  const delayed = runtime(shared, source.stream.read, async ({ offsets }) => {
    if (first) {
      first = false;
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      return;
    }
    delivered.push(offsets);
  });
  const processor = ordered(delayed);
  await drive(processor, 1);
  await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
  expect(processor.resume(1, undefined, 99)).toBe(true);
  releaseFirst();
  await settle();
  expect(processor.snapshot()).toEqual({ confirmedOffset: 1 });

  await drive(processor, 2);
  await settle();
  expect(delivered).toEqual([[2]]);
});

test("a fan-out resume can recreate an offset before it has admitted a page", () => {
  const processor = fanOut(runtime(kv(), memoryStream().stream.read, () => {}));
  expect(processor.resume(3, 4, 99)).toBe(true);
  expect(processor.snapshot()).toMatchObject({
    fanOut: { admittedThrough: 3, pending: [{ offset: 4, attempt: 0, resumeAtOffset: 99 }] },
  });
});

test("a running ordered row adopts a plain resume fence before its next read", async () => {
  const source = memoryStream();
  await source.stream.append({ type: "work" });
  const calls: number[] = [];
  const processor = ordered(
    runtime(kv(), source.stream.read, ({ offsets }) => void calls.push(...offsets)),
  );
  expect(processor.resume(undefined, undefined, 9)).toBe(true);
  await drive(processor, 1);
  await settle();
  expect(calls).toEqual([1]);
  expect(processor.snapshot()).toEqual({ confirmedOffset: 1 });
});

test("a fan-out seek replaces admitted work and re-reads from its requested offset", async () => {
  const source = memoryStream();
  await source.stream.append({ type: "work" }, { type: "work" });
  const calls: { offsets: number[]; resumeAtOffset?: number }[] = [];
  const processor = fanOut(
    runtime(kv(), source.stream.read, ({ offsets, resumeAtOffset }) => {
      calls.push({ offsets, resumeAtOffset });
    }),
  );
  await drive(processor, 1);
  await settle();
  expect(calls.map(({ offsets }) => offsets[0])).toEqual([1, 2]);

  expect(processor.resume(0, undefined, 10)).toBe(true);
  await drive(processor, 2);
  await settle();
  expect(calls.slice(2)).toEqual([
    { offsets: [1], resumeAtOffset: 10 },
    { offsets: [2], resumeAtOffset: 10 },
  ]);
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
    ({ offsets }) => void replacementCalls.push(...offsets),
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
      const current = runtime(shared, source.stream.read, ({ offsets }) => {
        calls++;
        if ((seed + generation + calls) % 5 === 0) throw new Error("transient");
        delivered.push(...offsets);
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
  processor.push(committedEvent(offset, "work"));
  processor.drive((work) => void work());
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
    read: async (after: number, limit: number) => {
      const page = await read(after, limit);
      return {
        offsets: page.events.filter((event) => !event.ephemeral).map((event) => event.offset),
        scannedThroughOffset: page.scannedThroughOffset,
        atHead: page.atHead,
      };
    },
    deliver: async (input: Parameters<RuntimeDeliver>[0]) => await deliver(input),
    deliverEphemeral: async () => {},
    scheduleWake: async () => {},
    terminal: async (input: Terminal) => {
      terminals.push(input);
      await terminal(input);
    },
    terminals,
  };
}
type RuntimeDeliver = (input: {
  offsets: number[];
  resumeAtOffset?: number;
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
