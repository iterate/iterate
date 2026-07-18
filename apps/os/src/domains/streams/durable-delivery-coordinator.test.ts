import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamEventInput } from "iterate/processors";
import { CoreProcessorContract, type CoreProcessorState } from "./core-processor-contract.ts";
import {
  DELIVERY_TIMEOUT_MS,
  DurableDeliveryCoordinator,
  StreamDeliveryFatalInvariantError,
} from "./durable-delivery-coordinator.ts";
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
  const parked: string[] = [];
  let requiredFactFailure: Error | undefined;
  let armHook: (() => void) | undefined;
  const coordinator = new DurableDeliveryCoordinator({
    coreState: () => state,
    store,
    appendRequiredFact: (event) => {
      if (requiredFactFailure !== undefined) throw requiredFactFailure;
      facts.push(event);
      if (event.type === "events.iterate.com/stream/subscription-parked") {
        const payload = event.payload as {
          subscriptionKey: string;
          atOffset?: number;
          reason: "receiver-failure" | "infrastructure-failure";
        };
        const configured = state.configuredSubscribersByKey[payload.subscriptionKey];
        if (configured !== undefined) {
          configured.parkedAtOffset = payload.atOffset;
          configured.parkedReason = payload.reason;
        }
      }
    },
    now: () => now,
    random: () => 0.5,
    armAlarm: async (atMs) => {
      armed.push(atMs);
      armHook?.();
      const failure = armFailures.shift();
      if (failure !== undefined) throw failure;
    },
    repointAlarm: async (atMs) => {
      repointed.push(atMs);
      const failure = repointFailures.shift();
      if (failure !== undefined) throw failure;
    },
    keepAlive: (promise) => kept.push(promise),
    isInFlight: () => false,
    onParked: (subscriptionKey) => parked.push(subscriptionKey),
  });
  const attempt = { subscriptionKey: "k", configOffset: 1, epoch: store.get("k")!.epoch };

  return {
    coordinator,
    attempt,
    state,
    store,
    facts,
    armed,
    repointed,
    armFailures,
    repointFailures,
    kept,
    parked,
    setNow: (value: number) => {
      now = value;
    },
    failRequiredFactsWith: (error: Error | undefined) => {
      requiredFactFailure = error;
    },
    setArmHook: (hook: (() => void) | undefined) => {
      armHook = hook;
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
  });

  it("reports a replacement fence as stale when alarm projection fails during replacement", async () => {
    const h = makeHarness();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.armFailures.push(new Error("one"), new Error("two"), new Error("three"));
    let arms = 0;
    h.setArmHook(() => {
      arms += 1;
      if (arms === 3) h.store.setCursor("k", 0);
    });

    await expect(h.coordinator.begin(h.attempt)).resolves.toBe("stale");
    expect(h.facts).toEqual([]);
    expect(h.store.get("k")).toMatchObject({
      epoch: h.attempt.epoch + 1,
      watchdogAt: null,
      retryAt: null,
    });
  });

  it("preserves the watchdog and throws fatally when setup can neither park nor project it", async () => {
    const h = makeHarness();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.failRequiredFactsWith(new Error("park append unavailable"));
    h.armFailures.push(new Error("one"), new Error("two"), new Error("three"));
    h.repointFailures.push(new Error("four"), new Error("five"), new Error("six"));

    await expect(h.coordinator.begin(h.attempt)).rejects.toBeInstanceOf(
      StreamDeliveryFatalInvariantError,
    );

    expect(h.store.get("k")).toMatchObject({
      ackedOffset: 0,
      attempt: 0,
      watchdogAt: 1_000 + DELIVERY_TIMEOUT_MS + 5_000,
      retryAt: null,
    });
    expect(h.facts).toEqual([]);
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
  });

  it("makes compound boot projection and park failure an explicit fatal invariant", async () => {
    const h = makeHarness();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.store.nack(h.attempt, {
      attempt: 1,
      nextAttemptAt: 4_000,
      error: "receiver unavailable",
    });
    h.failRequiredFactsWith(new Error("park append unavailable"));
    h.repointFailures.push(
      new Error("one"),
      new Error("two"),
      new Error("three"),
      new Error("four"),
      new Error("five"),
      new Error("six"),
    );

    h.coordinator.recoverAlarmAfterBoot();

    await expect(Promise.all(h.kept)).rejects.toBeInstanceOf(StreamDeliveryFatalInvariantError);
    expect(h.store.get("k")?.nextAttemptAt).toBe(4_000);
    expect(h.facts).toEqual([]);
  });

  it("keeps a reconciliation fatal invariant fatal instead of retrying past it", async () => {
    const h = makeHarness();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.failRequiredFactsWith(new Error("park append unavailable"));
    h.armFailures.push(new Error("one"), new Error("two"), new Error("three"));
    h.repointFailures.push(new Error("four"), new Error("five"), new Error("six"));

    h.coordinator.recoverReconcile({
      subscriptionKey: "k",
      configOffset: 1,
      initialCursor: 0,
      error: new Error("cursor acquisition failed"),
    });

    await expect(Promise.all(h.kept)).rejects.toBeInstanceOf(StreamDeliveryFatalInvariantError);
    expect(h.store.get("k")).toMatchObject({
      ackedOffset: 0,
      attempt: 0,
      watchdogAt: null,
      retryAt: 6_000,
    });
    expect(h.facts).toEqual([]);
  });

  it("continues parking outstanding rows after parked-cursor cleanup fails", async () => {
    const h = makeHarness();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.state.configuredSubscribersByKey.j = {
      latestConfiguredEvent: {
        offset: 2,
        createdAt: "2026-07-17T00:00:01.000Z",
        type: "events.iterate.com/stream/subscription-configured",
        payload: {
          subscriptionKey: "j",
          delivery: { mode: "push", expression: ["processEventBatch"] },
        },
      },
    };
    h.store.ensure("j", 0);
    h.store.nack(h.attempt, {
      attempt: 1,
      nextAttemptAt: 4_000,
      error: "receiver unavailable",
    });
    const j = { subscriptionKey: "j", configOffset: 2, epoch: h.store.get("j")!.epoch };
    h.store.nack(j, {
      attempt: 1,
      nextAttemptAt: 5_000,
      error: "receiver unavailable",
    });
    const ackAttempt = h.store.ackAttempt.bind(h.store);
    h.store.ackAttempt = (fence, offset) => {
      if (fence.subscriptionKey === "k") throw new Error("cursor cleanup failed");
      ackAttempt(fence, offset);
    };

    await h.coordinator.parkOutstandingInfrastructure(new Error("alarm exhausted"), 3);

    expect(
      h.facts.map((fact) => (fact.payload as { subscriptionKey: string }).subscriptionKey),
    ).toEqual(["k", "j"]);
    expect(h.parked).toEqual(["k", "j"]);
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
