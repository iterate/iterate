// A living inventory of guarantees the stream subscription model deliberately
// does NOT give.
//
// The copy-list handshake — a receiver-side authoritative subscription
// registry with a three-event configure protocol (recorded/confirmed),
// blocked/resend repair lanes, and move-gating — was deleted in favor of
// per-batch provenance stamps plus a small passive receiver fence (reject
// batches from strictly-older source lifetimes or older config generations).
// That bought roughly 2,000 fewer lines at the price of the specific
// guarantees pinned below. Each test is written as if the guarantee EXISTED:
// it exercises the real system and asserts the desirable behavior, and it
// genuinely fails today because the system does not provide it. `test.fails`
// keeps the suite green exactly as long as the guarantee stays un-given.
//
// If a change makes one of these tests pass, vitest will fail it as
// unexpectedly-passing. Do not delete the test — move it to the regular
// suites and delete only its entry here.

import { DatabaseSync } from "node:sqlite";
import type {
  CopyReceipt,
  StreamDeliveryBatch,
  StreamEvent,
  StreamEventInput,
} from "iterate/processors";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  CoreProcessorContract,
  type SubscriptionConfiguredPayload,
} from "./core-processor-contract.ts";
import { StreamDurableObject } from "./stream-durable-object.ts";
import { StreamEventSender, type SubscriptionReceiverCalls } from "./stream-event-sender.ts";
import { SqliteSubscriptionCursorStore } from "./stream-storage.ts";

const PROJECT_ID = "prj_guarantees_not_given";

function streamName(path: string): string {
  return DurableObjectNameCodec.stringify(
    { projectId: PROJECT_ID, path },
    { allowNullProjectId: true },
  );
}

function wrapSqlStorage(db: DatabaseSync): SqlStorage {
  return {
    databaseSize: 0,
    exec<T = unknown>(sql: string, ...bindings: (ArrayBuffer | null | number | string)[]) {
      const rows = db
        .prepare(sql)
        .all(
          ...bindings.map((binding) =>
            binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
          ),
        )
        .map((row) => Object.fromEntries(Object.entries(row).map(fromNodeSqlValue)));
      return { toArray: () => rows as T[] };
    },
  } as unknown as SqlStorage;
}

function fromNodeSqlValue([key, value]: [string, unknown]) {
  if (value instanceof Uint8Array) {
    return [key, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)];
  }
  return [key, value];
}

function durableObjectContext(name: string) {
  const db = new DatabaseSync(":memory:");
  const values = new Map<string, unknown>();
  const backgroundWork: Promise<unknown>[] = [];
  const alarms: number[] = [];
  const alarmDeletes: number[] = [];
  let latestInitialization: Promise<unknown> | undefined;
  const storage = {
    sql: wrapSqlStorage(db),
    kv: {
      get<T>(key: string): T | undefined {
        const value = values.get(key);
        return value === undefined ? undefined : structuredClone(value as T);
      },
      put(key: string, value: unknown): void {
        values.set(key, structuredClone(value));
      },
      delete(key: string): void {
        values.delete(key);
      },
    },
    setAlarm(atMs: number): Promise<void> {
      alarms.push(atMs);
      return Promise.resolve();
    },
    deleteAlarm(): Promise<void> {
      alarmDeletes.push(alarms.length);
      return Promise.resolve();
    },
    sync(): Promise<void> {
      return Promise.resolve();
    },
    transactionSync<T>(callback: () => T): T {
      return callback();
    },
  };
  const ctx = {
    id: { name },
    storage,
    exports: {},
    getWebSockets(): WebSocket[] {
      return [];
    },
    waitUntil(work: Promise<unknown>): void {
      backgroundWork.push(work);
    },
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const work = Promise.resolve().then(callback);
      latestInitialization = work;
      return work;
    },
    abort(): never {
      throw new Error("test Durable Object aborted");
    },
  } as unknown as DurableObjectState;

  return {
    alarms,
    close: () => db.close(),
    ctx,
    async waitForInitialization(): Promise<void> {
      await latestInitialization;
    },
    async settle(): Promise<void> {
      let seen = -1;
      while (seen !== backgroundWork.length) {
        seen = backgroundWork.length;
        await Promise.allSettled([...backgroundWork]);
        await Promise.resolve();
      }
    },
  };
}

