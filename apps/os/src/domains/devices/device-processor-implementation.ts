import { StreamProcessor } from "iterate/processors";
import type { EmittedInput, ProcessEventArgs, ReduceArgs } from "iterate/processors";
import {
  DeviceProcessorContract,
  type DeviceNotificationOutcome,
  type DeviceProcessorState,
} from "./device-processor-contract.ts";

/**
 * One enrolled mobile installation and its push-notification obligations.
 *
 * HOW IT WORKS, end to end:
 *
 * Enrollment happens in the device Durable Object: it stores the Expo push
 * token in a write-only Secret and appends `device/created` carrying only the
 * Secret's path and update offset — the token never rides this stream. The
 * created event's per-event lane cross-posts the birth fact to the project
 * root stream (the catalog the project processor lists devices from) and
 * configures a notification-intent subscription there, so every project-level
 * `notification/requested` intent is copied onto this device stream.
 * `push-token-updated` re-arms that subscription (re-enrollment also clears a
 * standing revocation); `device/revoked` removes it.
 *
 * A push obligation opens when a `device/notification-requested` (direct) or
 * `notification/requested` (cross-posted intent) event reduces into
 * `state.notifications`, keyed by the requesting event's OFFSET — the
 * obligation's identity; there are no synthetic ids anywhere, and every later
 * fact points back with that requestOffset.
 *
 * All sending is state-derived: the at-head pass in `processEvent` walks the
 * open obligations and, for each `requested` entry with a live credential and
 * time on the clock, appends `notification-attempt-started` (durable evidence,
 * BEFORE the vendor is dialed), dials Expo, and records the returned receipt
 * ticket as `notification-ticket-observed`. A ticket is Expo accepting the
 * payload, not delivery — the receipt check later resolves what APNs/FCM did.
 * The same pass settles what can no longer be attempted: `requested` past its
 * `expiresAt` settles expired; `requested` with no credential settles
 * device-unavailable; `started` with nobody in this incarnation's live-set
 * settles uncertain (the incarnation died mid-attempt and Expo may have
 * accepted the push, so it is deliberately NOT retried). Every settlement is
 * idempotency-keyed on the requestOffset, so the expiry sweep, the send path,
 * and the receipt check collapse to one terminal fact.
 *
 * Receipts run outside delivery: the at-head pass points the Durable Object's
 * alarm slice at the earliest due check (`ticketObservedAt` +
 * `config.receiptCheckDelayMs`), and the DO's alarm calls `checkReceipts` with
 * the current state. An accepted/rejected receipt settles the obligation; a
 * pending one re-arms the alarm; past `config.receiptRetentionMs` the outcome
 * is permanently unknowable and settles uncertain. A DeviceNotRegistered
 * answer — from the send call or a receipt — compare-and-clears the push-token
 * Secret at the credential revision the attempt was made with
 * (`pushTokenSecretUpdatedOffset`), so a stale rejection can never erase a
 * credential rotated while the attempt was in flight; only a successful clear
 * appends `device/revoked`.
 *
 * Recovery is the standard shape: the DO registers this processor with
 * recovery, so an incarnation that dies owing background work gets a
 * `stream/processor-revived` fact whose ordinary at-head delivery re-runs the
 * state-derived pass — orphaned attempts settle, still-runnable requests
 * start, the receipt alarm re-arms.
 */
export class DeviceProcessor extends StreamProcessor<DeviceProcessorContract, DeviceProcessorDeps> {
  readonly contract = DeviceProcessorContract;

  /**
   * RUNTIME state: the requestOffsets THIS incarnation is currently sending,
   * in-memory, dead with every eviction — and that is fine: the durable truth
   * is the attempt-started fact, and the at-head pass settles a `started`
   * obligation nobody here is driving as uncertain instead of re-dialing Expo.
   */
  readonly #liveSendAttempts = new Set<number>();

