// The device processor's executable spec, on the generic step harness from
// iterate/processors/testing: the REAL StreamProcessorRunner over a
// MemoryStreamNetwork (the device stream plus the project root stream the
// cross-posts land on), virtual time, and eviction-faithful crash(). The only
// device-specific fakes are the Expo gateway (send/getReceipt/clearPushToken,
// swappable per test through a mutable box) and the recorded receipt-alarm
// repoints.

import { describe, expect, it } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  MemoryStreamNetwork,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import { DeviceProcessorContract } from "./device-processor-contract.ts";
import { DeviceProcessor, type DevicePushSender } from "./device-processor-implementation.ts";

type DeviceEventInput = ConsumedInput<DeviceProcessorContract>;

// -----------------------------------------------------------------------------
// Event literals: the birth certificate and the recurring request shapes.
// These are event BUILDERS (data), not append wrappers — every test appends
// through the harness's typed step.
// -----------------------------------------------------------------------------

const DEVICE_CREATED = {
  type: "events.iterate.com/device/created",
  payload: {
    config: {
      appVersion: "1.0.0",
      label: "Misha's iPhone",
      notificationsStatus: "granted",
      ownerId: "usr_misha",
      platform: "ios",
      pushTokenSecretPath: "/secrets/devices/phone/expo-push-token",
      pushTokenSecretUpdatedOffset: 1,
    },
  },
} satisfies DeviceEventInput;

function notificationRequested(overrides?: {
  idempotencyKey?: string;
  expiresAt?: number;
  destination?: { kind: "project" } | { kind: "approvals"; approvalRequestEventOffset: number };
  body?: string;
}): DeviceEventInput {
  return {
    type: "events.iterate.com/device/notification-requested",
    ...(overrides?.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: overrides.idempotencyKey }),
    payload: {
      body: overrides?.body ?? "Buy milk",
      destination: overrides?.destination ?? { kind: "project" },
      expiresAt: overrides?.expiresAt ?? Date.parse("2026-07-18T08:05:00Z"),
      title: "Reminder",
    },
  };
}

const REVIVED = {
  type: "events.iterate.com/stream/processor-revived",
  payload: { processorSlug: "device", revivals: 1, version: "test" },
} satisfies DeviceEventInput;

const SETTLED = "events.iterate.com/device/notification-settled";
const TICKET = "events.iterate.com/device/notification-ticket-observed";
const STARTED = "events.iterate.com/device/notification-attempt-started";
const REVOKED = "events.iterate.com/device/revoked";

// -----------------------------------------------------------------------------
// The generic harness plus the device's Expo gateway: a mutable box the test
// rewires mid-scenario (hang a send, script a receipt), with every send call
// and credential clear recorded, and every receipt-alarm repoint captured.
// -----------------------------------------------------------------------------

type ReceiptAnswer =
  | { status: "pending" }
  | { status: "accepted-by-push-service" }
  | { status: "rejected-by-push-service"; error: string; message: string };

function makeDeviceHarness(substrate?: HarnessSubstrate) {
  const gateway: {
    send: DevicePushSender;
    getReceipt: (ticketId: string) => Promise<ReceiptAnswer>;
    clearPushToken: (input: {
      pushTokenSecretPath: string;
      pushTokenSecretUpdatedOffset: number;
    }) => Promise<boolean>;
  } = {
    send: async () => ({ status: "ok", ticketId: "ticket-123" }),
    getReceipt: async () => ({ status: "pending" }),
    clearPushToken: async () => true,
  };
  const sent: Parameters<DevicePushSender>[0][] = [];
  const clearedTokens: { pushTokenSecretPath: string; pushTokenSecretUpdatedOffset: number }[] = [];
  const receiptAlarms: (number | null)[] = [];
  const base =
    substrate ??
    (() => {
      const clock = { now: Date.parse("2026-07-18T08:00:00Z") };
      const network = new MemoryStreamNetwork(() => clock.now);
      return { clock, stream: network.get("/devices/phone"), progress: makeMemoryProgressStore() };
    })();
  const harness = makeProcessorHarness<DeviceProcessorContract, DeviceProcessor>({
    createProcessor: (deps) =>
      new DeviceProcessor({
        ...deps,
        projectId: "prj_test",
        send: async (input) => {
          sent.push(input);
          return gateway.send(input);
        },
        getReceipt: (ticketId) => gateway.getReceipt(ticketId),
        clearPushToken: async (input) => {
          clearedTokens.push(input);
          return gateway.clearPushToken(input);
        },
        repointReceiptAlarm: async (atMs) => {
          receiptAlarms.push(atMs);
        },
      }),
    substrate: base,
  });
  return {
    ...harness,
    gateway,
    sent,
    clearedTokens,
    receiptAlarms,
    rootEvents: () => harness.stream.network!.eventsAt("/"),
    checkReceipts: () => harness.processor().checkReceipts(harness.state()),
  };
}

