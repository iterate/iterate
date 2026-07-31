// Past notifications for THIS device, reduced from the device stream's own
// events. The device processor journals the whole obligation there: the
// requesting event (a direct device request or a copied project intent) opens
// a row, attempt/ticket facts advance it, and the terminal settled fact fixes
// its outcome — including `suppressed`, the "already on screen"
// status the in-thread approval claim produces. Pure reduction, same shape as
// chat.ts/approvals.ts: the screen derives rows from its live query data.

import type { StreamEvent } from "iterate/sdk/itx/react";
import type { PushNotificationData } from "./notification-routing.ts";

export const DEVICE_NOTIFICATION_EVENT_TYPES = [
  "events.iterate.com/device/notification-requested",
  "events.iterate.com/notification/requested",
  "events.iterate.com/device/notification-attempt-started",
  "events.iterate.com/device/notification-ticket-observed",
  "events.iterate.com/device/notification-settled",
];

export type DeviceNotificationStatus = {
  kind:
    | "pending"
    | "sending"
    | "sent"
    | "delivered"
    | "suppressed"
    | "expired"
    | "device-unavailable"
    | "failed"
    | "unknown";
  /** The human line the Notifications screen shows under the title. */
  label: string;
};

export type DeviceNotificationRow = {
  /** The requesting event's offset — the obligation's identity on the device stream. */
  requestOffset: number;
  title: string;
  body: string;
  /** ISO createdAt of the requesting event. */
  requestedAt: string;
  status: DeviceNotificationStatus;
  /** Where a tap navigates — the same destination union a push tap uses. */
  destination: PushNotificationData["destination"] | null;
};

/**
 * Every notification this device was ever asked to show, NEWEST first. Order
 * doesn't matter in the input (offsets do) — same contract as
 * approvals.ts's deriveOpenBatches.
 */
export function deriveDeviceNotifications(events: readonly StreamEvent[]): DeviceNotificationRow[] {
  const rows = new Map<number, DeviceNotificationRow>();
  for (const event of [...events].sort((left, right) => left.offset - right.offset)) {
    if (
      event.type === "events.iterate.com/device/notification-requested" ||
      event.type === "events.iterate.com/notification/requested"
    ) {
      // The event TYPE is the shape guarantee: the device processor's
      // contract (apps/os/src/domains/devices/device-processor-contract.ts)
      // schema-validates both request doors before they ever commit. The
      // cast names only the fields this view reads — with runtime fallbacks
      // anyway, so a malformed row degrades instead of crashing the list.
      // Same cast-plus-guards boundary approvals.ts uses; importing the real
      // zod contract would drag the OS processor machinery into the app
      // bundle for shapes the server already enforced.
      const payload = event.payload as {
        title?: string;
        body?: string;
        destination?: PushNotificationData["destination"];
      };
      rows.set(event.offset, {
        requestOffset: event.offset,
        title: typeof payload.title === "string" ? payload.title : "Notification",
        body: typeof payload.body === "string" ? payload.body : "",
        requestedAt: event.createdAt,
        status: { kind: "pending", label: "Waiting to send" },
        destination: payload.destination || null,
      });
      continue;
    }
    // Every remaining consumed type (attempt-started / ticket-observed /
    // settled) carries a contract-validated `requestOffset` pointing back at
    // its obligation; the cast is optional-typed and the typeof guard drops
    // anything that still fails it rather than trusting the assertion.
    const requestOffset = (event.payload as { requestOffset?: number }).requestOffset;
    if (typeof requestOffset !== "number") continue;
    const row = rows.get(requestOffset);
    if (row === undefined) continue;
    if (event.type === "events.iterate.com/device/notification-attempt-started") {
      row.status = { kind: "sending", label: "Sending" };
    } else if (event.type === "events.iterate.com/device/notification-ticket-observed") {
      row.status = { kind: "sent", label: "Sent" };
    } else if (event.type === "events.iterate.com/device/notification-settled") {
      // Optional-typed cast on purpose: settledStatus switches on the
      // outcome's `kind` discriminator and answers "Delivery unknown" for
      // anything unrecognized, so an outcome added by a NEWER server renders
      // as a row instead of breaking the reduce.
      row.status = settledStatus((event.payload as { outcome?: { kind?: string } }).outcome);
    }
  }
  return [...rows.values()].sort((left, right) => right.requestOffset - left.requestOffset);
}

/** The human account of a terminal settlement. An unrecognized outcome kind
 * (a newer server) degrades to "unknown" rather than hiding the row. */
function settledStatus(outcome: { kind?: string } | undefined): DeviceNotificationStatus {
  switch (outcome?.kind) {
    case "accepted-by-push-service":
      return { kind: "delivered", label: "Delivered" };
    case "suppressed":
      return { kind: "suppressed", label: "Skipped — already on screen" };
    case "expired":
      return { kind: "expired", label: "Expired before sending" };
    case "device-unavailable":
      return { kind: "device-unavailable", label: "Not sent — notifications were off" };
    case "rejected-by-expo":
    case "rejected-by-push-service":
      return { kind: "failed", label: "Send failed" };
    default:
      return { kind: "unknown", label: "Delivery unknown" };
  }
}
