import { expect, test, vi } from "vitest";
import { DurableSubscriptionDelivery } from "./durable-subscription-delivery.ts";

test("a cold context drives a persisted in-flight cursor from the context recovery alarm", async () => {
  const values = new Map<string, unknown>([
    [
      "durable-delivery/cold@1",
      { confirmedOffset: 1, pending: { after: 1, through: 2, offsets: [2], attempt: 0 } },
    ],
    ["durable-delivery/orphan@1", { confirmedOffset: 1 }],
  ]);
  // The helper uses only synchronous context KV operations; the fake has the same observable shape.
  const storage = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key: string, value: unknown) => values.set(key, structuredClone(value)),
    delete: (key: string) => values.delete(key),
    list: ({ prefix }: { prefix: string }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))),
  } as unknown as DurableObjectStorage["kv"];
  const deliver = vi.fn(async () => {});
  const runs: Promise<unknown>[] = [];
  const delivery = new DurableSubscriptionDelivery({
    storage,
    rows: () => [{ name: "cold", configuredAtOffset: 1, consumes: ["work"] }],
    currentHead: () => 2,
    read: () => ({ offsets: [2], scannedThroughOffset: 2, atHead: true }),
    deliver,
    deliverEphemeral: async () => {},
    terminal: async () => {},
    run: (work) => runs.push(work()),
    wakesChanged: () => {},
  });

  delivery.sync();
  expect(values.has("durable-delivery/orphan@1")).toBe(false);

  delivery.revive();
  await vi.waitFor(() => expect(runs).toHaveLength(1));
  await Promise.all(runs);
  expect(deliver).toHaveBeenCalledWith(
    expect.objectContaining({ name: "cold", configuredAtOffset: 1 }),
    expect.objectContaining({ offsets: [2], range: { after: 1, through: 2 } }),
  );
  expect(values.get("durable-delivery/cold@1")).toEqual({ confirmedOffset: 2 });
});

test("a resume beyond the durable head starts at the current tail", () => {
  const values = new Map<string, unknown>();
  // The helper uses only synchronous context KV operations; the fake has the same observable shape.
  const storage = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key: string, value: unknown) => values.set(key, structuredClone(value)),
    delete: (key: string) => values.delete(key),
    list: ({ prefix }: { prefix: string }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))),
  } as unknown as DurableObjectStorage["kv"];
  const delivery = new DurableSubscriptionDelivery({
    storage,
    rows: () => [
      {
        name: "tail",
        configuredAtOffset: 1,
        resumedAtOffset: 3,
        resumedAfterOffset: 1_008,
      },
    ],
    currentHead: () => 3,
    read: () => ({ offsets: [], scannedThroughOffset: 3, atHead: true }),
    deliver: async () => {},
    deliverEphemeral: async () => {},
    terminal: async () => {},
    run: () => {},
    wakesChanged: () => {},
  });

  delivery.sync();
  expect(delivery.snapshots()["tail@1"]).toEqual({ confirmedOffset: 3 });
});

test("a halted fan-out cursor never re-arms from its retained pending retry", () => {
  const values = new Map<string, unknown>([
    [
      "durable-delivery/fanout@1",
      {
        confirmedOffset: 1,
        fanOut: {
          admittedThrough: 2,
          pending: [{ offset: 2, attempt: 1, nextAttemptAtMs: 99_999 }],
        },
      },
    ],
  ]);
  // The helper uses only synchronous context KV operations; the fake has the same observable shape.
  const storage = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key: string, value: unknown) => values.set(key, structuredClone(value)),
    delete: (key: string) => values.delete(key),
    list: ({ prefix }: { prefix: string }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))),
  } as unknown as DurableObjectStorage["kv"];
  const delivery = new DurableSubscriptionDelivery({
    storage,
    rows: () => [
      {
        name: "fanout",
        configuredAtOffset: 1,
        ordered: false,
        halted: { afterOffset: 1, attempts: 25, error: "halted" },
      },
    ],
    currentHead: () => 2,
    read: () => ({ offsets: [], scannedThroughOffset: 2, atHead: true }),
    deliver: async () => {},
    deliverEphemeral: async () => {},
    terminal: async () => {},
    run: () => {},
    wakesChanged: () => {},
  });

  delivery.sync();
  expect(delivery.deadline).toBeNull();
});