// =============================================================================
// Birth and the project-root cross-posts
// =============================================================================

describe("DeviceProcessor enrollment", () => {
  it("created cross-posts the catalog fact and arms the notification-intent subscription on the root stream", async () => {
    const h = makeDeviceHarness();
    await h.play(["append", DEVICE_CREATED]);

    expect(h.state()).toMatchObject({
      birthCertificate: DEVICE_CREATED.payload,
      pushTokenSecret: {
        path: "/secrets/devices/phone/expo-push-token",
        updatedOffset: 1,
      },
      revokedAt: null,
      tokenUpdatedOffset: 1,
    });
    expect(h.rootEvents()).toMatchObject([
      { type: "events.iterate.com/device/created", payload: DEVICE_CREATED.payload },
      {
        type: "events.iterate.com/stream/subscription-configured",
        payload: {
          subscriptionKey: "notification-intent:/devices/phone",
          selector: { eventTypes: ["events.iterate.com/notification/requested"] },
          delivery: {
            mode: "push",
            expression: ["streams", ["get", "/devices/phone"], "acceptCrossPost"],
          },
          deliver: "new",
        },
      },
    ]);
  });

  it("ignores a second birth certificate during reduction", async () => {
    const h = makeDeviceHarness();
    await h.play(["append", DEVICE_CREATED, DEVICE_CREATED]);
    expect(h.state().birthCertificate).toEqual(DEVICE_CREATED.payload);
  });

  it("push-token-updated replaces the credential, clears a revocation, and re-arms the subscription", async () => {
    const h = makeDeviceHarness();
    await h.play([
      "append",
      DEVICE_CREATED,
      { type: "events.iterate.com/device/revoked", payload: { reason: "sign-out" } },
      {
        type: "events.iterate.com/device/push-token-updated",
        payload: {
          appVersion: "1.1.0",
          label: "Misha's iPhone",
          notificationsStatus: "granted",
          ownerId: "usr_misha",
          pushTokenSecretPath: "/secrets/devices/phone/expo-push-token",
          pushTokenSecretUpdatedOffset: 7,
        },
      },
    ]);

    expect(h.state()).toMatchObject({
      birthCertificate: {
        // platform is immutable; everything else tracks the update.
        config: { appVersion: "1.1.0", platform: "ios", pushTokenSecretUpdatedOffset: 7 },
      },
      pushTokenSecret: {
        path: "/secrets/devices/phone/expo-push-token",
        updatedOffset: 7,
      },
      revokedAt: null,
      tokenUpdatedOffset: 3,
    });
    // The revocation removed the intent subscription; the token update
    // re-armed it (a fresh event — the cross-post key carries the offset).
    expect(h.rootEvents().map((event) => event.type)).toEqual([
      "events.iterate.com/device/created",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-removed",
      "events.iterate.com/stream/subscription-configured",
    ]);
  });
});

// =============================================================================
// The send obligation: evidence, dial, ticket
// =============================================================================