  // ------------------------------------------------------------ processEvent
  // The side-effect lanes are chosen HERE, at the dispatch site, never inside
  // helpers:
  //
  // - PER-EVENT consequences (the created/updated/revoked cross-posts to the
  //   project root stream) use `blockProcessorWhile`: each rides an event
  //   delivered once — a dropped append would lose the catalog entry or leave
  //   the intent subscription wrong forever.
  // - STATE-DERIVED consequences (everything under `delivery.caughtUp`) use
  //   `runInBackground`: any later at-head delivery re-derives them from the
  //   same reduced state, and the recovery revival guarantees such a delivery
  //   after an eviction.
  protected override processEvent(args: ProcessEventArgs<DeviceProcessorContract>): undefined {
    const { event, state, delivery, blockProcessorWhile, runInBackground, append, appendTo } = args;

    switch (event?.type) {
      case "events.iterate.com/device/created":
        blockProcessorWhile(() =>
          appendTo(
            "/",
            {
              type: "events.iterate.com/device/created",
              idempotencyKey: this.idempotencyKey("catalog-created", event),
              payload: event.payload,
            },
            notificationIntentCrossPost({
              idempotencyKey: this.idempotencyKey("notification-intent-cross-post", event),
              path: this.path,
            }),
          ),
        );
        break;
      case "events.iterate.com/device/push-token-updated":
        blockProcessorWhile(() =>
          appendTo(
            "/",
            notificationIntentCrossPost({
              idempotencyKey: this.idempotencyKey("notification-intent-cross-post", event),
              path: this.path,
            }),
          ),
        );
        break;
      case "events.iterate.com/device/revoked":
        blockProcessorWhile(() =>
          appendTo("/", {
            type: "events.iterate.com/stream/subscription-removed",
            idempotencyKey: this.idempotencyKey("notification-intent-cross-post-removed", event),
            payload: { subscriptionKey: `notification-intent:${this.path}` },
          }),
        );
        break;
      // notification-requested / attempt-started / ticket-observed / settled /
      // opened / processor-revived: no per-event effect — they matter through
      // the reduced state below.
    }

    // ---------------------------------------- state-derived side effects
    // Plain code over the reduced state, after every delivery. Act only at
    // head — behind it the state is partial and settlements may sit in pages
    // not yet replayed.
    if (!delivery.caughtUp || state.birthCertificate === null) return;
    const { pushTokenSecretPath, pushTokenSecretUpdatedOffset } = state;

    // Settle what can no longer be attempted. Whether an orphaned `started`
    // attempt fails or re-drives is a domain decision: pushes fail-uncertain,
    // because Expo may have accepted the original and a retry would ring the
    // user's phone twice.
    const settlements: { requestOffset: number; outcome: DeviceNotificationOutcome }[] = [];
    for (const [offset, notification] of Object.entries(state.notifications)) {
      const requestOffset = Number(offset);
      if (notification.status === "requested" && notification.expiresAt <= this.deps.now()) {
        settlements.push({ requestOffset, outcome: { kind: "expired" } });
      } else if (notification.status === "requested" && pushTokenSecretPath === null) {
        settlements.push({ requestOffset, outcome: { kind: "device-unavailable" } });
      } else if (notification.status === "started" && !this.#liveSendAttempts.has(requestOffset)) {
        settlements.push({
          requestOffset,
          outcome: {
            kind: "uncertain",
            phase: "expo-send",
            reason:
              "The processor incarnation disappeared after recording the attempt start; Expo may have accepted the push, so it was not retried.",
          },
        });
      }
    }
    // Ticketed obligations wait for their Expo receipt outside delivery: point
    // the Durable Object's alarm at the earliest due check.
    const nextReceiptCheck = Object.values(state.notifications)
      .filter(
        (notification) =>
          notification.status === "ticketed" && notification.ticketObservedAt !== undefined,
      )
      .reduce<number | null>((earliest, notification) => {
        const at = notification.ticketObservedAt! + state.config.receiptCheckDelayMs;
        return earliest === null || at < earliest ? at : earliest;
      }, null);
    if (settlements.length > 0 || nextReceiptCheck !== null) {
      runInBackground(async () => {
        if (settlements.length > 0) {
          // Race-tolerant: the alarm-driven receipt check (or a raced sibling
          // pass) may settle the same requestOffset with a different outcome
          // first — the first-committed settlement stands, and once it reduces
          // the obligation is gone from state, so nothing re-derives here.
          await this.#appendUnlessLostIdempotencyRace(
            append,
            settlements.map(({ outcome, requestOffset }) => ({
              type: "events.iterate.com/device/notification-settled" as const,
              idempotencyKey: this.idempotencyKey(`notification-settled@${requestOffset}`),
              payload: { requestOffset, outcome },
            })),
          );
        }
        if (nextReceiptCheck !== null) {
          await this.deps.repointReceiptAlarm(nextReceiptCheck);
        }
      });
    }

