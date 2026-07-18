import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamEventInput } from "iterate/processors";
import { CoreProcessorContract, type CoreProcessorState } from "./core-processor-contract.ts";
import { DELIVERY_TIMEOUT_MS, DurableDeliveryCoordinator } from "./durable-delivery-coordinator.ts";
import { SqliteSubscriptionCursorStore } from "./stream-storage.ts";

function wrapSqlStorage(db: DatabaseSync): SqlStorage {
  return {
    exec<T = unknown>(sql: string, ...bindings: (ArrayBuffer | null | number | string)[]) {
      const rows = db
        .prepare(sql)
        .all(
          ...bindings.map((binding) =>
            binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
          ),
        )
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Uint8Array ? value.buffer : value,
            ]),
          ),
        );
      return { toArray: () => rows as T[] };
    },
  } as SqlStorage;
}

function makeHarness() {
  let now = 1_000;
  const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(new DatabaseSync(":memory:")));
  store.ensure("k", 0);
  const state: CoreProcessorState = CoreProcessorContract.stateSchema.parse({
    maxOffset: 10,
    configuredSubscribersByKey: {
      k: {
        latestConfiguredEvent: {
          offset: 1,
          createdAt: "2026-07-17T00:00:00.000Z",
          type: "events.iterate.com/stream/subscription-configured",
          payload: {
            subscriptionKey: "k",
            delivery: { mode: "push", expression: ["processEventBatch"] },
          },
        },
      },
    },
  });
  const facts: StreamEventInput[] = [];
  const armed: number[] = [];
  const repointed: (number | null)[] = [];
  const armFailures: Error[] = [];
  const repointFailures: Error[] = [];
  const kept: Promise<unknown>[] = [];
  const aborted: string[] = [];
  const parked: string[] = [];
  const coordinator = new DurableDeliveryCoordinator({
    coreState: () => state,
    store,
    appendRequiredFact: (event) => {
      facts.push(event);
      if (event.type === "events.iterate.com/stream/subscription-parked") {
        const payload = event.payload as {
          atOffset: number;
          reason: "receiver-failure" | "infrastructure-failure";
        };
        state.configuredSubscribersByKey.k!.parkedAtOffset = payload.atOffset;
        state.configuredSubscribersByKey.k!.parkedReason = payload.reason;
      }
    },
    now: () => now,
    random: () => 0.5,
    armAlarm: async (atMs) => {
      armed.push(atMs);
      const failure = armFailures.shift();
      if (failure !== undefined) throw failure;
    },
    repointAlarm: async (atMs) => {
      repointed.push(atMs);
      const failure = repointFailures.shift();
      if (failure !== undefined) throw failure;
    },
    keepAlive: (promise) => kept.push(promise),
    abortIncarnation: (reason) => aborted.push(reason),
    isInFlight: () => false,
    onParked: (subscriptionKey) => parked.push(subscriptionKey),
  });
  const attempt = coordinator.capture("k", 1)!;

  return {
    coordinator,
    attempt,
    store,
    facts,
    armed,
    repointed,
    armFailures,
    repointFailures,
    kept,
    aborted,
    parked,
    setNow: (value: number) => {
      now = value;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("DurableDeliveryCoordinator", () => {
  it("separates an in-flight watchdog from receiver-policy retry state", async () => {
    const h = makeHarness();

    await expect(h.coordinator.begin(h.attempt)).resolves.toBe("ready");
    expect(h.store.get("k")).toMatchObject({
      attempt: 0,
      watchdogAt: 1_000 + DELIVERY_TIMEOUT_MS + 5_000,
      retryAt: null,
    });

    await h.coordinator.fail(h.attempt, new Error("receiver rejected"));
    expect(h.store.get("k")).toMatchObject({
      attempt: 1,
      watchdogAt: null,
      retryAt: 2_000,
      lastError: "receiver rejected",
    });
    expect(h.facts).toEqual([]);
  });

  it("schedules local infrastructure recovery without changing receiver or poison policy", async () => {
    const h = makeHarness();
    h.store.nackPoison(h.attempt, {
      attempt: 2,
      nextAttemptAt: 9_000,
      error: "receiver rejected",
      poisonOffset: 7,
      poisonConfirmations: 1,
    });

    await expect(
      h.coordinator.retryInfrastructure(h.attempt, new Error("SQLite write failed")),
    ).resolves.toBe("scheduled");
    expect(h.store.get("k")).toMatchObject({
      attempt: 2,
      watchdogAt: null,
      retryAt: 6_000,
      lastError: "SQLite write failed",
      poisonOffset: 7,
      poisonConfirmations: 1,
    });
    expect(h.facts).toEqual([]);
  });

  it("turns exhausted alarm projection into an explicit infrastructure park", async () => {
    const h = makeHarness();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.armFailures.push(
      new Error("alarm unavailable"),
      new Error("still unavailable"),
      new Error("down"),
    );

    await expect(h.coordinator.begin(h.attempt)).resolves.toBe("parked");
    expect(h.facts).toEqual([
      {
        type: "events.iterate.com/stream/subscription-parked",
        payload: {
          subscriptionKey: "k",
          atOffset: 0,
          attempts: 3,
          reason: "infrastructure-failure",
          error: "down",
        },
      },
    ]);
    expect(h.store.get("k")).toMatchObject({
      attempt: 0,
      watchdogAt: null,
      retryAt: null,
    });
    expect(h.parked).toEqual(["k"]);
    expect(h.aborted).toEqual([]);
  });

  it("parks orphanable boot obligations when bounded exact projection fails", async () => {
    const h = makeHarness();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.store.nack(h.attempt, {
      attempt: 1,
      nextAttemptAt: 4_000,
      error: "receiver unavailable",
    });
    h.repointFailures.push(new Error("one"), new Error("two"), new Error("three"));

    h.coordinator.recoverAlarmAfterBoot();
    await Promise.all(h.kept);

    expect(h.repointed).toEqual([4_000, 4_000, 4_000]);
    expect(h.facts.at(-1)).toMatchObject({
      type: "events.iterate.com/stream/subscription-parked",
      payload: { reason: "infrastructure-failure", attempts: 3, error: "three" },
    });
    expect(h.aborted).toEqual([]);
  });

  it("rejects stale attempts without writing or arming a successor", async () => {
    const h = makeHarness();
    h.store.setCursor("k", 0);

    await expect(h.coordinator.begin(h.attempt)).resolves.toBe("stale");
    expect(h.armed).toEqual([]);
    expect(h.facts).toEqual([]);
    expect(h.store.get("k")?.watchdogAt).toBeNull();
  });
});
