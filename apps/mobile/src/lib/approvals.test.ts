import { expect, test, vi } from "vitest";
import type { StreamEvent } from "iterate/sdk/itx/react";
import {
  approvalBodyForDisplay,
  decide,
  deriveBatchDetail,
  deriveBatchesForExecution,
  summarizeBatchOutcomes,
  deriveOpenBatches,
  deriveRecentResolvedBatches,
  EVENT,
  hostBreakdown,
  safeHost,
  scriptCodeForApproval,
  type RequestedPayload,
} from "./approvals.ts";

test("an undecided batch is open", () => {
  const open = deriveOpenBatches([requested(1, "post-echo")]);
  expect(open).toEqual([
    {
      offset: 1,
      payload: expect.objectContaining({ ruleKey: "post-echo" }),
      submitted: false,
      verdicts: null,
    },
  ]);
});

test("a decided-but-not-yet-settled batch is open and submitted", () => {
  const open = deriveOpenBatches([requested(1, "post-echo"), decided(2, 1, ["approve"])]);
  expect(open).toEqual([
    { offset: 1, payload: expect.anything(), submitted: true, verdicts: ["approve"] },
  ]);
});

test("a fully settled batch is no longer open", () => {
  const open = deriveOpenBatches([
    requested(1, "post-echo"),
    decided(2, 1, ["approve"]),
    settled(3, 1, 0, 200),
  ]);
  expect(open).toEqual([]);
});

test("a burst batch stays open until EVERY approved index settles", () => {
  const events = [
    requestedBurst(1, "gmail-sends", 3),
    decided(2, 1, ["approve", "approve", "reject"]),
    settled(3, 1, 0, 200),
  ];
  expect(deriveOpenBatches(events)).toMatchObject([{ offset: 1, submitted: true }]);
  expect(deriveOpenBatches([...events, settled(4, 1, 1, 200)])).toEqual([]);
});

test("an all-reject decision closes the batch", () => {
  const open = deriveOpenBatches([requested(1, "post-echo"), decided(2, 1, ["reject"])]);
  expect(open).toEqual([]);
});

test("only the FIRST decision counts — a later contradiction is dead weight", () => {
  const open = deriveOpenBatches([
    requested(1, "post-echo"),
    decided(2, 1, ["reject"]),
    decided(3, 1, ["approve"]),
  ]);
  expect(open).toEqual([]);
});

test("a length-mismatched decision is ignored like the door ignores it — the batch stays open", () => {
  // The door keeps waiting on a decision whose verdict count doesn't match
  // its batch, so the screen must too: a short all-reject must not hide the
  // live hold, and a matching later decision still wins.
  const events = [requestedBurst(1, "gmail-sends", 3), decided(2, 1, ["reject"])];
  expect(deriveOpenBatches(events)).toMatchObject([{ offset: 1, submitted: false }]);
  expect(deriveOpenBatches([...events, decided(3, 1, ["reject", "reject", "reject"])])).toEqual([]);
});

test("recent resolved batches retain their request details and decision", () => {
  const events = [
    requested(1, "approved-rule"),
    requested(2, "rejected-rule"),
    decided(3, 1, ["approve"]),
    decided(4, 2, ["reject"]),
    settled(5, 1, 0, 200),
  ];

  expect(deriveRecentResolvedBatches(events, 5)).toMatchObject([
    {
      offset: 2,
      payload: expect.objectContaining({ ruleKey: "rejected-rule" }),
      decisionSummary: "Rejected",
      outcomes: [null],
      resolutionEventOffset: 4,
    },
    {
      offset: 1,
      payload: expect.objectContaining({ ruleKey: "approved-rule" }),
      decisionSummary: "Approved",
      outcomes: [{ status: 200, error: null }],
      resolutionEventOffset: 3,
    },
  ]);
});

test("a mixed decision summarizes both sides and keeps per-index outcomes", () => {
  const resolved = deriveRecentResolvedBatches(
    [
      requestedBurst(1, "gmail-sends", 3),
      decided(2, 1, ["approve", "reject", "approve"]),
      settled(3, 1, 0, 200),
      settled(4, 1, 2, 502),
    ],
    5,
  );

  expect(resolved).toMatchObject([
    {
      offset: 1,
      decisionSummary: "2 approved · 1 rejected",
      outcomes: [{ status: 200, error: null }, null, { status: 502, error: null }],
    },
  ]);
});

