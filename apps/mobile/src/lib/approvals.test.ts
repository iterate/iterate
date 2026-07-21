import { expect, test } from "vitest";
import type { StreamEvent } from "iterate/sdk/itx/react";
import {
  approvalBodyForDisplay,
  deriveOpenRequests,
  deriveRecentResolvedRequests,
  EVENT,
  focusOpenRequest,
  safeHost,
  scriptCodeForApproval,
  type RequestedPayload,
} from "./approvals.ts";

test("an unresolved request is open", () => {
  const open = deriveOpenRequests([requested(1, "post-echo")]);
  expect(open).toEqual([
    { offset: 1, payload: expect.objectContaining({ ruleKey: "post-echo" }), submitted: false },
  ]);
});

test("a granted-but-not-yet-settled request is open and submitted", () => {
  const open = deriveOpenRequests([requested(1, "post-echo"), granted(2, 1)]);
  expect(open).toEqual([{ offset: 1, payload: expect.anything(), submitted: true }]);
});

test("a settled request is no longer open", () => {
  const open = deriveOpenRequests([requested(1, "post-echo"), granted(2, 1), settled(3, 1, 200)]);
  expect(open).toEqual([]);
});

test("a rejected request is no longer open", () => {
  const open = deriveOpenRequests([requested(1, "post-echo"), rejected(2, 1)]);
  expect(open).toEqual([]);
});

test("recent resolved requests retain their request details and decision", () => {
  const events = [
    requested(1, "approved-rule"),
    requested(2, "rejected-rule"),
    granted(3, 1),
    rejected(4, 2),
    settled(5, 1, 200),
  ];

  expect(deriveRecentResolvedRequests(events, 5)).toEqual([
    {
      offset: 1,
      payload: expect.objectContaining({ ruleKey: "approved-rule" }),
      outcome: { decision: "approved", deliveryError: null, upstreamStatus: 200 },
      resolutionEventOffset: 5,
    },
    {
      offset: 2,
      payload: expect.objectContaining({ ruleKey: "rejected-rule" }),
      outcome: { decision: "rejected", reason: "human" },
      resolutionEventOffset: 4,
    },
  ]);
});

test("recent resolved requests are limited by newest outcome, not request order", () => {
  const events = [
    requested(1, "resolved-last"),
    requested(2, "resolved-first"),
    rejected(3, 2),
    rejected(4, 1),
  ];

  expect(deriveRecentResolvedRequests(events, 1)).toMatchObject([
    { offset: 1, outcome: { decision: "rejected" }, resolutionEventOffset: 4 },
  ]);
});

test("an expired request is no longer open even with no resolution event", () => {
  const open = deriveOpenRequests([
    requested(1, "post-echo", { expiresAt: "2000-01-01T00:00:00Z" }),
  ]);
  expect(open).toEqual([]);
});

test("a stray reject after a winning grant does not close the hold (the door decides on settled)", () => {
  const open = deriveOpenRequests([requested(1, "post-echo"), granted(2, 1), rejected(3, 1)]);
  expect(open).toEqual([{ offset: 1, payload: expect.anything(), submitted: true }]);
});

test("safeHost falls back to the raw string for an unparseable URL", () => {
  expect(safeHost("https://api.stripe.com/v1/transfers")).toBe("api.stripe.com");
  expect(safeHost("not a url")).toBe("not a url");
});

test("a notification-targeted approval is focused at the front of the queue", () => {
  const open = deriveOpenRequests([requested(10, "first"), requested(20, "from-notification")]);

  expect(focusOpenRequest(open, 20).map((request) => request.offset)).toEqual([20, 10]);
});

test("the approval view resolves the exact script event and complete request body", () => {
  const request = requested(10, "refund", {
    body: { encoding: "utf8", content: '{"orderId":1234}' },
    source: {
      kind: "script-execution",
      executionId: "agent-output:8",
      scriptRunRequestedEventOffset: 9,
      streamPath: "/agents/refund-agent",
    },
  });
  const payload = request.payload as RequestedPayload;
  const scriptEvent = {
    type: "events.iterate.com/capability-host/script-run-requested",
    offset: 9,
    createdAt: "2026-07-21T15:00:00Z",
    path: "/agents/refund-agent",
    payload: {
      code: "async () => fetch('/refund')",
      executionId: "agent-output:8",
      expiresAt: Date.now() + 60_000,
    },
  } satisfies StreamEvent;

  expect(scriptCodeForApproval(payload, scriptEvent)).toBe("async () => fetch('/refund')");
  expect(approvalBodyForDisplay(payload)).toEqual({
    language: "json",
    text: '{"orderId":1234}',
  });
});

function requested(
  offset: number,
  ruleKey: string,
  overrides: Partial<RequestedPayload> = {},
): StreamEvent {
  return {
    type: EVENT.requested,
    offset,
    createdAt: new Date(2026, 0, 1, 0, 0, offset).toISOString(),
    path: "/",
    payload: {
      method: "POST",
      url: "https://api.stripe.com/v1/transfers",
      headers: {},
      bodySha256: null,
      bodyPreview: null,
      body: undefined,
      secretPaths: [],
      ruleKey,
      ruleDescription: "",
      expiresAt: overrides.expiresAt ?? "2099-01-01T00:00:00Z",
      ...overrides,
    },
  };
}

function granted(offset: number, approvalRequestEventOffset: number): StreamEvent {
  return {
    type: EVENT.granted,
    offset,
    createdAt: new Date(2026, 0, 1, 0, 0, offset).toISOString(),
    path: "/",
    payload: { approvalRequestEventOffset },
  };
}

function rejected(offset: number, approvalRequestEventOffset: number): StreamEvent {
  return {
    type: EVENT.rejected,
    offset,
    createdAt: new Date(2026, 0, 1, 0, 0, offset).toISOString(),
    path: "/",
    payload: { approvalRequestEventOffset, reason: "human" },
  };
}

function settled(offset: number, approvalRequestEventOffset: number, status: number): StreamEvent {
  return {
    type: EVENT.settled,
    offset,
    createdAt: new Date(2026, 0, 1, 0, 0, offset).toISOString(),
    path: "/",
    payload: { approvalRequestEventOffset, status },
  };
}