/**
 * A Durable Object namespace over in-process streams. `holdCopiesWhen` parks a
 * matching delivery instead of forwarding it: the batch is handed to the test
 * (it is now "in flight on the wire") and the source keeps awaiting the
 * returned transport acknowledgement until the test resolves it.
 */
function streamNamespace(
  streams: Map<string, StreamDurableObject>,
  holdCopiesWhen?: {
    match: (targetName: string, batch: StreamDeliveryBatch) => boolean;
    captured: PromiseWithResolvers<StreamDeliveryBatch>;
    transportAck: PromiseWithResolvers<CopyReceipt>;
  },
): Env {
  return {
    STREAM: {
      getByName: (name: string) => ({
        async appendCoreEvent(eventInput: StreamEventInput): Promise<StreamEvent> {
          const target = streams.get(name);
          if (target !== undefined) return target.appendCoreEvent(eventInput);
          // Ancestor announcements may address streams a test never creates.
          return {
            ...eventInput,
            path: "/",
            offset: 1,
            createdAt: new Date().toISOString(),
          } as StreamEvent;
        },
        async receiveCopiedEvents(batch: StreamDeliveryBatch): Promise<CopyReceipt> {
          if (holdCopiesWhen?.match(name, batch) === true) {
            holdCopiesWhen.captured.resolve(batch);
            return holdCopiesWhen.transportAck.promise;
          }
          const target = streams.get(name);
          if (target === undefined) throw new Error(`test stream ${name} does not exist`);
          return target.receiveCopiedEvents(batch);
        },
      }),
    },
  } as unknown as Env;
}

async function bootStream(args: {
  path: string;
  env: Env;
  streams: Map<string, StreamDurableObject>;
}) {
  const context = durableObjectContext(streamName(args.path));
  const stream = new StreamDurableObject(context.ctx, args.env);
  args.streams.set(streamName(args.path), stream);
  await context.waitForInitialization();
  await context.settle();
  return { context, stream };
}