test("the door's expiry decision reads as Expired", () => {
  const resolved = deriveRecentResolvedBatches([requested(1, "impatient"), expiryDecided(2, 1)], 5);
  expect(resolved).toMatchObject([{ offset: 1, decidedBy: "expiry", decisionSummary: "Expired" }]);
});

test("recents order by newest decision, not request order", () => {
  const events = [
    requested(1, "resolved-last"),
    requested(2, "resolved-first"),
    decided(3, 2, ["reject"]),
    decided(4, 1, ["reject"]),
  ];

  expect(deriveRecentResolvedBatches(events, 1)).toMatchObject([
    { offset: 1, resolutionEventOffset: 4 },
  ]);
});

test("batch detail by offset: undecided → provisional, decided → resolved, complete once settles land", () => {
  const undecided = deriveBatchDetail([requested(1, "post-echo")], 1);
  expect(undecided).toMatchObject({
    payload: { ruleKey: "post-echo" },
    resolved: null,
    complete: false,
  });

  // All-reject is complete the moment it is decided — nothing settles.
  expect(
    deriveBatchDetail([requested(1, "post-echo"), decided(2, 1, ["reject"])], 1),
  ).toMatchObject({
    resolved: { decisionSummary: "Rejected" },
    complete: true,
  });

  // Approved indexes keep the detail provisional until every settle is in view.
  const burst = [requestedBurst(1, "gmail-sends", 2), decided(2, 1, ["approve", "approve"])];
  expect(deriveBatchDetail([...burst, settled(3, 1, 0, 200)], 1)).toMatchObject({
    resolved: { decisionSummary: "Approved" },
    complete: false,
  });
  expect(
    deriveBatchDetail([...burst, settled(3, 1, 0, 200), settled(4, 1, 1, 200)], 1),
  ).toMatchObject({ complete: true });
});

test("batch detail for an offset whose requested event is not in view is null", () => {
  expect(deriveBatchDetail([requested(1, "post-echo")], 99)).toBeNull();
});

test("an expired undecided batch is no longer open even with no decision event", () => {
  const open = deriveOpenBatches([
    requested(1, "post-echo", { expiresAt: "2000-01-01T00:00:00Z" }),
  ]);
  expect(open).toEqual([]);
});

test("safeHost falls back to the raw string for an unparseable URL", () => {
  expect(safeHost("https://api.stripe.com/v1/transfers")).toBe("api.stripe.com");
  expect(safeHost("not a url")).toBe("not a url");
});

test("the host breakdown counts a burst's hosts, busiest first", () => {
  const payload = requestedBurst(1, "gmail-sends", 3).payload as RequestedPayload;
  payload.requests[2]!.url = "https://api.stripe.com/v1/transfers";
  expect(hostBreakdown(payload.requests)).toBe("2x gmail.googleapis.com, 1x api.stripe.com");
});

