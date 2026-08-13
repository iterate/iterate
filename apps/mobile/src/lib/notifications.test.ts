import { expect, test } from "vitest";
import type { StreamEvent } from "iterate/sdk/itx/react";
import { EVENT as APPROVAL_EVENT, type RequestedPayload } from "./approvals.ts";
import { deriveDeviceNotifications, deriveNotificationListRows } from "./notifications.ts";

test("a copied approval intent's whole lifecycle: pending → sending → sent → delivered", () => {
  const rows = deriveDeviceNotifications([
    intentRequested(2, {
      title: "Approval needed",
      body: "POST api.stripe.com is waiting for approval.",
      destination: { kind: "agent-chat", path: "/agents/demo" },
    }),
  ]);
  expect(rows).toMatchObject([
    {
      requestOffset: 2,
      title: "Approval needed",
      body: "POST api.stripe.com is waiting for approval.",
      requestedAt: "2026-07-18T08:00:00.000Z",
      status: { kind: "pending", label: "Waiting to send…" },
      destination: { kind: "agent-chat", path: "/agents/demo" },
    },
  ]);

  expect(
    deriveDeviceNotifications([
      intentRequested(2, {}),
      progress(3, "events.iterate.com/device/notification-attempt-started", 2),
    ])[0],
  ).toMatchObject({ status: { kind: "sending", label: "Sending…" } });

  expect(
    deriveDeviceNotifications([
      intentRequested(2, {}),
      progress(3, "events.iterate.com/device/notification-attempt-started", 2),
      progress(4, "events.iterate.com/device/notification-ticket-observed", 2),
    ])[0],
  ).toMatchObject({ status: { kind: "sent", label: "Sent" } });

  expect(
    deriveDeviceNotifications([
      intentRequested(2, {}),
      progress(3, "events.iterate.com/device/notification-attempt-started", 2),
      progress(4, "events.iterate.com/device/notification-ticket-observed", 2),
      settled(5, 2, { kind: "accepted-by-push-service", ticketId: "t-1" }),
    ])[0],
  ).toMatchObject({ status: { kind: "delivered", label: "Delivered" } });
});

test("a suppressed settlement reads as 'already on screen'", () => {
  const rows = deriveDeviceNotifications([
    intentRequested(2, { title: "Approval needed" }),
    settled(3, 2, { kind: "suppressed" }),
  ]);
  expect(rows).toMatchObject([
    {
      requestOffset: 2,
      status: { kind: "suppressed", label: "Skipped — already on screen" },
    },
  ]);
});

test("terminal outcomes map to their human statuses", () => {
  const outcomes = [
    [{ kind: "expired" }, "expired", "Expired before sending"],
    [{ kind: "device-unavailable" }, "device-unavailable", "Not sent — notifications were off"],
    [
      { kind: "rejected-by-expo", error: "DeviceNotRegistered", message: "nope" },
      "failed",
      "Send failed",
    ],
    [
      { kind: "rejected-by-push-service", error: "x", message: "y", ticketId: "t" },
      "failed",
      "Send failed",
    ],
    [
      { kind: "uncertain", phase: "expo-send", reason: "deadline" },
      "unknown",
      "Delivery uncertain",
    ],
    [
      { kind: "uncertain", phase: "receipt", reason: "window lapsed" },
      "unknown",
      "Delivery uncertain",
    ],
    [{ kind: "some-future-outcome" }, "unknown", "Delivery unknown"],
  ] as const;
  for (const [outcome, kind, label] of outcomes) {
    expect(
      deriveDeviceNotifications([intentRequested(2, {}), settled(3, 2, outcome)])[0],
    ).toMatchObject({ status: { kind, label } });
  }
});

test("rows come newest first, and facts pointing at unknown obligations are ignored", () => {
  const rows = deriveDeviceNotifications([
    intentRequested(2, { title: "First" }),
    intentRequested(5, { title: "Second" }),
    settled(6, 999, { kind: "expired" }), // no such obligation — ignored
    // A direct device request opens a row the same way a copied intent does.
    {
      type: "events.iterate.com/device/notification-requested",
      offset: 7,
      createdAt: "2026-07-18T08:03:00.000Z",
      path: "/devices/phone",
      payload: {
        title: "Direct",
        body: "Buy milk",
        destination: { kind: "project" },
        expiresAt: 1,
      },
    } as StreamEvent,
  ]);
  expect(rows.map((row) => row.title)).toEqual(["Direct", "Second", "First"]);
});