    // Start a send attempt for every runnable `requested` obligation nobody
    // in this incarnation is already driving. The live-set entry is taken
    // SYNCHRONOUSLY, before any await, so the same pass never classifies its
    // own attempt as orphaned.
    if (
      pushTokenSecretPath === null ||
      pushTokenSecretUpdatedOffset === null ||
      this.projectId === null
    )
      return;
    for (const [offset, notification] of Object.entries(state.notifications)) {
      const requestOffset = Number(offset);
      if (
        notification.status !== "requested" ||
        notification.expiresAt <= this.deps.now() ||
        this.#liveSendAttempts.has(requestOffset)
      ) {
        continue;
      }
      this.#liveSendAttempts.add(requestOffset);
      runInBackground(() =>
        this.#sendNotification({
          notification,
          pushTokenSecretPath,
          pushTokenSecretUpdatedOffset,
          requestOffset,
        }),
      );
    }
  }

  // ------------------------------------------------------------------ reduce
  // Pure, one switch, cases inline.
  protected override reduce({ event, state }: ReduceArgs<DeviceProcessorContract>) {
    switch (event.type) {
      case "events.iterate.com/device/created":
        // Duplicate birth facts must not wedge an already-committed frame.
        // Conflicting create retries fail earlier at stream idempotency.
        if (state.birthCertificate !== null) return state;
        return {
          ...state,
          birthCertificate: event.payload,
          pushTokenSecretPath: event.payload.config.pushTokenSecretPath,
          pushTokenSecretUpdatedOffset: event.payload.config.pushTokenSecretUpdatedOffset,
          tokenUpdatedOffset: event.offset,
        };
      case "events.iterate.com/device/push-token-updated":
        return {
          ...state,
          // The birth certificate tracks the CURRENT enrollment: every field
          // replaced except the immutable platform.
          birthCertificate:
            state.birthCertificate === null
              ? null
              : {
                  config: {
                    appVersion: event.payload.appVersion,
                    label: event.payload.label,
                    notificationsStatus: event.payload.notificationsStatus,
                    ownerId: event.payload.ownerId,
                    platform: state.birthCertificate.config.platform,
                    pushTokenSecretPath: event.payload.pushTokenSecretPath,
                    pushTokenSecretUpdatedOffset: event.payload.pushTokenSecretUpdatedOffset,
                  },
                },
          pushTokenSecretPath: event.payload.pushTokenSecretPath,
          pushTokenSecretUpdatedOffset: event.payload.pushTokenSecretUpdatedOffset,
          // Re-enrollment: a fresh credential un-revokes the device.
          revokedAt: null,
          tokenUpdatedOffset: event.offset,
        };
      case "events.iterate.com/device/revoked":
        return {
          ...state,
          pushTokenSecretPath: null,
          pushTokenSecretUpdatedOffset: null,
          revokedAt: event.createdAt,
        };
      case "events.iterate.com/device/notification-requested":
      case "events.iterate.com/notification/requested":
        // Both doors open the same obligation slot, keyed by the requesting
        // event's offset. The intent's extra fields (audience) are project
        // routing, not device concerns — only the request core is kept.
        return {
          ...state,
          notifications: {
            ...state.notifications,
            [event.offset]: {
              body: event.payload.body,
              destination: event.payload.destination,
              expiresAt: event.payload.expiresAt,
              title: event.payload.title,
              status: "requested" as const,
            },
          },
        };
      case "events.iterate.com/device/notification-attempt-started": {
        const notification = state.notifications[event.payload.requestOffset];
        if (notification === undefined) return state;
        return {
          ...state,
          notifications: {
            ...state.notifications,
            [event.payload.requestOffset]: { ...notification, status: "started" as const },
          },
        };
      }
      case "events.iterate.com/device/notification-ticket-observed": {
        const notification = state.notifications[event.payload.requestOffset];
        if (notification === undefined) return state;
        return {
          ...state,
          notifications: {
            ...state.notifications,
            [event.payload.requestOffset]: {
              ...notification,
              status: "ticketed" as const,
              ticketId: event.payload.ticketId,
              ticketObservedAt: Date.parse(event.createdAt),
            },
          },
        };
      }
      case "events.iterate.com/device/notification-settled": {
        // Terminal: the obligation leaves the state entirely.
        const notifications = { ...state.notifications };
        delete notifications[event.payload.requestOffset];
        return { ...state, notifications };
      }
      case "events.iterate.com/device/notification-opened":
        return { ...state, lastNotificationOpenedAt: event.payload.openedAt };
      default:
        // stream/processor-revived: consumed only for its delivery turn.
        return state;
    }
  }

  /**
   * Poll Expo receipts for every ticketed obligation whose check is due —
   * called by the device Durable Object's alarm with the current state, never
   * from delivery. An accepted/rejected receipt settles the obligation
   * (DeviceNotRegistered additionally compare-and-clears the push-token Secret
   * and, if the clear won, revokes the device); a pending receipt re-arms the
   * alarm; past the retention window the outcome settles uncertain. Errors
   * propagate to the DO, which re-arms a retry alarm.
   */
  async checkReceipts(state: DeviceProcessorState): Promise<void> {
    const now = this.deps.now();
    const settlements: { requestOffset: number; outcome: DeviceNotificationOutcome }[] = [];
    let pushTokenInvalid = false;
    let nextCheckAt: number | null = null;
    for (const [offset, notification] of Object.entries(state.notifications)) {
      if (
        notification.status !== "ticketed" ||
        notification.ticketId === undefined ||
        notification.ticketObservedAt === undefined
      ) {
        continue;
      }
      const firstCheckAt = notification.ticketObservedAt + state.config.receiptCheckDelayMs;
      if (now < firstCheckAt) {
        nextCheckAt = nextCheckAt === null ? firstCheckAt : Math.min(nextCheckAt, firstCheckAt);
        continue;
      }
      const receipt = await this.deps.getReceipt(notification.ticketId);
      const requestOffset = Number(offset);
      if (receipt.status === "accepted-by-push-service") {
        settlements.push({
          requestOffset,
          outcome: { kind: "accepted-by-push-service", ticketId: notification.ticketId },
        });
      } else if (receipt.status === "rejected-by-push-service") {
        pushTokenInvalid ||= receipt.error === "DeviceNotRegistered";
        settlements.push({
          requestOffset,
          outcome: {
            kind: "rejected-by-push-service",
            error: receipt.error,
            message: receipt.message,
            ticketId: notification.ticketId,
          },
        });
      } else if (now >= notification.ticketObservedAt + state.config.receiptRetentionMs) {
        settlements.push({
          requestOffset,
          outcome: {
            kind: "uncertain",
            phase: "receipt",
            reason: "Expo did not produce a push receipt before its 24-hour retention window.",
          },
        });
      } else {
        const retryAt = now + state.config.receiptCheckDelayMs;
        nextCheckAt = nextCheckAt === null ? retryAt : Math.min(nextCheckAt, retryAt);
      }
    }
    // The clear is fenced on the credential revision the attempts were made
    // with: a rotation that landed meanwhile makes it a no-op, and only a
    // WINNING clear may revoke the device.
    const pushTokenInvalidated =
      pushTokenInvalid && state.pushTokenSecretPath !== null
        ? await this.deps.clearPushToken({
            pushTokenSecretPath: state.pushTokenSecretPath,
            pushTokenSecretUpdatedOffset: state.pushTokenSecretUpdatedOffset!,
          })
        : false;
    if (pushTokenInvalid || settlements.length > 0) {
      await this.append(
        ...(pushTokenInvalidated
          ? [
              {
                type: "events.iterate.com/device/revoked" as const,
                idempotencyKey: this.idempotencyKey("push-token-invalid"),
                payload: { reason: "push-token-invalid" as const },
              },
            ]
          : []),
        ...settlements.map(({ outcome, requestOffset }) => ({
          type: "events.iterate.com/device/notification-settled" as const,
          idempotencyKey: this.idempotencyKey(`notification-settled@${requestOffset}`),
          payload: { requestOffset, outcome },
        })),
      );
    }
    await this.deps.repointReceiptAlarm(nextCheckAt);
  }

  /**
   * One send attempt: durable attempt-started evidence FIRST (if that append
   * fails, the body never runs and the obligation stays `requested` for a
   * later pass), then the Expo dial, then the outcome — a receipt ticket, or
   * a rejection settled immediately (DeviceNotRegistered compare-and-clears
   * the credential and, if the clear won, revokes the device). The live-set
   * entry is released in `finally` either way, or this incarnation would skip
   * the requestOffset forever.
   */
  async #sendNotification(input: {
    notification: DeviceProcessorState["notifications"][string];
    pushTokenSecretPath: string;
    pushTokenSecretUpdatedOffset: number;
    requestOffset: number;
  }) {
    try {
      await this.append({
        type: "events.iterate.com/device/notification-attempt-started",
        idempotencyKey: this.idempotencyKey(`notification-attempt-started@${input.requestOffset}`),
        payload: { requestOffset: input.requestOffset },
      });
      const ticket = await this.deps.send({
        notification: {
          body: input.notification.body,
          data: {
            destination: input.notification.destination,
            projectId: this.projectId!,
            requestOffset: input.requestOffset,
          },
          expiresAt: input.notification.expiresAt,
          title: input.notification.title,
        },
        pushTokenSecretPath: input.pushTokenSecretPath,
        pushTokenSecretUpdatedOffset: input.pushTokenSecretUpdatedOffset,
      });
      if (ticket.status === "error") {
        const pushTokenInvalidated =
          ticket.error === "DeviceNotRegistered"
            ? await this.deps.clearPushToken({
                pushTokenSecretPath: input.pushTokenSecretPath,
                pushTokenSecretUpdatedOffset: input.pushTokenSecretUpdatedOffset,
              })
            : false;
        await this.append(
          ...(pushTokenInvalidated
            ? [
                {
                  type: "events.iterate.com/device/revoked" as const,
                  idempotencyKey: this.idempotencyKey("push-token-invalid"),
                  payload: { reason: "push-token-invalid" as const },
                },
              ]
            : []),
          {
            type: "events.iterate.com/device/notification-settled",
            idempotencyKey: this.idempotencyKey(`notification-settled@${input.requestOffset}`),
            payload: {
              requestOffset: input.requestOffset,
              outcome: {
                kind: "rejected-by-expo",
                error: ticket.error,
                message: ticket.message,
              },
            },
          },
        );
        return;
      }
      await this.append({
        type: "events.iterate.com/device/notification-ticket-observed",
        idempotencyKey: this.idempotencyKey(`notification-ticket-observed@${input.requestOffset}`),
        payload: { requestOffset: input.requestOffset, ticketId: ticket.ticketId },
      });
    } finally {
      this.#liveSendAttempts.delete(input.requestOffset);
    }
  }

  /**
   * Append a batch whose idempotency keys may race concurrent writers: every
   * writer of `notification-settled@<offset>` (expiry sweep, send rejection,
   * receipt check) races every other. The stream rejects a same-key append
   * with a different body; the FIRST writer's settlement stands, and losing
   * the race is success — the obligation is settled either way.
   */
  async #appendUnlessLostIdempotencyRace(
    append: ProcessEventArgs<DeviceProcessorContract>["append"],
    events: EmittedInput<DeviceProcessorContract>[],
  ): Promise<void> {
    try {
      await append(...events);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/idempotency key .* already names a different event/.test(message)) throw error;
    }
  }
}

