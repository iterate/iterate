// Past notifications for THIS device, reduced from the device stream's own
// events. The device processor journals the whole obligation there: the
// requesting event (a direct device request or a copied project intent) opens
// a row, attempt/ticket facts advance it, and the terminal settled fact fixes
// its outcome — including `suppressed`, the "already on screen"
// status the in-thread approval claim produces. Pure reduction, same shape as
// chat.ts/approvals.ts: the screen derives rows from its live query data.

import type { StreamEvent } from "iterate/sdk/itx/react";
import {
  deriveOpenBatches,
  deriveRecentResolvedBatches,
  EVENT as APPROVAL_EVENT,
  hostBreakdown,
  safeHost,
  type RequestedPayload,
} from "./approvals.ts";
import type { PushNotificationData } from "./notification-routing.ts";

export const DEVICE_NOTIFICATION_EVENT_TYPES = [
  "events.iterate.com/device/notification-requested",
  "events.iterate.com/notification/requested",
  "events.iterate.com/device/notification-attempt-started",
  "events.iterate.com/device/notification-ticket-observed",
  "events.iterate.com/device/notification-settled",
];

// Non-terminal statuses ("Waiting to send…", "Sending…") carry a trailing
// ellipsis on purpose: the push obligation is server work still in flight,
// and the row's status line is the product's in-progress indicator for it —
// the same `anythinging…` convention the chat's working row uses.
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
  /**
   * The approval batch this notification is about (the offset of its
   * project/human-approval-requested event on the root stream), or null for
   * non-approval notifications. What the Notifications screen keys its
   * inline batch-detail expansion on.
   */
  approvalRequestEventOffset: number | null;
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
        approvalRequestEventOffset?: number;
        title?: string;
        body?: string;
        destination?: PushNotificationData["destination"];
      };
      rows.set(event.offset, {
        requestOffset: event.offset,
        title: typeof payload.title === "string" ? payload.title : "Notification",
        body: typeof payload.body === "string" ? payload.body : "",
        requestedAt: event.createdAt,
        status: { kind: "pending", label: "Waiting to send…" },
        destination: payload.destination || null,
        // The top-level field is the batch identity since #2371; intents
        // committed before it only carried the offset inside the approvals
        // destination, so fall back there — those rows expand too.
        approvalRequestEventOffset:
          typeof payload.approvalRequestEventOffset === "number"
            ? payload.approvalRequestEventOffset
            : typeof payload.destination?.approvalRequestEventOffset === "number"
              ? payload.destination.approvalRequestEventOffset
              : null,
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
      row.status = { kind: "sending", label: "Sending…" };
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

/**
 * What the Notifications screen's FlatList actually renders: this device's
 * journaled rows, PLUS a synthetic "needs approval" row for every open batch
 * that never journaled here. The device list alone has a hole: rows derive
 * from the DEVICE stream, and its intent subscription starts at enrollment
 * ("start: now") — so a batch parked before enrollment, with notifications
 * denied, or under any other delivery gap has no row on this device. Those
 * batches still need a decision surface (this screen IS the approvals
 * surface), so they come from the project ROOT stream instead.
 */
export type NotificationListRow =
  | ({ kind: "device" } & DeviceNotificationRow)
  | {
      kind: "needs-approval";
      /** The batch's requested-event offset on the project root stream. */
      approvalRequestEventOffset: number;
      title: string;
      body: string;
      /** ISO createdAt of the batch's requested event. */
      requestedAt: string;
      status: { kind: "needs-approval" | "decided"; label: string };
    };

/**
 * Union the device's own rows with the root stream's open approval batches.
 * Device rows stay authoritative: a batch any device row points at (by
 * `approvalRequestEventOffset`) renders only as that row. The rest — open
 * batches with no notification journaled here — become synthetic
 * needs-approval rows ABOVE the device rows (they want action, and root vs
 * device offsets aren't comparable anyway), newest batch first.
 *
 * A batch leaves the synthetic list exactly when deriveOpenBatches closes
 * it: immediately on an all-reject decision, or once every approved index
 * settles (until then it stays visible as "Decided — awaiting release", the
 * retired Approvals screen's `submitted` treatment). Decided history then
 * lives only on real device rows, where they exist — same as the retired
 * screen's Recent list, which also showed nothing device-independent
 * forever.
 *
 * One exception: `sessionDecidedOffsets` — batches the human decided from
 * THIS screen instance. A row must not vanish under the finger that just
 * decided it, so those linger with their outcome ("Rejected", "Approved")
 * instead of leaving when deriveOpenBatches closes them. The set is
 * session-scoped UI state, so the no-device-independent-history rule above
 * still holds on the next visit.
 */
export function deriveNotificationListRows(
  deviceRows: readonly DeviceNotificationRow[],
  rootApprovalEvents: readonly StreamEvent[],
  sessionDecidedOffsets: ReadonlySet<number>,
): NotificationListRow[] {
  const journaled = new Set(
    deviceRows.flatMap((row) =>
      row.approvalRequestEventOffset === null ? [] : [row.approvalRequestEventOffset],
    ),
  );
  const requestedAtByOffset = new Map(
    rootApprovalEvents
      .filter((event) => event.type === APPROVAL_EVENT.requested)
      .map((event) => [event.offset, event.createdAt]),
  );
  const pushCopy = (payload: RequestedPayload) => ({
    // Mirrors the server's push copy (notification-processor-implementation
    // .ts's approvalPushBody) so a synthetic row reads like the row the
    // push WOULD have made.
    title: payload.requests.length === 1 ? "Approval needed" : "Approvals needed",
    body:
      payload.requests.length === 1
        ? `${payload.requests[0]!.method} ${safeHost(payload.requests[0]!.url)} is waiting for approval.`
        : `Script run waiting: ${payload.requests.length} requests (${hostBreakdown(payload.requests)})`,
  });
  const open = deriveOpenBatches(rootApprovalEvents);
  const openOffsets = new Set(open.map((batch) => batch.offset));
  const openRows = open
    .filter((batch) => !journaled.has(batch.offset))
    .map((batch): Extract<NotificationListRow, { kind: "needs-approval" }> => {
      return {
        kind: "needs-approval",
        approvalRequestEventOffset: batch.offset,
        ...pushCopy(batch.payload),
        // deriveOpenBatches only yields batches whose requested event is in
        // the input, so the lookup cannot miss.
        requestedAt: requestedAtByOffset.get(batch.offset)!,
        status: {
          kind: "needs-approval",
          label: batch.submitted
            ? "Decided — awaiting release"
            : "Needs approval — no notification reached this device",
        },
      };
    });
  const decidedRows = deriveRecentResolvedBatches(rootApprovalEvents, rootApprovalEvents.length)
    .filter(
      (batch) =>
        sessionDecidedOffsets.has(batch.offset) &&
        !openOffsets.has(batch.offset) &&
        !journaled.has(batch.offset),
    )
    .map((batch): Extract<NotificationListRow, { kind: "needs-approval" }> => {
      return {
        kind: "needs-approval",
        approvalRequestEventOffset: batch.offset,
        ...pushCopy(batch.payload),
        requestedAt: requestedAtByOffset.get(batch.offset)!,
        status: { kind: "decided", label: batch.decisionSummary },
      };
    });
  const synthetic = [...openRows, ...decidedRows].sort(
    (left, right) => right.approvalRequestEventOffset - left.approvalRequestEventOffset,
  );
  return [...synthetic, ...deviceRows.map((row) => ({ kind: "device" as const, ...row }))];
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
    case "uncertain":
      return { kind: "unknown", label: "Delivery uncertain" };
    default:
      return { kind: "unknown", label: "Delivery unknown" };
  }
}
