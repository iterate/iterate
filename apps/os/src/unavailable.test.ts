// unavailable.test.ts — a platform failure as it leaves the hop that saw it (UNAVAILABLE, its
// message kept), and the edge's one HTTP answer to a failure that is not the request's own.
import { codedError } from "iterate/lib";
import { expect, test } from "vitest";
import { unavailable, unavailableAnswer } from "./unavailable.ts";

const DEPLOY_RESET = "Durable Object reset because its code was updated.";

test.for([
  {
    name: "a lost connection becomes UNAVAILABLE, its message kept",
    error: stamped("Network connection lost.", { retryable: true }),
    thrown: stamped("Network connection lost.", {
      code: "UNAVAILABLE",
      data: { kind: "disconnected", retryAfterMs: 1_000 },
    }),
  },
  {
    name: "a deploy's reset becomes UNAVAILABLE",
    error: stamped(DEPLOY_RESET, { retryable: true, durableObjectReset: true }),
    thrown: stamped(DEPLOY_RESET, {
      code: "UNAVAILABLE",
      data: { kind: "deploy-reset", retryAfterMs: 1_000 },
    }),
  },
  {
    name: "a coded refusal is itself",
    error: codedError("FORBIDDEN", "not yours"),
    thrown: stamped("not yours", { code: "FORBIDDEN" }),
  },
  {
    name: "our own defect is itself",
    error: new Error("boom"),
    thrown: new Error("boom"),
  },
])("unavailable: $name", ({ error, thrown }) => {
  // Exact: what crosses /api is the error's own properties, workerd's flags not among them.
  expect(unavailable(error)).toEqual(thrown);
});

test.for([
  {
    name: "a lent stub offline is the upstream's absence, a 502",
    error: codedError("RPC_STUB_OFFLINE", "rpc stub offline"),
    answer: { status: 502, headers: {} },
  },
  {
    name: "a deploy's reset is a 503 to ask again in a second",
    error: stamped(DEPLOY_RESET, { retryable: true }),
    answer: { status: 503, headers: { "retry-after": "1", "cache-control": "no-store" } },
  },
  {
    name: "an overload that crossed a hop as UNAVAILABLE is a 503 to ask again in ten",
    error: codedError("UNAVAILABLE", "x", { kind: "overloaded", retryAfterMs: 10_000 }),
    answer: { status: 503, headers: { "retry-after": "10", "cache-control": "no-store" } },
  },
  {
    name: "a refusal is the caller's own answer",
    error: codedError("FORBIDDEN", "no"),
    answer: undefined,
  },
  { name: "our own defect is a 500, the caller's", error: new Error("boom"), answer: undefined },
])("unavailableAnswer: $name", ({ error, answer }) => {
  expect(unavailableAnswer(error)).toEqual(answer);
});

/** An error with the own properties workerd stamps on it. */
function stamped(message: string, stamps: object): Error {
  return Object.assign(new Error(message), stamps);
}