function reviewFeedConfiguration(receivingStreamPath: string): SubscriptionConfiguredPayload {
  return {
    subscriptionKey: "review-feed",
    filter: { eventTypes: ["example.com/issue-created"] },
    receiver: {
      action: "copy-to-stream",
      receivingStreamPath,
      delivery: { start: "beginning", onFailingEvent: "halt" },
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("guarantees the subscription rewrite deliberately does not give", () => {
  // GUARANTEE: after `subscription-removed` commits on the source, no copied
  //   event from that subscription can commit on the receiver.
  // WHY NOT GIVEN: the deleted receiver-side authoritative registry knew its
  //   subscription list and rejected non-members. The passive fence that
  //   replaced it checks source lifetime and config generation only — not
  //   liveness — so a batch dispatched before the removal lands and commits
  //   after it.
  // BOUND: at most one in-flight batch per subscription, and every receiver
  //   call is bounded by the ~20s delivery deadline (DEFAULT_DELIVERY_TIMEOUT_MS),
  //   so the window closes within one delivery round.
  // RESTORE: the deleted receiver-side registry (membership checked at
  //   receive time), or any receiver-visible removal record.
  test.fails("removing a subscription atomically stops in-flight deliveries", async () => {
    const streams = new Map<string, StreamDurableObject>();
    const captured = Promise.withResolvers<StreamDeliveryBatch>();
    const transportAck = Promise.withResolvers<CopyReceipt>();
    const env = streamNamespace(streams, {
      match: (targetName) => targetName === streamName("/reviewer"),
      captured,
      transportAck,
    });
    const source = await bootStream({ path: "/", env, streams });
    const reviewer = await bootStream({ path: "/reviewer", env, streams });

    try {
      source.stream.setCopySubscription({ configuration: reviewFeedConfiguration("/reviewer") });
      source.stream.append({ type: "example.com/issue-created", payload: { issue: 1 } });
      source.stream.alarm();
      const inFlight = await captured.promise;

      expect(
        source.stream.removeCopySubscription({
          subscriptionKey: "review-feed",
          expectedReceiverPath: "/reviewer",
        }),
      ).toMatchObject({ status: "removed" });

      // The parked batch lands after the removal committed — exactly what a
      // slow RPC hop does. A receiver that rejected members of removed
      // subscriptions would satisfy the guarantee, so a throw is tolerated.
      try {
        reviewer.stream.receiveCopiedEvents(inFlight);
      } catch {
        // rejecting the orphaned delivery is one valid way to give the guarantee
      }
      transportAck.resolve({ acknowledged: inFlight.events.length });
      await Promise.all([source.context.settle(), reviewer.context.settle()]);

      expect(reviewer.stream.getEvents({ eventTypes: ["example.com/issue-created"] })).toEqual([]);
    } finally {
      reviewer.context.close();
      source.context.close();
    }
  });

  // GUARANTEE: re-pointing a subscription key from receiver A to receiver B
  //   never delivers the same source event to both.
  // WHY NOT GIVEN: the deleted move-gating handshake made the old receiver
  //   confirm the move before the new one could receive. Now an in-flight
  //   batch to A commits after the config change (A has no inbound record yet,
  //   so the fence has nothing newer to compare against), while B's reset
  //   cursor redelivers the same event from the beginning.
  // BOUND: one in-flight batch to the old receiver, ~20s delivery deadline;
  //   afterwards the fence pins A to the superseded generation, so the
  //   duplicate window is a single delivery round.
  // RESTORE: the deleted move-gating handshake (quiesce the old receiver
  //   before enabling the new one).
  test.fails("re-pointing a subscription key from one receiver to another never delivers the same event to both", async () => {
    const streams = new Map<string, StreamDurableObject>();
    const capturedForA = Promise.withResolvers<StreamDeliveryBatch>();
    const transportAckForA = Promise.withResolvers<CopyReceipt>();
    const env = streamNamespace(streams, {
      match: (targetName) => targetName === streamName("/reviewer-a"),
      captured: capturedForA,
      transportAck: transportAckForA,
    });
    const source = await bootStream({ path: "/", env, streams });
    const reviewerA = await bootStream({ path: "/reviewer-a", env, streams });
    const reviewerB = await bootStream({ path: "/reviewer-b", env, streams });

    try {
      source.stream.setCopySubscription({ configuration: reviewFeedConfiguration("/reviewer-a") });
      source.stream.append({ type: "example.com/issue-created", payload: { issue: 42 } });
      source.stream.alarm();
      const inFlightToA = await capturedForA.promise;

      // Re-point the same key to reviewer B while the batch to A is in flight.
      source.stream.setCopySubscription({ configuration: reviewFeedConfiguration("/reviewer-b") });

      try {
        reviewerA.stream.receiveCopiedEvents(inFlightToA);
      } catch {
        // rejecting the superseded delivery is one valid way to give the guarantee
      }
      transportAckForA.resolve({ acknowledged: inFlightToA.events.length });
      await Promise.all([
        source.context.settle(),
        reviewerA.context.settle(),
        reviewerB.context.settle(),
      ]);

      const receiversHoldingTheCopy = [
        ["/reviewer-a", reviewerA.stream] as const,
        ["/reviewer-b", reviewerB.stream] as const,
      ]
        .filter(
          ([, stream]) =>
            stream.getEvents({ eventTypes: ["example.com/issue-created"] }).length > 0,
        )
        .map(([path]) => path);
      expect(receiversHoldingTheCopy.length).toBeLessThanOrEqual(1);
    } finally {
      reviewerB.context.close();
      reviewerA.context.close();
      source.context.close();
    }
  });

  // GUARANTEE: `setCopySubscription` toward an unusable or nonexistent
  //   receiving stream fails at configure time.
  // WHY NOT GIVEN: the deleted recorded/confirmed round-trip verified the
  //   receiver before delivery began. `setCopySubscription` now appends and
  //   returns without any probe call, by design ("the receiver learns about
  //   the subscription when its first copy arrives").
  // BOUND: the breakage is loud, just late — delivery burns its bounded retry
  //   ladder (15 attempts, roughly 2–2.5h of backoff) and appends a durable
  //   `subscription-delivery-halted`, which has UI plus repair verbs
  //   (resumeSubscription / a fresh setCopySubscription).
  // RESTORE: the deleted configure-time round-trip, or a probe call before
  //   committing the configuration.
  test.fails("configuring a copy subscription verifies the receiver end-to-end", async () => {
    const streams = new Map<string, StreamDurableObject>();
    const env = streamNamespace(streams);
    const source = await bootStream({ path: "/", env, streams });

    try {
      try {
        // No stream exists at /nowhere; every future delivery to it fails.
        source.stream.setCopySubscription({ configuration: reviewFeedConfiguration("/nowhere") });
      } catch {
        // configure-time verification would reject the unusable receiver here
      }
      expect(
        source.stream.runtimeState().coreProcessorState.subscriptions.outbound.byKey["review-feed"],
      ).toBeUndefined();
    } finally {
      source.context.close();
    }
  });

  // GUARANTEE: delivery to an itx-call receiver is exactly-once.
  // WHY NOT GIVEN: nothing reasonable restores this — the awaited call IS the
  //   acknowledgement, so an acknowledgement lost after the receiver did its
  //   work (isolate death, cancelled RPC) is indistinguishable from a failed
  //   delivery and the same events are redelivered. At-least-once is doctrine:
  //   itx-call and webhook-post (and processor-wake) receivers must be
  //   idempotent — a webhook-driven remote processor deduplicates by
  //   (streamId, event.offset). Contrast:
  //   copy-to-stream receivers stay exactly-once at COMMIT because the copy
  //   idempotency identity collapses the redelivered append
  //   (copy-appends.test.ts "transport retries dedupe within one source
  //   lifetime") — an itx call or webhook POST has no such identity; the call
  //   is the work.
  // BOUND: redelivery replays from the last acknowledged cursor only, in
  //   order, within one subscription; duplicates are bounded by one batch per
  //   lost acknowledgement.
  // RESTORE: nothing planned. This test documents the doctrine.
  test.fails("delivery to an itx-call receiver is exactly-once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let now = 10_000;
    const deliveredBatches: number[][] = [];
    const state = CoreProcessorContract.stateSchema.parse({
      projectId: "project",
      path: "/source",
      streamId: "11111111-1111-4111-8111-111111111111",
      createdAt: "2026-07-21T10:00:00.000Z",
      maxOffset: 2,
      subscriptions: {
        outbound: {
          byKey: {
            "project-feed": {
              configuration: {
                subscriptionKey: "project-feed",
                receiver: {
                  action: "itx-call",
                  expression: ["worker", "processEventBatch"],
                  delivery: { start: "beginning", onFailingEvent: "halt" },
                },
              },
              configuredAtOffset: 1,
              configuredAt: new Date(1).toISOString(),
            },
          },
        },
      },
    });
    const store = new SqliteSubscriptionCursorStore(wrapSqlStorage(new DatabaseSync(":memory:")));
    store.ensure("project-feed", 0, 1);
    const sourceEvents: StreamEvent[] = [
      {
        type: "example.com/issue-created",
        payload: { issue: 1 },
        createdAt: new Date(2).toISOString(),
        offset: 2,
        path: "/source",
      },
    ];
    const kept: Promise<unknown>[] = [];
    const receiverCalls: SubscriptionReceiverCalls = {
      wakeStreamProcessor: async () => {
        throw new Error("an ITX receiver must not wake a hosted processor");
      },
      deliverToItx: async (_expression, batch) => {
        // The receiver does its work; for an itx call, the call IS the effect.
        deliveredBatches.push(batch.events.map(({ offset }) => offset));
      },
      copyToStream: async () => ({ acknowledged: 0 }),
      deliverToWebhook: async () => undefined,
    };
    const eventSender = new StreamEventSender({
      idleTeardownMs: 60_000,
      hooks: {
        readEvents: ({ afterOffset, beforeOffset, limit }) =>
          sourceEvents
            .filter((entry) => entry.offset > afterOffset && entry.offset < beforeOffset)
            .slice(0, limit)
            .map((entry) => ({ event: entry, byteLength: JSON.stringify(entry).length })),
        coreState: () => state,
        store,
        receiverCalls,
        appendDeliveryEvent: () => true,
        recordEgress: () => undefined,
        runtimeChanged: () => undefined,
        now: () => now,
        random: () => 0.5,
        armAlarm: () => undefined,
        clearAlarm: () => undefined,
        runDurable: (work) => kept.push(work()),
        keepAlive: (promise) => kept.push(promise),
        subscriberPagerConnectionKeys: () => new Set<string>(),
        onSessionsIdleClosed: () => undefined,
        pageDormantSubscribers: () => undefined,
      },
    });
    async function settle() {
      let seen = -1;
      while (seen !== kept.length) {
        seen = kept.length;
        await Promise.allSettled([...kept]);
        await Promise.resolve();
      }
      await Promise.resolve();
    }
    // The receiver resolves, then the acknowledgement is lost before the
    // source commits its cursor — the wire fact behind every at-least-once
    // redelivery.
    const commitAcknowledgement = store.ack.bind(store);
    vi.spyOn(store, "ack")
      .mockImplementationOnce(() => {
        throw new Error("simulated acknowledgement loss after the receiver did its work");
      })
      .mockImplementation(commitAcknowledgement);

    eventSender.sendDue();
    await settle();
    now = 11_000;
    eventSender.onAlarm();
    await settle();

    expect(deliveredBatches).toEqual([[2]]);
  });

  // GUARANTEE: events from two source streams arrive at a shared receiver in
  //   global append order.
  // WHY NOT GIVEN: ordering is per-subscription only. Each source owns an
  //   independent cursor and retry schedule, so a slow subscription
  //   interleaves arbitrarily with a fast one; nothing sequences across
  //   sources. This was true before the rewrite too — cross-source sequencing
  //   is deliberately out of scope.
  // BOUND: within one subscription, order is strict; the inversion is only
  //   ever across sources, and each source still arrives gap-free.
  // RESTORE: cross-source sequencing (a receiver-side total order or source
  //   coordination) — deliberately out of scope.
  test.fails("events from two source streams arrive at a shared receiver in global append order", async () => {
    const streams = new Map<string, StreamDurableObject>();
    const capturedFromA = Promise.withResolvers<StreamDeliveryBatch>();
    const transportAckForA = Promise.withResolvers<CopyReceipt>();
    const env = streamNamespace(streams, {
      // Subscription A is the slow one: its batch parks on the wire while
      // subscription B delivers immediately.
      match: (targetName, batch) =>
        targetName === streamName("/inbox") && batch.path === "/issues-a",
      captured: capturedFromA,
      transportAck: transportAckForA,
    });
    const sourceA = await bootStream({ path: "/issues-a", env, streams });
    const sourceB = await bootStream({ path: "/issues-b", env, streams });
    const inbox = await bootStream({ path: "/inbox", env, streams });

    try {
      sourceA.stream.setCopySubscription({
        configuration: { ...reviewFeedConfiguration("/inbox"), subscriptionKey: "feed" },
      });
      sourceA.stream.append({ type: "example.com/issue-created", payload: { appended: "first" } });
      sourceA.stream.alarm();
      const inFlightFromA = await capturedFromA.promise;

      // Appended strictly after A's event, while A's batch is still in flight.
      sourceB.stream.setCopySubscription({
        configuration: { ...reviewFeedConfiguration("/inbox"), subscriptionKey: "feed" },
      });
      sourceB.stream.append({ type: "example.com/issue-created", payload: { appended: "second" } });
      sourceB.stream.alarm();
      await Promise.all([sourceB.context.settle(), inbox.context.settle()]);

      // The older event lands only after the newer one already committed.
      try {
        inbox.stream.receiveCopiedEvents(inFlightFromA);
      } catch {
        // a receiver that re-sequenced or rejected the late batch could give the guarantee
      }
      transportAckForA.resolve({ acknowledged: inFlightFromA.events.length });
      await Promise.all([sourceA.context.settle(), inbox.context.settle()]);

      expect(
        inbox.stream
          .getEvents({ eventTypes: ["example.com/issue-created"] })
          .map(({ payload }) => payload),
      ).toEqual([{ appended: "first" }, { appended: "second" }]);
    } finally {
      inbox.context.close();
      sourceB.context.close();
      sourceA.context.close();
    }
  });

  // GUARANTEE: a receiver that lost its data (erased/recreated stream) gets
  //   the source history automatically re-sent.
  // WHY NOT GIVEN: the deleted blocked/resend-request lane let a receiver
  //   report "I am missing history" and pull a resend. Now the source's cursor
  //   never moves on its own: it does not know the receiver was recreated, so
  //   the fresh lifetime silently misses everything delivered before the
  //   recreation.
  // BOUND: only events already acknowledged before the loss are missing; new
  //   events flow immediately (the fence accepts a first-contact receiver).
  //   Repair is a manual, audited `subscription-cursor-set` append on the
  //   source (afterOffset: 0 replays everything), one itx call away.
  // RESTORE: the deleted blocked/resend-request lane, or receiver-lifetime
  //   tracking on the source that rewinds the cursor on first contact with a
  //   new receiver lifetime.
  test.fails("a receiver that lost its data gets the source history automatically re-sent", async () => {
    const streams = new Map<string, StreamDurableObject>();
    const env = streamNamespace(streams);
    const source = await bootStream({ path: "/", env, streams });
    const firstReviewer = await bootStream({ path: "/reviewer", env, streams });

    try {
      source.stream.setCopySubscription({ configuration: reviewFeedConfiguration("/reviewer") });
      source.stream.append({
        type: "example.com/issue-created",
        payload: { issue: "before-the-loss" },
      });
      source.stream.alarm();
      await Promise.all([source.context.settle(), firstReviewer.context.settle()]);
      expect(
        firstReviewer.stream.getEvents({ eventTypes: ["example.com/issue-created"] }),
      ).toHaveLength(1);

      // Destroy and recreate the receiving stream: fresh storage, new stream
      // lifetime, empty history.
      const recreatedReviewer = await bootStream({ path: "/reviewer", env, streams });
      try {
        source.stream.append({
          type: "example.com/issue-created",
          payload: { issue: "after-the-loss" },
        });
        source.stream.alarm();
        await Promise.all([source.context.settle(), recreatedReviewer.context.settle()]);

        expect(
          recreatedReviewer.stream
            .getEvents({ eventTypes: ["example.com/issue-created"] })
            .map(({ payload }) => payload),
        ).toEqual([{ issue: "before-the-loss" }, { issue: "after-the-loss" }]);
      } finally {
        recreatedReviewer.context.close();
      }
    } finally {
      firstReviewer.context.close();
      source.context.close();
    }
  });

  // GUARANTEE: the receiver can enumerate its inbound subscriptions before the
  //   first event arrives.
  // WHY NOT GIVEN: the deleted `copy-list-recorded` registration told the
  //   receiver about the subscription at configure time. The passive fence
  //   records that replaced it materialize only from the `source.copiedFrom`
  //   stamp on the first committed copied batch, so until an event matches and
  //   delivers, the receiver's state does not know the subscription exists.
  // BOUND: debug/introspection only — delivery itself never needed the record,
  //   and the source side lists the subscription immediately.
  // RESTORE: the deleted configure-time registration event on the receiver.
  test.fails("the receiver can enumerate its inbound subscriptions before the first event arrives", async () => {
    const streams = new Map<string, StreamDurableObject>();
    const env = streamNamespace(streams);
    const source = await bootStream({ path: "/", env, streams });
    const reviewer = await bootStream({ path: "/reviewer", env, streams });

    try {
      source.stream.setCopySubscription({ configuration: reviewFeedConfiguration("/reviewer") });
      // Give the source every chance to tell the receiver: run a full delivery
      // round. No event matches the filter, so no batch is sent.
      source.stream.alarm();
      await Promise.all([source.context.settle(), reviewer.context.settle()]);

      expect(
        reviewer.stream.runtimeState().coreProcessorState.subscriptions.inbound.bySourcePath["/"]?.[
          "review-feed"
        ],
      ).toBeDefined();
    } finally {
      reviewer.context.close();
      source.context.close();
    }
  });
});