test("the approval view resolves the exact script event and complete request body", () => {
  const request = requested(10, "refund", {
    requests: [
      {
        method: "POST",
        url: "https://api.stripe.com/v1/transfers",
        headers: {},
        secretPaths: [],
        body: {
          encoding: "utf8",
          content: '{"orderId":1234}',
          originalByteLength: 16,
          sha256: "body-sha256",
          truncated: false,
        },
      },
    ],
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
  expect(approvalBodyForDisplay(payload.requests[0]!)).toEqual({
    language: "json",
    originalByteLength: 16,
    text: '{"orderId":1234}',
    truncated: false,
  });
});

test("the approval view labels a capped request body as truncated", () => {
  const payload = requested(10, "upload", {
    requests: [
      {
        method: "POST",
        url: "https://api.stripe.com/v1/transfers",
        headers: {},
        secretPaths: [],
        body: {
          encoding: "utf8",
          content: "readable prefix",
          originalByteLength: 100_000,
          sha256: "body-sha256",
          truncated: true,
        },
      },
    ],
  }).payload as RequestedPayload;

  expect(approvalBodyForDisplay(payload.requests[0]!)).toEqual({
    language: "text",
    originalByteLength: 100_000,
    text: "readable prefix",
    truncated: true,
  });
});

test("decide signs ONCE over the whole batch and appends ONE decided event", async () => {
  const open = deriveOpenBatches([requestedBurst(1, "gmail-sends", 3)]);
  const appended: any[] = [];
  const sign = vi.fn(async (_message: Uint8Array) => ({ keyId: "key-1", signature: "sig" }));

  await decide({
    stream: { append: async (event: any) => void appended.push(event) } as any,
    projectId: "prj_test",
    offset: open[0]!.offset,
    payload: open[0]!.payload,
    verdicts: ["approve", "approve", "approve"],
    sign,
  });

  expect(sign).toHaveBeenCalledTimes(1);
  expect(appended).toMatchObject([
    {
      type: EVENT.decided,
      payload: {
        approvalRequestEventOffset: 1,
        verdicts: ["approve", "approve", "approve"],
        decidedBy: "human",
        keyId: "key-1",
        signature: "sig",
      },
    },
  ]);
});

test("a rejection reason rides the decided event and surfaces on the resolved batch", async () => {
  const open = deriveOpenBatches([requestedBurst(1, "gmail-sends", 2)]);
  const appended: any[] = [];

  await decide({
    stream: { append: async (event: any) => void appended.push(event) } as any,
    projectId: "prj_test",
    offset: open[0]!.offset,
    payload: open[0]!.payload,
    verdicts: ["reject", "reject"],
    reason: "  wrong recipient — use staging  ",
    sign: null,
  });

  // Trimmed on the way in; unsigned like every rejection.
  expect(appended).toMatchObject([
    {
      type: EVENT.decided,
      payload: {
        approvalRequestEventOffset: 1,
        verdicts: ["reject", "reject"],
        decidedBy: "human",
        reason: "wrong recipient — use staging",
      },
    },
  ]);

  const resolved = deriveRecentResolvedBatches(
    [
      requestedBurst(1, "gmail-sends", 2),
      {
        type: EVENT.decided,
        offset: 2,
        createdAt: new Date(2026, 0, 1, 0, 0, 2).toISOString(),
        path: "/",
        payload: appended[0].payload,
      },
    ],
    5,
  );
  expect(resolved).toMatchObject([
    { offset: 1, decisionSummary: "Rejected", reason: "wrong recipient — use staging" },
  ]);
});

test("an all-reject decision never signs — deny is the fail-safe direction", async () => {
  const open = deriveOpenBatches([requestedBurst(1, "gmail-sends", 2)]);
  const appended: any[] = [];
  const sign = vi.fn(async () => ({ keyId: "key-1", signature: "sig" }));

  await decide({
    stream: { append: async (event: any) => void appended.push(event) } as any,
    projectId: "prj_test",
    offset: open[0]!.offset,
    payload: open[0]!.payload,
    verdicts: ["reject", "reject"],
    sign,
  });

  expect(sign).not.toHaveBeenCalled();
  expect(appended).toMatchObject([
    {
      type: EVENT.decided,
      payload: {
        approvalRequestEventOffset: 1,
        verdicts: ["reject", "reject"],
        decidedBy: "human",
      },
    },
  ]);
  expect(appended[0].payload).not.toHaveProperty("signature");
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
      requests: [
        {
          method: "POST",
          url: "https://api.stripe.com/v1/transfers",
          headers: {},
          body: null,
          secretPaths: [],
        },
      ],
      ruleKey,
      ruleDescription: "",
      expiresAt: overrides.expiresAt ?? "2099-01-01T00:00:00Z",
      ...overrides,
    },
  };
}

/** A script run's burst committed as one batch of `count` gmail sends. */
function requestedBurst(offset: number, ruleKey: string, count: number): StreamEvent {
  return requested(offset, ruleKey, {
    requests: Array.from({ length: count }, () => ({
      method: "POST",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      headers: {},
      body: null,
      secretPaths: [],
    })),
    streamContext: {
      kind: "script-execution",
      executionId: "exec-a",
      scriptRunRequestedEventOffset: 1,
      streamPath: "/agents/demo",
    },
  });
}

function decided(
  offset: number,
  approvalRequestEventOffset: number,
  verdicts: ("approve" | "reject")[],
): StreamEvent {
  return {
    type: EVENT.decided,
    offset,
    createdAt: new Date(2026, 0, 1, 0, 0, offset).toISOString(),
    path: "/",
    payload: { approvalRequestEventOffset, verdicts, decidedBy: "human" },
  };
}

function expiryDecided(offset: number, approvalRequestEventOffset: number): StreamEvent {
  return {
    type: EVENT.decided,
    offset,
    createdAt: new Date(2026, 0, 1, 0, 0, offset).toISOString(),
    path: "/",
    payload: { approvalRequestEventOffset, verdicts: ["reject"], decidedBy: "expiry" },
  };
}

function settled(
  offset: number,
  approvalRequestEventOffset: number,
  index: number,
  status: number,
): StreamEvent {
  return {
    type: EVENT.settled,
    offset,
    createdAt: new Date(2026, 0, 1, 0, 0, offset).toISOString(),
    path: "/",
    payload: { approvalRequestEventOffset, index, status },
  };
}

test("batches for an execution: provenance-matched, resolution attached, outcome counts", () => {
  const events = [
    requestedBurst(1, "gmail-sends", 3), // executionId exec-a
    requested(5, "other-rule"), // no script provenance — never matches
    requestedBurst(7, "gmail-sends", 2), // exec-a again (round 2)
    decided(8, 1, ["approve", "approve", "approve"]),
  ];
  const now = Date.parse("2026-01-02T00:00:00Z"); // well inside the 2099 expiry horizon
  const batches = deriveBatchesForExecution(events, "exec-a", now);
  expect(batches).toMatchObject([
    { offset: 1, resolved: { decisionSummary: "Approved" }, expired: false },
    { offset: 7, resolved: null, expired: false },
  ]);
  expect(deriveBatchesForExecution(events, "exec-nope", now)).toEqual([]);

  expect(summarizeBatchOutcomes(batches)).toEqual({ open: 1, approved: 1, rejected: 0, mixed: 0 });
  expect(
    summarizeBatchOutcomes([
      ...deriveBatchesForExecution([...events, decided(9, 7, ["reject", "reject"])], "exec-a", now),
      { expired: false, resolved: { verdicts: ["approve", "reject"] } as any },
    ]),
  ).toEqual({ open: 0, approved: 1, rejected: 1, mixed: 1 });
});

test("an expired-undecided batch reads expired, not awaiting — already in the bucket its expiry decision will land in", () => {
  const events = [
    requested(1, "post-echo", {
      expiresAt: "2026-01-01T00:01:00Z",
      streamContext: {
        kind: "script-execution",
        executionId: "exec-a",
        scriptRunRequestedEventOffset: 1,
        streamPath: "/agents/demo",
      },
    }),
  ];
  const beforeExpiry = Date.parse("2026-01-01T00:00:30Z");
  const afterExpiry = Date.parse("2026-01-01T00:02:00Z");
  expect(deriveBatchesForExecution(events, "exec-a", beforeExpiry)).toMatchObject([
    { offset: 1, resolved: null, expired: false },
  ]);
  const expired = deriveBatchesForExecution(events, "exec-a", afterExpiry);
  expect(expired).toMatchObject([{ offset: 1, resolved: null, expired: true }]);
  // The glyphs treat it as closed already — ◷ must not advertise a hold
  // nobody can answer.
  expect(summarizeBatchOutcomes(expired)).toEqual({ open: 0, approved: 0, rejected: 1, mixed: 0 });
  // When the door's expiry decision lands, the interim flag retires (the
  // batch is resolved now) and the counts don't move — no glyph flip.
  const settledByDoor = deriveBatchesForExecution(
    [...events, expiryDecided(2, 1)],
    "exec-a",
    afterExpiry,
  );
  expect(settledByDoor).toMatchObject([
    { offset: 1, expired: false, resolved: { decidedBy: "expiry", decisionSummary: "Expired" } },
  ]);
  expect(summarizeBatchOutcomes(settledByDoor)).toEqual({
    open: 0,
    approved: 0,
    rejected: 1,
    mixed: 0,
  });
});