test("rows carry the approval batch identity: top-level field, legacy destination fallback, null otherwise", () => {
  const rows = deriveDeviceNotifications([
    // The post-#2371 shape: batch identity rides top-level on the intent.
    intentRequested(2, {}),
    // A pre-#2371 intent: only the approvals destination carried the offset.
    {
      type: "events.iterate.com/notification/requested",
      offset: 5,
      createdAt: "2026-07-18T08:01:00.000Z",
      path: "/devices/phone",
      payload: {
        audience: { kind: "project" },
        title: "Approval needed",
        body: "POST api.stripe.com is waiting for approval.",
        destination: { kind: "approvals", approvalRequestEventOffset: 9 },
        expiresAt: 1_784_000_000_000,
      },
    } as StreamEvent,
    // A non-approval notification has no batch to expand.
    {
      type: "events.iterate.com/device/notification-requested",
      offset: 7,
      createdAt: "2026-07-18T08:02:00.000Z",
      path: "/devices/phone",
      payload: {
        title: "Direct",
        body: "Buy milk",
        destination: { kind: "project" },
        expiresAt: 1,
      },
    } as StreamEvent,
  ]);
  expect(rows).toMatchObject([
    { requestOffset: 7, approvalRequestEventOffset: null },
    { requestOffset: 5, approvalRequestEventOffset: 9 },
    { requestOffset: 2, approvalRequestEventOffset: 17 },
  ]);
});

// -----------------------------------------------------------------------------
// The display list: device rows unioned with open batches the device never
// heard about (deriveNotificationListRows).
// -----------------------------------------------------------------------------

test("an open batch with no device row becomes a needs-approval row above the device rows", () => {
  const deviceRows = deriveDeviceNotifications([intentRequested(2, {})]); // points at batch 17
  const list = deriveNotificationListRows(
    deviceRows,
    [
      approvalRequested(17),
      approvalRequested(40), // nothing on this device points at batch 40
    ],
    new Set(),
  );
  expect(list).toMatchObject([
    {
      kind: "needs-approval",
      approvalRequestEventOffset: 40,
      title: "Approval needed",
      body: "POST api.stripe.com is waiting for approval.",
      requestedAt: "2026-07-18T09:00:40.000Z",
      status: {
        kind: "needs-approval",
        label: "Needs approval — no notification reached this device",
      },
    },
    { kind: "device", requestOffset: 2, approvalRequestEventOffset: 17 },
  ]);
});

test("a batch any device row points at is the device row's business — no synthetic duplicate", () => {
  const deviceRows = deriveDeviceNotifications([intentRequested(2, {})]); // batch 17
  const list = deriveNotificationListRows(deviceRows, [approvalRequested(17)], new Set());
  expect(list).toMatchObject([{ kind: "device", approvalRequestEventOffset: 17 }]);
});

test("a decided orphan batch mirrors the retired screen: rejected disappears, approved lingers until settled", () => {
  const events = [approvalRequested(40), approvalDecided(41, 40, ["reject"])];
  expect(deriveNotificationListRows([], events, new Set())).toEqual([]);

  const approvedEvents = [approvalRequested(40), approvalDecided(41, 40, ["approve"])];
  expect(deriveNotificationListRows([], approvedEvents, new Set())).toMatchObject([
    {
      kind: "needs-approval",
      approvalRequestEventOffset: 40,
      status: { kind: "needs-approval", label: "Decided — awaiting release" },
    },
  ]);
  expect(
    deriveNotificationListRows([], [...approvedEvents, approvalSettled(42, 40, 0, 200)], new Set()),
  ).toEqual([]);
});

test("a batch decided from this screen lingers with its outcome instead of vanishing", () => {
  // All-reject normally closes the batch instantly — but the human who just
  // pressed Reject must see the outcome, not a disappearing row.
  const rejectedEvents = [approvalRequested(40), approvalDecided(41, 40, ["reject"])];
  expect(deriveNotificationListRows([], rejectedEvents, new Set([40]))).toMatchObject([
    {
      kind: "needs-approval",
      approvalRequestEventOffset: 40,
      title: "Approval needed",
      status: { kind: "decided", label: "Rejected" },
    },
  ]);

  // Same for a fully settled approval: "awaiting release" flips to the
  // outcome rather than leaving the list.
  const approvedEvents = [
    approvalRequested(40),
    approvalDecided(41, 40, ["approve"]),
    approvalSettled(42, 40, 0, 200),
  ];
  expect(deriveNotificationListRows([], approvedEvents, new Set([40]))).toMatchObject([
    {
      kind: "needs-approval",
      approvalRequestEventOffset: 40,
      status: { kind: "decided", label: "Approved" },
    },
  ]);

  // Still-open batches are untouched by the set: an approved-but-unsettled
  // batch keeps its awaiting-release treatment.
  expect(
    deriveNotificationListRows(
      [],
      [approvalRequested(40), approvalDecided(41, 40, ["approve"])],
      new Set([40]),
    ),
  ).toMatchObject([{ status: { kind: "needs-approval", label: "Decided — awaiting release" } }]);
});

