import { expect, test } from "vitest";
import type { StreamEvent } from "iterate/sdk/itx/react";
import { deriveDeviceNotifications } from "./notifications.ts";

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
      status: { kind: "pending", label: "Waiting to send" },
      destination: { kind: "agent-chat", path: "/agents/demo" },
    },
  ]);

  expect(
    deriveDeviceNotifications([
      intentRequested(2, {}),
      progress(3, "events.iterate.com/device/notification-attempt-started", 2),
    ])[0],
  ).toMatchObject({ status: { kind: "sending", label: "Sending" } });

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
      { kind: "uncertain", phase: "receipt", reason: "window lapsed" },
      "unknown",
      "Delivery unknown",
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

// -----------------------------------------------------------------------------
// Event literal builders.
// -----------------------------------------------------------------------------

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