describe("DeviceProcessor push attempts", () => {
  it("a notification request becomes one attempt: durable started evidence BEFORE the Expo dial, then the ticket", async () => {
    const h = makeDeviceHarness();
    h.gateway.send = async () => {
      // The doctrine's ordering: when Expo is dialed, the attempt-started
      // evidence is already committed.
      expect(h.events(STARTED)).toHaveLength(1);
      return { status: "ok", ticketId: "ticket-123" };
    };
    await h.play([
      "append",
      DEVICE_CREATED,
      notificationRequested({ idempotencyKey: "buy-milk-at-supermarket:v1" }),
    ]);

    expect(h.sent).toEqual([
      {
        notification: {
          body: "Buy milk",
          data: { destination: { kind: "project" }, projectId: "prj_test", requestOffset: 2 },
          expiresAt: Date.parse("2026-07-18T08:05:00Z"),
          title: "Reminder",
        },
        pushTokenSecretPath: "/secrets/devices/phone/expo-push-token",
        pushTokenSecretUpdatedOffset: 1,
      },
    ]);
    expect(h.events().map((event) => event.type)).toEqual([
      "events.iterate.com/device/created",
      "events.iterate.com/device/notification-requested",
      STARTED,
      TICKET,
    ]);
    expect(h.events(TICKET)[0]).toMatchObject({
      idempotencyKey: "device/notification-ticket-observed@2",
      payload: { requestOffset: 2, ticketId: "ticket-123" },
    });
    // The ticketed obligation scheduled its first receipt check.
    expect(h.receiptAlarms.at(-1)).toBe(
      Date.parse("2026-07-18T08:00:00Z") + h.state().config.receiptCheckDelayMs,
    );
  });

  it("a cross-posted project notification intent becomes this device's push obligation", async () => {
    const h = makeDeviceHarness();
    h.gateway.send = async () => ({ status: "ok", ticketId: "ticket-intent" });
    await h.play([
      "append",
      DEVICE_CREATED,
      {
        type: "events.iterate.com/notification/requested",
        payload: {
          audience: { kind: "project" },
          body: "POST api.stripe.com is waiting for approval.",
          destination: { kind: "approvals", approvalRequestEventOffset: 17 },
          expiresAt: Date.parse("2026-07-18T08:05:00Z"),
          title: "Approval needed",
        },
      },
    ]);

    expect(h.sent).toMatchObject([
      {
        notification: {
          body: "POST api.stripe.com is waiting for approval.",
          data: { destination: { kind: "approvals", approvalRequestEventOffset: 17 } },
        },
      },
    ]);
    expect(h.events(TICKET)).toHaveLength(1);
  });

  it("retrying the same public append dedupes: one requested event, one Expo dial", async () => {
    const h = makeDeviceHarness();
    const request = notificationRequested({ idempotencyKey: "one-logical-reminder" });
    await h.play(["append", DEVICE_CREATED, request], ["append", request]);

    expect(h.sent).toHaveLength(1);
    expect(h.events("events.iterate.com/device/notification-requested")).toHaveLength(1);
    expect(h.events(TICKET)).toHaveLength(1);
  });
});

// =============================================================================
// Settlements the at-head pass derives from state
// =============================================================================

