// src/control-plane/edge.test.ts — which D1 failures are the platform's (`d1Fault`), over every
// message Cloudflare lists (https://developers.cloudflare.com/d1/observability/debug-d1/#error-list):
// retryable where it says to send the query again, not where the database is failing every query
// queued on it, and a call's own — its SQL, its data, a size limit — not the platform's at all.
import { SqlfuError } from "sqlfu";
import { expect, test } from "vitest";
import { d1Fault } from "./edge.ts";

test.for([
  ["D1_ERROR: D1 DB reset because its code was updated.", { retryable: true }],
  [
    "D1_ERROR: Internal error while starting up D1 DB storage caused object to be reset.",
    { retryable: true },
  ],
  ["D1_ERROR: Network connection lost.", { retryable: true }],
  ["D1_ERROR: Replica disconnected from primary.", { retryable: true }],
  ["D1_ERROR: Internal error in D1 DB storage caused object to be reset.", { retryable: true }],
  ["D1_ERROR: Cannot resolve D1 DB due to transient issue on remote node.", { retryable: true }],
  ["D1_ERROR: Can't read from request stream because client disconnected.", { retryable: true }],
  [
    "D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.",
    { retryable: false },
  ],
  ["D1_ERROR: D1 DB is overloaded. Requests queued for too long.", { retryable: false }],
  ["D1_ERROR: D1 DB is overloaded. Too many requests queued.", { retryable: false }],
  ["internal error; reference = 0123456789abcdef", { retryable: false }],
  ["D1_ERROR: D1 DB's isolate exceeded its memory limit and was reset.", { retryable: false }],
  ["D1_ERROR: D1 DB exceeded its CPU time limit and was reset.", { retryable: false }],
  ["D1_ERROR: Exceeded maximum DB size.", undefined],
  ["D1_ERROR: No SQL statements detected.", undefined],
  ["D1_ERROR: no such table: users: SQLITE_ERROR", undefined],
  ["D1_ERROR: UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT", undefined],
  ["D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'", undefined],
] as const)("d1Fault(%j) is %j", ([message, fault]) => {
  expect(d1Fault(new Error(message))).toEqual(fault);
});

test("a fault is read through sqlfu's wrapping and the binding's cause, and anything not an Error is none", () => {
  const cut = new Error("D1_ERROR: Network connection lost.", {
    cause: new Error("Network connection lost."),
  });
  const wrapped = new SqlfuError({
    kind: "unknown",
    query: { sql: "select 1", args: [] },
    system: "sqlite",
    cause: cut,
  });
  expect(d1Fault(wrapped)).toEqual({ retryable: true });
  expect(d1Fault(new Error("wrapped", { cause: cut }))).toEqual({ retryable: true });
  expect(d1Fault("Network connection lost.")).toBeUndefined();
});
