import { expect, test, vi } from "vitest";
import type {
  StreamEvent,
  StreamEventInput,
  StreamPushEventBatch,
  StreamSubscriberWakeRequest,
  StreamWebhookDelivery,
} from "iterate/processors";
import type { ItxExpression } from "../../itx/expression.ts";
import type {
  CoreProcessorState,
  SubscriptionConfiguredPayload,
} from "./core-processor-contract.ts";
import { CoreProcessorContract } from "./core-processor-contract.ts";
import type { SubscriptionCursorRow, SubscriptionCursorStore } from "./stream-storage.ts";
import { StreamSubscribers, type SubscriberDial } from "./stream-subscribers.ts";

class FailingAckCursorStore implements SubscriptionCursorStore {
  readonly rows = new Map<string, SubscriptionCursorRow>();
  failNextAck = true;

  get(subscriptionKey: string): SubscriptionCursorRow | undefined {
    const row = this.rows.get(subscriptionKey);
    return row === undefined ? undefined : { ...row };
  }

  list(): SubscriptionCursorRow[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  ensure(subscriptionKey: string, ackedOffset: number): void {
    if (this.rows.has(subscriptionKey)) return;
    this.rows.set(subscriptionKey, {
      subscriptionKey,
      ackedOffset,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
      epoch: 1,
    });
  }

  ack(subscriptionKey: string, ackedOffset: number, epoch?: number): void {
    if (this.failNextAck) {
      this.failNextAck = false;
      throw new Error("sqlite write failed");
    }
    const row = this.rows.get(subscriptionKey);
    if (row === undefined || (epoch !== undefined && row.epoch !== epoch)) return;
    row.ackedOffset = Math.max(row.ackedOffset, ackedOffset);
    row.attempt = 0;
    row.nextAttemptAt = null;
    row.lastError = null;
  }

  advanceWatermark(subscriptionKey: string, ackedOffset: number): void {
    const row = this.rows.get(subscriptionKey);
    if (row === undefined) return;
    row.ackedOffset = Math.max(row.ackedOffset, ackedOffset);
    row.nextAttemptAt = null;
  }

  nack(
    subscriptionKey: string,
    args: { attempt: number; nextAttemptAt: number; error: string },
  ): void {
    const row = this.rows.get(subscriptionKey);
    if (row === undefined) return;
    row.attempt = args.attempt;
    row.nextAttemptAt = args.nextAttemptAt;
    row.lastError = args.error;
  }

  setCursor(subscriptionKey: string, ackedOffset: number): void {
    const row = this.rows.get(subscriptionKey);
    if (row === undefined) return;
    row.ackedOffset = ackedOffset;
    row.attempt = 0;
    row.nextAttemptAt = null;
    row.lastError = null;
    row.epoch += 1;
  }

  delete(subscriptionKey: string): void {
    this.rows.delete(subscriptionKey);
  }

  minNextAttemptAt(): number | null {
    let next: number | null = null;
    for (const row of this.rows.values()) {
      if (row.nextAttemptAt !== null && (next === null || row.nextAttemptAt < next)) {
        next = row.nextAttemptAt;
      }
    }
    return next;
  }
}

test("a post-delivery cursor failure schedules durable redelivery", async () => {
  let now = 0;
  const event: StreamEvent = {
    type: "events.example.com/message",
    offset: 1,
    createdAt: new Date(1).toISOString(),
    path: "/t",
  };
  const config: SubscriptionConfiguredPayload = {
    subscriptionKey: "k",
    delivery: { mode: "push", expression: ["worker", "processEventBatch"] },
    deliver: "all",
  };
  const configured = {
    k: {
      latestConfiguredEvent: {
        offset: 0,
        type: "events.iterate.com/stream/subscription-configured" as const,
        payload: config,
        createdAt: new Date(0).toISOString(),
      },
    },
  };
  const store = new FailingAckCursorStore();
  const pushes: StreamPushEventBatch[] = [];
  const armedAlarms: number[] = [];
  const kept: Promise<unknown>[] = [];
  const dial: SubscriberDial = {
    poke: async (_expression: ItxExpression, _request: StreamSubscriberWakeRequest) => {
      throw new Error("wake lane is not used by this regression");
    },
    push: async (_expression, batch) => {
      pushes.push(batch);
    },
    webhook: async (_url: string, _delivery: StreamWebhookDelivery) => {},
  };
  const hooks: ConstructorParameters<typeof StreamSubscribers>[0]["hooks"] = {
    readEvents: ({ afterOffset }) =>
      afterOffset < event.offset ? [{ event, byteLength: JSON.stringify(event).length }] : [],
    coreState: (): CoreProcessorState =>
      CoreProcessorContract.stateSchema.parse({
        projectId: "p1",
        path: "/t",
        createdAt: "stream-v1",
        maxOffset: event.offset,
        configuredSubscribersByKey: configured,
      }),
    store,
    dial,
    appendFact: (_event: StreamEventInput) => {},
    recordEgress: () => {},
    now: () => now,
    random: () => 0.5,
    armAlarm: async (atMs) => {
      armedAlarms.push(atMs);
    },
    repointAlarm: async (atMs) => {
      if (atMs !== null) armedAlarms.push(atMs);
    },
    keepAlive: (promise) => kept.push(promise),
  };
  const createSubscribers = () => new StreamSubscribers({ idleTeardownMs: 60_000, hooks });
  const settle = async () => {
    let seen = -1;
    while (seen !== kept.length) {
      seen = kept.length;
      await Promise.allSettled([...kept]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

  try {
    createSubscribers().wake();
    await settle();

    const failed = store.get("k");
    expect(pushes).toHaveLength(1);
    expect(failed).toMatchObject({
      ackedOffset: 0,
      attempt: 1,
      lastError: "sqlite write failed",
    });
    expect(failed?.nextAttemptAt).not.toBeNull();
    expect(armedAlarms).toContain(failed!.nextAttemptAt!);

    now = failed!.nextAttemptAt! + 1;
    createSubscribers().onAlarm();
    await settle();

    expect(pushes).toHaveLength(2);
    expect(store.get("k")).toMatchObject({
      ackedOffset: 1,
      attempt: 0,
      nextAttemptAt: null,
    });
  } finally {
    errorLog.mockRestore();
  }
});