describe("DeviceProcessor settlements", () => {
  it("an expired request settles without contacting Expo", async () => {
    const h = makeDeviceHarness();
    h.gateway.send = async () => {
      throw new Error("Expo must not be dialed for an expired request");
    };
    // Deadline 08:05; move the clock past the horizon before the request
    // ever reaches the processor.
    await h.play(
      ["append", DEVICE_CREATED],
      ["advanceTime", 10 * 60_000],
      ["append", notificationRequested()],
    );

    expect(h.sent).toHaveLength(0);
    expect(h.events(SETTLED)).toMatchObject([
      {
        idempotencyKey: "device/notification-settled@2",
        payload: { requestOffset: 2, outcome: { kind: "expired" } },
      },
    ]);
    expect(h.state().notifications).toEqual({});
  });

  it("a request arriving after revocation settles device-unavailable, and the intent subscription was removed", async () => {
    const h = makeDeviceHarness();
    h.gateway.send = async () => {
      throw new Error("a revoked device must not dial Expo");
    };
    await h.play([
      "append",
      DEVICE_CREATED,
      { type: "events.iterate.com/device/revoked", payload: { reason: "sign-out" } },
      notificationRequested(),
    ]);

    expect(h.sent).toHaveLength(0);
    expect(h.events(SETTLED)).toMatchObject([
      { payload: { requestOffset: 3, outcome: { kind: "device-unavailable" } } },
    ]);
    expect(h.state()).toMatchObject({
      pushTokenSecret: null,
      revokedAt: expect.any(String),
    });
    expect(h.rootEvents().at(-1)).toMatchObject({
      type: "events.iterate.com/stream/subscription-removed",
      payload: { subscriptionKey: "notification-intent:/devices/phone" },
    });
  });

  it("an attempt orphaned by an eviction settles uncertain on revival and is never re-sent", async () => {
    const h = makeDeviceHarness();
    // The Expo dial parks forever: attempt-started commits, no answer comes.
    h.gateway.send = () => new Promise<never>(() => {});
    await h.play(["append", DEVICE_CREATED, notificationRequested()]);
    expect(h.events(STARTED)).toHaveLength(1);
    expect(h.sent).toHaveLength(1);

    // The incarnation dies mid-dial; the successor's revival turn finds a
    // started obligation nobody is driving. Expo may have accepted the push,
    // so it settles uncertain instead of ringing the phone twice.
    await h.play(["crash"], ["append", REVIVED]);

    expect(h.sent).toHaveLength(1); // no second dial, ever
    expect(h.events(SETTLED)).toMatchObject([
      {
        payload: {
          requestOffset: 2,
          outcome: {
            kind: "uncertain",
            phase: "expo-send",
            reason: expect.stringContaining("incarnation"),
          },
        },
      },
    ]);
  });

  it("notification-opened reduces the engagement timestamp", async () => {
    const h = makeDeviceHarness();
    await h.play([
      "append",
      DEVICE_CREATED,
      notificationRequested(),
      {
        type: "events.iterate.com/device/notification-opened",
        payload: { openedAt: "2026-07-18T08:01:30.000Z", requestOffset: 2 },
      },
    ]);
    expect(h.state().lastNotificationOpenedAt).toBe("2026-07-18T08:01:30.000Z");
  });
});

// =============================================================================
// Credential death: DeviceNotRegistered at send time
// =============================================================================

describe("DeviceProcessor send rejections", () => {
  it("an Expo DeviceNotRegistered rejection clears the credential, revokes the device, and settles the request", async () => {
    const h = makeDeviceHarness();
    h.gateway.send = async () => ({
      status: "error",
      error: "DeviceNotRegistered",
      message: "The device is no longer registered",
    });
    await h.play(["append", DEVICE_CREATED, notificationRequested()]);

    expect(h.clearedTokens).toEqual([
      {
        pushTokenSecretPath: "/secrets/devices/phone/expo-push-token",
        pushTokenSecretUpdatedOffset: 1,
      },
    ]);
    expect(h.events(REVOKED)).toMatchObject([{ payload: { reason: "push-token-invalid" } }]);
    expect(h.events(SETTLED)).toMatchObject([
      {
        payload: {
          requestOffset: 2,
          outcome: {
            kind: "rejected-by-expo",
            error: "DeviceNotRegistered",
            message: "The device is no longer registered",
          },
        },
      },
    ]);
  });

  it("a stale rejection cannot revoke a concurrently rotated credential (the fenced clear loses)", async () => {
    const h = makeDeviceHarness();
    h.gateway.send = async () => ({
      status: "error",
      error: "DeviceNotRegistered",
      message: "The previous token is no longer registered",
    });
    h.gateway.clearPushToken = async () => false; // a rotation won the fence
    await h.play(["append", DEVICE_CREATED, notificationRequested()]);

    expect(h.events(REVOKED)).toHaveLength(0);
    expect(h.events(SETTLED)).toMatchObject([
      { payload: { outcome: { kind: "rejected-by-expo", error: "DeviceNotRegistered" } } },
    ]);
  });
});

