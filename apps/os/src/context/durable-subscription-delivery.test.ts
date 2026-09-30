import { expect, test, vi } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
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
  expect(delivery).toMatchObject({ deadline: null });
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
        resumed: { atOffset: 3, afterOffset: 1_008 },
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
  expect(delivery.snapshots()["tail@1"]).toEqual({ confirmedOffset: 3, resumeAtOffset: 3 });
  expect(values.has("durable-delivery-resumed/tail@1")).toBe(false);
});

test("a cold cursor that already applied a resume is not reset again", () => {
  const values = new Map<string, unknown>([
    ["durable-delivery/applied@1", { confirmedOffset: 5, resumeAtOffset: 9 }],
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
        name: "applied",
        configuredAtOffset: 1,
        resumed: { atOffset: 9, afterOffset: 0 },
      },
    ],
    currentHead: () => 5,
    read: () => ({ offsets: [], scannedThroughOffset: 5, atHead: true }),
    deliver: async () => {},
    deliverEphemeral: async () => {},
    terminal: async () => {},
    run: () => {},
    wakesChanged: () => {},
  });

  delivery.sync();
  expect(delivery.snapshots()["applied@1"]).toEqual({ confirmedOffset: 5, resumeAtOffset: 9 });
  expect(values.has("durable-delivery-resumed/applied@1")).toBe(false);
});

test("a halted fan-out cursor never re-arms from its retained pending retry", () => {
  const values = new Map<string, unknown>([
    [
      "durable-delivery/fanout@1",
      {
        confirmedOffset: 2,
        fanOut: [{ offset: 2, attempt: 1, nextAttemptAtMs: 99_999 }],
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

test("every durable row uses the stable 25-attempt, four-hour-capped ladder", async () => {
  const values = new Map<string, unknown>([
    [
      "durable-delivery/policy@1",
      {
        confirmedOffset: 0,
        pending: { after: 0, through: 1, offsets: [1], attempt: 19 },
      },
    ],
  ]);
  const storage = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key: string, value: unknown) => values.set(key, structuredClone(value)),
    delete: (key: string) => values.delete(key),
    list: ({ prefix }: { prefix: string }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))),
  } as unknown as DurableObjectStorage["kv"];
  const runs: Promise<unknown>[] = [];
  const before = Date.now();
  const delivery = new DurableSubscriptionDelivery({
    storage,
    rows: () => [{ name: "policy", configuredAtOffset: 1, consumes: ["work"] }],
    currentHead: () => 1,
    read: () => ({ offsets: [], scannedThroughOffset: 1, atHead: true }),
    deliver: async () => {
      throw new Error("temporary");
    },
    deliverEphemeral: async () => {},
    terminal: async () => {},
    run: (work) => runs.push(work()),
    wakesChanged: () => {},
  });

  // Replacing live rewrite rules cannot change this row's policy: rows contain only row identity.
  delivery.revive();
  await vi.waitFor(() => expect(runs).toHaveLength(1));
  await Promise.all(runs);
  expect(values.get("durable-delivery/policy@1")).toMatchObject({
    pending: {
      attempt: 20,
      nextAttemptAtMs: expect.any(Number),
    },
  });
  const cursor = values.get("durable-delivery/policy@1") as {
    pending: { nextAttemptAtMs: number };
  };
  expect(cursor.pending.nextAttemptAtMs).toBeGreaterThanOrEqual(before + 4 * 60 * 60_000);
});

test("a cold commit drives every new row so another row keeps its persisted backoff", async () => {
  const retryAt = Date.now() + 60_000;
  const values = new Map<string, unknown>([
    [
      "durable-delivery/b@2",
      {
        confirmedOffset: 1,
        pending: {
          after: 1,
          through: 2,
          offsets: [2],
          attempt: 1,
          nextAttemptAtMs: retryAt,
        },
      },
    ],
  ]);
  const storage = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key: string, value: unknown) => values.set(key, structuredClone(value)),
    delete: (key: string) => values.delete(key),
    list: ({ prefix }: { prefix: string }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))),
  } as unknown as DurableObjectStorage["kv"];
  const rows = [
    { name: "a", configuredAtOffset: 1 },
    { name: "b", configuredAtOffset: 2, consumes: ["work"] },
  ];
  const runs: Promise<unknown>[] = [];
  const delivery = new DurableSubscriptionDelivery({
    storage,
    rows: () => rows,
    currentHead: () => 2,
    read: () => ({ offsets: [], scannedThroughOffset: 2, atHead: true }),
    deliver: async () => {},
    deliverEphemeral: async () => {},
    terminal: async () => {},
    run: (work) => runs.push(work()),
    wakesChanged: () => {},
  });

  delivery.push(rows, [{ offset: 3, type: "events.iterate.com/itx/woken" } as StreamEvent], false);
  await vi.waitFor(() => expect(runs).toHaveLength(2));
  await Promise.all(runs);
  expect(delivery).toMatchObject({ deadline: retryAt });
});

test("an ephemeral-only commit does not drive a fresh fan-out row", () => {
  const values = new Map<string, unknown>();
  const storage = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key: string, value: unknown) => values.set(key, structuredClone(value)),
    delete: (key: string) => values.delete(key),
    list: ({ prefix }: { prefix: string }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))),
  } as unknown as DurableObjectStorage["kv"];
  const rows = [
    { name: "fanout", configuredAtOffset: 1, ordered: false as const, consumes: ["tick"] },
    { name: "ordered", configuredAtOffset: 2, consumes: ["tick"] },
  ];
  const run = vi.fn();
  const delivery = new DurableSubscriptionDelivery({
    storage,
    rows: () => rows,
    currentHead: () => 1,
    read: () => ({ offsets: [], scannedThroughOffset: 1, atHead: true }),
    deliver: async () => {},
    deliverEphemeral: async () => {},
    terminal: async () => {},
    run,
    wakesChanged: () => {},
  });

  delivery.push(rows, [{ offset: 3, type: "tick", ephemeral: true } as StreamEvent], false);
  expect(run).toHaveBeenCalledOnce();
});

test("a running retry consumes its past wake instead of rearming it while the target is held", async () => {
  const values = new Map<string, unknown>();
  const storage = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key: string, value: unknown) => values.set(key, structuredClone(value)),
    delete: (key: string) => values.delete(key),
    list: ({ prefix }: { prefix: string }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))),
  } as unknown as DurableObjectStorage["kv"];
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const runs: Promise<unknown>[] = [];
  const delivery = new DurableSubscriptionDelivery({
    storage,
    rows: () => [{ name: "retry", configuredAtOffset: 1, consumes: ["work"] }],
    currentHead: () => 2,
    read: (_row, after) => ({
      offsets: after < 2 ? [2] : [],
      scannedThroughOffset: 2,
      atHead: true,
    }),
    deliver: async () => {
      if (++calls === 1) throw new Error("retry");
      await held;
    },
    deliverEphemeral: async () => {},
    terminal: async () => {},
    run: (work) => runs.push(work()),
    wakesChanged: () => {},
  });
  delivery.revive();
  await vi.waitFor(() => expect(calls).toBe(1));
  await Promise.all(runs);
  const retryAt = delivery.deadline;
  expect(retryAt).toBeGreaterThan(Date.now());
  vi.useFakeTimers({ now: retryAt! + 1, toFake: ["Date"] });
  try {
    delivery.revive();
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(delivery.deadline).toBeNull();
    delivery.revive();
    expect(delivery.deadline).toBeNull();
  } finally {
    release();
    await Promise.all(runs);
    vi.useRealTimers();
  }
});