test("an expired undecided batch never surfaces as a needs-approval row", () => {
  const list = deriveNotificationListRows(
    [],
    [approvalRequested(40, { expiresAt: "2020-01-01T00:00:00Z" })],
    new Set(),
  );
  expect(list).toEqual([]);
});

test("orphan batches sort newest first and a burst reads like the server's push copy", () => {
  const list = deriveNotificationListRows(
    [],
    [
      approvalRequested(40),
      approvalRequested(50, {
        requests: Array.from({ length: 3 }, () => ({
          method: "POST",
          url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          headers: {},
          body: null,
          secretPaths: [],
        })),
      }),
    ],
    new Set(),
  );
  expect(list).toMatchObject([
    {
      approvalRequestEventOffset: 50,
      title: "Approvals needed",
      body: "Script run waiting: 3 requests (3x gmail.googleapis.com)",
    },
    { approvalRequestEventOffset: 40, title: "Approval needed" },
  ]);
});

// -----------------------------------------------------------------------------
// Event literal builders.
// -----------------------------------------------------------------------------

/** A `human-approval-requested` batch event on the project ROOT stream. */
function approvalRequested(offset: number, overrides: Partial<RequestedPayload> = {}): StreamEvent {
  return {
    type: APPROVAL_EVENT.requested,
    offset,
    createdAt: `2026-07-18T09:00:${String(offset).padStart(2, "0")}.000Z`,
    path: "/",
    payload: {
      requests: [
        {
          method: "POST",
          url: "https://api.stripe.com/v1/transfers",
          headers: {},
          body: null,
          secretPaths: [],
        },
      ],
      ruleKey: "spec-needs-a-human",
      ruleDescription: "",
      expiresAt: "2099-01-01T00:00:00Z",
      ...overrides,
    },
  } as StreamEvent;
}

function approvalDecided(
  offset: number,
  approvalRequestEventOffset: number,
  verdicts: ("approve" | "reject")[],
): StreamEvent {
  return {
    type: APPROVAL_EVENT.decided,
    offset,
    createdAt: "2026-07-18T09:01:00.000Z",
    path: "/",
    payload: { approvalRequestEventOffset, verdicts, decidedBy: "human" },
  } as StreamEvent;
}

function approvalSettled(
  offset: number,
  approvalRequestEventOffset: number,
  index: number,
  status: number,
): StreamEvent {
  return {
    type: APPROVAL_EVENT.settled,
    offset,
    createdAt: "2026-07-18T09:02:00.000Z",
    path: "/",
    payload: { approvalRequestEventOffset, index, status },
  } as StreamEvent;
}

function intentRequested(
  offset: number,
  overrides: { title?: string; body?: string; destination?: unknown },
): StreamEvent {
  return {
    type: "events.iterate.com/notification/requested",
    offset,
    createdAt: "2026-07-18T08:00:00.000Z",
    path: "/devices/phone",
    payload: {
      approvalRequestEventOffset: 17,
      audience: { kind: "project" },
      title: overrides.title || "Approval needed",
      body: overrides.body || "POST api.stripe.com is waiting for approval.",
      destination: overrides.destination || { kind: "agent-chat", path: "/agents/demo" },
      expiresAt: 1_784_000_000_000,
    },
  } as StreamEvent;
}

function progress(offset: number, type: string, requestOffset: number): StreamEvent {
  return {
    type,
    offset,
    createdAt: "2026-07-18T08:00:02.000Z",
    path: "/devices/phone",
    payload: { requestOffset, ticketId: "t-1" },
  } as StreamEvent;
}

function settled(offset: number, requestOffset: number, outcome: unknown): StreamEvent {
  return {
    type: "events.iterate.com/device/notification-settled",
    offset,
    createdAt: "2026-07-18T08:00:03.000Z",
    path: "/devices/phone",
    payload: { requestOffset, outcome },
  } as StreamEvent;
}