// =============================================================================
// Receipts: the alarm-driven second half of every ticketed obligation
// =============================================================================

describe("DeviceProcessor receipts", () => {
  it("an accepted receipt settles the obligation as push-service acceptance (never device delivery)", async () => {
    const h = makeDeviceHarness();
    h.gateway.getReceipt = async () => ({ status: "accepted-by-push-service" });
    await h.play(
      [
        "append",
        DEVICE_CREATED,
        notificationRequested({ expiresAt: Date.parse("2026-07-18T09:00:00Z") }),
      ],
      ["advanceTime", 15 * 60_000],
      () => h.checkReceipts(),
    );

    expect(h.events(SETTLED)).toMatchObject([
      {
        payload: {
          requestOffset: 2,
          outcome: { kind: "accepted-by-push-service", ticketId: "ticket-123" },
        },
      },
    ]);
    expect(h.state().notifications).toEqual({});
  });

  it("a receipt check that loses the settle race accepts the already committed outcome", async () => {
    const h = makeDeviceHarness();
    await h.play(
      [
        "append",
        DEVICE_CREATED,
        notificationRequested({ expiresAt: Date.parse("2026-07-18T09:00:00Z") }),
      ],
      ["advanceTime", 15 * 60_000],
    );
    const receiptRequested = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<ReceiptAnswer>();
    h.gateway.getReceipt = async () => {
      receiptRequested.resolve();
      return receipt.promise;
    };

    const checking = h.checkReceipts();
    await receiptRequested.promise;
    await h.stream.append({
      type: SETTLED,
      idempotencyKey: "device/notification-settled@2",
      payload: {
        requestOffset: 2,
        outcome: {
          kind: "uncertain",
          phase: "receipt",
          reason: "A sibling incarnation settled the request first.",
        },
      },
    });
    receipt.resolve({ status: "accepted-by-push-service" });

    await expect(checking).resolves.toBeUndefined();
    await h.settle();
    expect(h.events(SETTLED)).toMatchObject([
      { payload: { requestOffset: 2, outcome: { kind: "uncertain", phase: "receipt" } } },
    ]);
    expect(h.state().notifications).toEqual({});
  });

  it("one lost settle race does not drop a sibling obligation's settlement from the same check", async () => {
    const h = makeDeviceHarness();
    await h.play(
      [
        "append",
        DEVICE_CREATED,
        notificationRequested({ expiresAt: Date.parse("2026-07-18T09:00:00Z") }),
        notificationRequested({
          idempotencyKey: "device/notification-requested-2",
          expiresAt: Date.parse("2026-07-18T09:00:00Z"),
        }),
      ],
      ["advanceTime", 15 * 60_000],
    );
    // Receipts are polled sequentially, so gate on the FIRST lookup (offset
    // 2's), let the sibling settle that offset meanwhile, then release both.
    const firstReceiptRequested = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<ReceiptAnswer>();
    let receiptCalls = 0;
    h.gateway.getReceipt = async () => {
      receiptCalls += 1;
      if (receiptCalls > 1) return { status: "accepted-by-push-service" };
      firstReceiptRequested.resolve();
      return receipt.promise;
    };

    const checking = h.checkReceipts();
    await firstReceiptRequested.promise;
    await h.stream.append({
      type: SETTLED,
      idempotencyKey: "device/notification-settled@2",
      payload: {
        requestOffset: 2,
        outcome: {
          kind: "uncertain",
          phase: "receipt",
          reason: "A sibling incarnation settled the request first.",
        },
      },
    });
    receipt.resolve({ status: "accepted-by-push-service" });

    await expect(checking).resolves.toBeUndefined();
    await h.settle();
    expect(h.events(SETTLED)).toMatchObject([
      { payload: { requestOffset: 2, outcome: { kind: "uncertain", phase: "receipt" } } },
      { payload: { requestOffset: 3, outcome: { kind: "accepted-by-push-service" } } },
    ]);
    expect(h.state().notifications).toEqual({});
  });

  it("a DeviceNotRegistered receipt revokes the token before settling the request", async () => {
    const h = makeDeviceHarness();
    h.gateway.send = async () => ({ status: "ok", ticketId: "ticket-invalid" });
    h.gateway.getReceipt = async () => ({
      status: "rejected-by-push-service",
      error: "DeviceNotRegistered",
      message: "The device is no longer registered",
    });
    await h.play(
      [
        "append",
        DEVICE_CREATED,
        notificationRequested({ expiresAt: Date.parse("2026-07-18T09:00:00Z") }),
      ],
      ["advanceTime", 15 * 60_000],
      () => h.checkReceipts(),
    );

    expect(h.clearedTokens).toEqual([
      {
        pushTokenSecretPath: "/secrets/devices/phone/expo-push-token",
        pushTokenSecretUpdatedOffset: 1,
      },
    ]);
    expect(h.events().slice(-2)).toMatchObject([
      { type: REVOKED, payload: { reason: "push-token-invalid" } },
      {
        type: SETTLED,
        payload: {
          requestOffset: 2,
          outcome: { kind: "rejected-by-push-service", error: "DeviceNotRegistered" },
        },
      },
    ]);
  });

  it("a pending receipt re-arms the retry alarm; past Expo's retention window it settles uncertain", async () => {
    const h = makeDeviceHarness();
    h.gateway.getReceipt = async () => ({ status: "pending" });
    await h.play(
      [
        "append",
        DEVICE_CREATED,
        notificationRequested({ expiresAt: Date.parse("2026-07-18T09:00:00Z") }),
      ],
      ["advanceTime", 15 * 60_000],
      () => h.checkReceipts(),
    );

    // Still pending: no settlement, the next poll is one check-delay out.
    expect(h.events(SETTLED)).toHaveLength(0);
    expect(h.receiptAlarms.at(-1)).toBe(h.clock.now + h.state().config.receiptCheckDelayMs);

    await h.play(["advanceTime", 24 * 60 * 60_000], () => h.checkReceipts());
    expect(h.events(SETTLED)).toMatchObject([
      {
        payload: {
          requestOffset: 2,
          outcome: { kind: "uncertain", phase: "receipt", reason: expect.stringContaining("24") },
        },
      },
    ]);
    // Nothing ticketed remains, so the alarm disarms.
    expect(h.receiptAlarms.at(-1)).toBeNull();
  });
});