// -----------------------------------------------------------------------------
// Injected dependencies.
// -----------------------------------------------------------------------------

/** What one Expo push carries; `data` is what the app receives on tap. */
export type DevicePushMessage = {
  body: string;
  data: {
    destination: DeviceProcessorState["notifications"][string]["destination"];
    projectId: string;
    requestOffset: number;
  };
  expiresAt: number;
  title: string;
};

/**
 * The injected Expo send transport — the processor's only send-side vendor
 * surface, so tests swap in a scripted fake. The Secret coordinates ride
 * along because the REAL sender substitutes the token material at the egress
 * door, fenced on the credential revision.
 */
export type DevicePushSender = (input: {
  notification: DevicePushMessage;
  pushTokenSecretPath: string;
  pushTokenSecretUpdatedOffset: number;
}) => Promise<
  { status: "ok"; ticketId: string } | { status: "error"; error: string; message: string }
>;

/** Expo's receipt answer for one ticket. */
type DevicePushReceipt =
  | { status: "pending" }
  | { status: "accepted-by-push-service" }
  | { status: "rejected-by-push-service"; error: string; message: string };

type DeviceProcessorDeps = {
  /**
   * Compare-and-clear the push-token Secret's material at the given update
   * offset; answers whether THIS clear destroyed it (false = a rotation won).
   */
  clearPushToken: (input: {
    pushTokenSecretPath: string;
    pushTokenSecretUpdatedOffset: number;
  }) => Promise<boolean>;
  /** Poll Expo's receipt API for one ticket. */
  getReceipt: (ticketId: string) => Promise<DevicePushReceipt>;
  /** Injectable clock — virtual time in tests, real time in the DO. */
  now: () => number;
  /** Point the DO's receipt alarm slice at an epoch ms, or disarm with null. */
  repointReceiptAlarm: (atMs: number | null) => Promise<void>;
  send: DevicePushSender;
};

// -----------------------------------------------------------------------------
// Pure helpers.
// -----------------------------------------------------------------------------

/**
 * The notification-intent subscription on the project root stream: copies
 * every project-level `notification/requested` intent onto this device's
 * stream, where it reduces into a push obligation. Keyed per device path, so
 * created/updated re-arms converge on one subscription.
 */
function notificationIntentCrossPost(input: { idempotencyKey: string; path: string }) {
  return {
    type: "events.iterate.com/stream/subscription-configured" as const,
    idempotencyKey: input.idempotencyKey,
    payload: {
      subscriptionKey: `notification-intent:${input.path}`,
      description: `Copies project notification intents to ${input.path} for device-owned delivery.`,
      selector: { eventTypes: ["events.iterate.com/notification/requested"] },
      delivery: {
        mode: "push" as const,
        expression: ["streams", ["get", input.path], "acceptCrossPost"],
      },
      deliver: "new" as const,
    },
  };
}
