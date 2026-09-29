import { expect, test, vi } from "vitest";
import { DurableDeliveryProcessor } from "./durable-delivery.ts";
import { ProcessorEngine, type EngineKv } from "./processor.ts";
import { committedEvent, memoryStorage, memoryStream, settle } from "./test-support.ts";

test("reads a bounded source page again and invokes it with its scanned proof", async () => {
  const store = kv();
  const source = memoryStream();
  const delivered = vi.fn(async () => {});
  await source.stream.append({ type: "work" }, { type: "noise" }, { type: "work" });
  const processor = new DurableDeliveryProcessor({
    slug: "delivery",
    target: ["itx", "target"],
    consumes: ["work"],
    wakeEventType: "iterate.dev/wake",
    runtime: {
      storage: store,
      read: source.stream.read,
      deliver: delivered,
      scheduleWake: async () => {},
      terminal: async () => {},
    },
  });
  const engine = new ProcessorEngine(processor, {
    stream: memoryStream().stream,
    storage: memoryStorage(),
    kv: kv(),
  });
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle();
  expect(delivered).toHaveBeenCalledWith(
    expect.objectContaining({
      events: [
        expect.objectContaining({ type: "work", offset: 1 }),
        expect.objectContaining({ type: "work", offset: 3 }),
      ],
      range: { after: 0, through: 3 },
    }),
  );
  expect(store.values.get("durable-delivery/delivery")).toEqual({ confirmedOffset: 3 });
});

test("persists a pending scanned range, retries it, then halts through the terminal callback", async () => {
  const store = kv();
  const wakes: number[] = [];
  const terminal = vi.fn(async () => {});
  const source = memoryStream();
  await await source.stream.append({ type: "work" });
  const processor = new DurableDeliveryProcessor({
    slug: "delivery",
    target: "itx.target",
    consumes: ["work"],
    wakeEventType: "iterate.dev/wake",
    maxAttempts: 1,
    runtime: {
      storage: store,
      read: source.stream.read,
      deliver: async () => {
        throw new Error("down");
      },
      scheduleWake: async (at) => void wakes.push(at),
      terminal,
    },
  });
  const engine = new ProcessorEngine(processor, {
    stream: memoryStream().stream,
    storage: memoryStorage(),
    kv: kv(),
  });
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle();
  expect(terminal).toHaveBeenCalledWith({ afterOffset: 0, attempts: 1, error: "down" });
  expect(store.values.get("durable-delivery/delivery")).toMatchObject({
    halted: { after: 0, attempts: 1 },
  });
});

test("named ephemeral events are best effort and never enter the durable cursor", async () => {
  const store = kv();
  const delivered = vi.fn(async () => {});
  const processor = new DurableDeliveryProcessor({
    slug: "delivery",
    target: "itx.target",
    consumes: ["poke"],
    wakeEventType: "iterate.dev/wake",
    runtime: {
      storage: store,
      read: async () => ({ events: [], scannedThroughOffset: 0, atHead: true }),
      deliver: delivered,
      scheduleWake: async () => {},
      terminal: async () => {},
    },
  });
  const engine = new ProcessorEngine(processor, {
    stream: memoryStream().stream,
    storage: memoryStorage(),
    kv: kv(),
  });
  await engine.processEventBatch([{ ...committedEvent(7, "poke"), ephemeral: true }], {
    after: 6,
    through: 7,
  });
  await settle();
  expect(delivered).toHaveBeenCalledWith(
    expect.objectContaining({ events: [expect.objectContaining({ offset: 7 })] }),
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
    target: "itx.target",
    consumes: ["work"],
    wakeEventType: "iterate.dev/wake",
    fanOut: true,
    concurrency: 2,
    runtime: {
      storage: store,
      read: source.stream.read,
      deliver: async ({ events }) => {
        active++;
        high = Math.max(high, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        delivered.push(events[0]!.offset);
        active--;
      },
      scheduleWake: async () => {},
      terminal: async () => {},
    },
  });
  const engine = new ProcessorEngine(processor, {
    stream: memoryStream().stream,
    storage: memoryStorage(),
    kv: kv(),
  });
  await engine.processEventBatch([committedEvent(1, "work")], { after: 0, through: 1 });
  await settle(40);
  expect(delivered.sort()).toEqual([1, 2, 3]);
  expect(high).toBe(2);
  expect(store.values.get("durable-delivery/fan")).toMatchObject({
    fanOut: { admittedThrough: 3, pending: [] },
  });
});

const kv = (): EngineKv & { values: Map<string, unknown> } => {
  const values = new Map<string, unknown>();
  return {
    values,
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key, value) => values.set(key, structuredClone(value)),
    delete: (key) => values.delete(key),
  };
};