// =============================================================================
// Replay determinism
// =============================================================================

describe("DeviceProcessor replay", () => {
  it("a full replay (fresh cursor over the same stream) re-dials no vendor and appends nothing", async () => {
    // The harshest at-least-once redelivery: a fresh progress store replays
    // every event, so every per-event cross-post re-appends (and must dedupe
    // byte-identically) and the at-head pass re-derives over settled state
    // (and must find nothing to do).
    const h = makeDeviceHarness();
    h.gateway.getReceipt = async () => ({ status: "accepted-by-push-service" });
    await h.play(
      [
        "append",
        DEVICE_CREATED,
        notificationRequested({ expiresAt: Date.parse("2026-07-18T09:00:00Z") }),
      ],
      ["advanceTime", 15 * 60_000],
      () => h.checkReceipts(),
    );
    const deviceOffsets = h.events().map((event) => event.offset);
    const rootOffsets = h.rootEvents().map((event) => event.offset);

    const replay = makeDeviceHarness({
      clock: h.clock,
      stream: h.stream,
      progress: makeMemoryProgressStore(),
    });
    replay.gateway.send = async () => {
      throw new Error("a replay must not dial Expo");
    };
    await replay.settle();

    expect(replay.sent).toHaveLength(0);
    expect(replay.clearedTokens).toHaveLength(0);
    expect(replay.events().map((event) => event.offset)).toEqual(deviceOffsets);
    expect(replay.rootEvents().map((event) => event.offset)).toEqual(rootOffsets);
    expect(replay.state()).toEqual(h.state());
  });
});
