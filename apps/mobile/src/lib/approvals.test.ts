import { expect, test } from "vitest";
import type { StreamEvent } from "../../../os/src/itx-api.generated.ts";
import { deriveOpenRequests, EVENT, safeHost } from "./approvals.ts";

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

function requested(
  offset: number,
  ruleKey: string,
  overrides: Partial<{ expiresAt: string }> = {},
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
      secretPaths: [],
      ruleKey,
      expiresAt: overrides.expiresAt ?? "2099-01-01T00:00:00Z",
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
