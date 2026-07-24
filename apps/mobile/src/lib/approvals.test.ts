import { expect, test, vi } from "vitest";
import type { StreamEvent } from "iterate/sdk/itx/react";
import {
  approvalBodyForDisplay,
  deriveOpenRequests,
  deriveRecentResolvedRequests,
  EVENT,
  focusOpenRequest,
  grantMany,
  groupHostBreakdown,
  groupOpenRequests,
  rejectMany,
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
    body: {
      encoding: "utf8",
      content: '{"orderId":1234}',
      originalByteLength: 16,
      sha256: "body-sha256",
      truncated: false,
    },
    streamContext: {
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
    originalByteLength: 16,
    text: '{"orderId":1234}',
    truncated: false,
  });
});

test("the approval view labels a capped request body as truncated", () => {
  const payload = requested(10, "upload", {
    body: {
      encoding: "utf8",
      content: "readable prefix",
      originalByteLength: 100_000,
      sha256: "body-sha256",
      truncated: true,
    },
  }).payload as RequestedPayload;

  expect(approvalBodyForDisplay(payload)).toEqual({
    language: "text",
    originalByteLength: 100_000,
    text: "readable prefix",
    truncated: true,
  });
});

test("open requests bucket into Approval Groups by executionId; scope holds and singletons stay flat", () => {
  const open = deriveOpenRequests([
    scriptRequested(1, "exec-a"),
    requested(2, "manual-scope"),
    scriptRequested(3, "exec-a"),
    scriptRequested(4, "exec-b"),
    scriptRequested(5, "exec-a"),
  ]);

  expect(groupOpenRequests(open)).toMatchObject([
    {
      kind: "group",
      executionId: "exec-a",
      requests: [{ offset: 1 }, { offset: 3 }, { offset: 5 }],
    },
    { kind: "single", request: { offset: 2 } },
    // A one-member bucket renders exactly as an ungrouped request.
    { kind: "single", request: { offset: 4 } },
  ]);
});

test("a group shrinks back to a flat singleton once only one member is still open", () => {
  const open = deriveOpenRequests([
    scriptRequested(1, "exec-a"),
    scriptRequested(2, "exec-a"),
    rejected(3, 1),
  ]);

  expect(groupOpenRequests(open)).toMatchObject([{ kind: "single", request: { offset: 2 } }]);
});

test("focusing a notification-targeted member floats its whole group to the front", () => {
  const open = deriveOpenRequests([
    requested(1, "first"),
    scriptRequested(2, "exec-a"),
    scriptRequested(3, "exec-a"),
  ]);

  expect(groupOpenRequests(focusOpenRequest(open, 3))).toMatchObject([
    { kind: "group", executionId: "exec-a" },
    { kind: "single", request: { offset: 1 } },
  ]);
});

test("the group header host breakdown counts hosts, busiest first", () => {
  const open = deriveOpenRequests([
    scriptRequested(1, "exec-a", "https://api.stripe.com/v1/transfers"),
    scriptRequested(2, "exec-a"),
    scriptRequested(3, "exec-a"),
  ]);

  expect(groupHostBreakdown(open)).toBe("2x gmail.googleapis.com, 1x api.stripe.com");
});

test("grantMany signs everything up front (one unlock), then appends one ordinary grant per request", async () => {
  const open = deriveOpenRequests([scriptRequested(1, "exec-a"), scriptRequested(2, "exec-a")]);
  const appended: any[] = [];
  const progress: number[] = [];
  const signMany = vi.fn(async (messages: Uint8Array[]) => ({
    keyId: "key-1",
    signatures: messages.map((_, index) => `sig-${index}`),
  }));

  await grantMany({
    stream: { append: async (event: any) => void appended.push(event) } as any,
    projectId: "prj_test",
    requests: open,
    signMany,
    onProgress: (granted) => progress.push(granted),
  });

  expect(signMany).toHaveBeenCalledTimes(1);
  expect(signMany.mock.calls[0]![0]).toHaveLength(2);
  expect(appended).toMatchObject([
    {
      type: EVENT.granted,
      payload: { approvalRequestEventOffset: 1, keyId: "key-1", signature: "sig-0" },
    },
    {
      type: EVENT.granted,
      payload: { approvalRequestEventOffset: 2, keyId: "key-1", signature: "sig-1" },
    },
  ]);
  expect(progress).toEqual([0, 1, 2]);
});

test("a mid-batch append failure leaves earlier grants standing and the remainder pending", async () => {
  const open = deriveOpenRequests([
    scriptRequested(1, "exec-a"),
    scriptRequested(2, "exec-a"),
    scriptRequested(3, "exec-a"),
  ]);
  const appended: any[] = [];
  const progress: number[] = [];

  await expect(
    grantMany({
      stream: {
        append: async (event: any) => {
          if (appended.length === 1) throw new Error("stream unreachable");
          appended.push(event);
        },
      } as any,
      projectId: "prj_test",
      requests: open,
      signMany: async (messages) => ({
        keyId: "key-1",
        signatures: messages.map(() => "sig"),
      }),
      onProgress: (granted) => progress.push(granted),
    }),
  ).rejects.toThrow("stream unreachable");

  // No rollback exists on a stream: the first grant stands, offsets 2 and 3
  // stay visibly pending for retry.
  expect(appended).toMatchObject([{ payload: { approvalRequestEventOffset: 1 } }]);
  expect(progress).toEqual([0, 1]);
});

test("rejectMany appends unsigned rejections sequentially with progress", async () => {
  const open = deriveOpenRequests([scriptRequested(1, "exec-a"), scriptRequested(2, "exec-a")]);
  const appended: any[] = [];
  const progress: number[] = [];

  await rejectMany({
    stream: { append: async (event: any) => void appended.push(event) } as any,
    requests: open,
    onProgress: (rejectedCount) => progress.push(rejectedCount),
  });

  expect(appended).toMatchObject([
    { type: EVENT.rejected, payload: { approvalRequestEventOffset: 1, reason: "human" } },
    { type: EVENT.rejected, payload: { approvalRequestEventOffset: 2, reason: "human" } },
  ]);
  expect(progress).toEqual([0, 1, 2]);
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
      body: null,
      secretPaths: [],
      ruleKey,
      ruleDescription: "",
      expiresAt: overrides.expiresAt ?? "2099-01-01T00:00:00Z",
      ...overrides,
    },
  };
}

/** A held request carrying script-execution provenance — an Approval Group member. */
function scriptRequested(
  offset: number,
  executionId: string,
  url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
): StreamEvent {
  return requested(offset, "gmail-sends", {
    url,
    streamContext: {
      kind: "script-execution",
      executionId,
      scriptRunRequestedEventOffset: 1,
      streamPath: "/agents/demo",
    },
  });
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
