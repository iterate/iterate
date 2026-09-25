// iterate-context.test.ts — the edge's one repeat of a call the platform failed: an idempotent call
// (a read, an append whose every event carries an idempotency key) the platform failed once is sent
// again on a fresh stub and logged as `itx.platform-failure-retry`; any other call, a second failure
// and a failure that is not the platform's are the caller's at once. Node: the namespace is a fake
// whose stubs fail as workerd stamps each failure (retryable-error.ts).

import { expect, test, vi } from "vitest";
import type { ItxExpression } from "iterate/expression";
import { DurableObjectNameCodec } from "./context/paths.ts";
import { IterateContextRpcTarget, type IterateContextNamespace } from "./iterate-context.ts";
import { SessionTeardown } from "./session.ts";

const STORAGE_TIMEOUT =
  "Durable Object storage operation exceeded timeout which caused object to be reset.";
const STORAGE_INTERNAL_ERROR =
  "Internal error in Durable Object storage caused object to be reset; reference = abc123";

test.for([
  {
    name: "a read the object's storage timeout reset is sent again and answers",
    call: ["itx", ["readEvents", 0, 10]],
    failures: ["storage timeout"],
    outcome: { answer: "answered" },
    retries: [{ name: "itx.readEvents", message: `Error: ${STORAGE_TIMEOUT}` }],
  },
  {
    name: "a repo read the storage's internal error reset is sent again and answers",
    call: ["itx", "repos", ["get", "/repos/config"], ["readFile", "worker.ts"]],
    failures: ["storage internal error"],
    outcome: { answer: "answered" },
    retries: [{ name: "itx.repos.get.readFile", message: `Error: ${STORAGE_INTERNAL_ERROR}` }],
  },
  {
    name: "an append whose every event carries an idempotency key is sent again after a lost connection",
    call: [
      "itx",
      ["append", { type: "a", idempotencyKey: "k1" }, { type: "b", idempotencyKey: "k2" }],
    ],
    failures: ["connection lost"],
    outcome: { answer: "answered" },
    retries: [{ name: "itx.append", message: "Error: Network connection lost." }],
  },
  {
    name: "a processor's barrier the lost connection cut is sent again and answers",
    call: [
      "itx",
      "facets",
      ["get", "fan0"],
      ["waitUntilProcessed", { offset: 1485, timeoutMs: 30_000 }],
    ],
    failures: ["connection lost"],
    outcome: { answer: "answered" },
    retries: [
      { name: "itx.facets.get.waitUntilProcessed", message: "Error: Network connection lost." },
    ],
  },
  {
    name: "a processor's snapshot the storage timeout reset is sent again",
    call: ["itx", "builtins", "facets", ["get", "agent"], ["snapshot"]],
    failures: ["storage timeout"],
    outcome: { answer: "answered" },
    retries: [{ name: "itx.builtins.facets.get.snapshot", message: `Error: ${STORAGE_TIMEOUT}` }],
  },
  {
    name: "a facet's own method is never sent twice",
    call: ["itx", "facets", ["get", "agent"], ["message", "hello"]],
    failures: ["connection lost"],
    outcome: { error: "Network connection lost." },
    retries: [],
  },
  {
    name: "a read through cd is sent again",
    call: ["itx", ["cd", "/notes"], ["waitForEvent", { type: "x" }]],
    failures: ["storage timeout"],
    outcome: { answer: "answered" },
    retries: [{ name: "itx.cd.waitForEvent", message: `Error: ${STORAGE_TIMEOUT}` }],
  },
  {
    name: "a read the platform failed twice fails with the second failure",
    call: ["itx", "builtins", ["readEvents", 0, 10]],
    failures: ["storage internal error", "storage timeout"],
    outcome: { error: STORAGE_TIMEOUT },
    retries: [{ name: "itx.builtins.readEvents", message: `Error: ${STORAGE_INTERNAL_ERROR}` }],
  },
  {
    name: "an append with no idempotency key is never sent twice",
    call: ["itx", ["append", { type: "a" }]],
    failures: ["storage timeout"],
    outcome: { error: STORAGE_TIMEOUT },
    retries: [],
  },
  {
    name: "an append with one event of the batch unkeyed is never sent twice",
    call: ["itx", ["append", { type: "a", idempotencyKey: "k1" }, { type: "b" }]],
    failures: ["connection lost"],
    outcome: { error: "Network connection lost." },
    retries: [],
  },
  {
    name: "a keyed ephemeral append is never sent twice: no row holds its key",
    call: ["itx", ["append", { type: "a", idempotencyKey: "k1", ephemeral: true }]],
    failures: ["connection lost"],
    outcome: { error: "Network connection lost." },
    retries: [],
  },
  {
    name: "a read with a live argument is never sent twice",
    call: ["itx", ["readEvents", 0, 10]],
    args: [() => {}],
    failures: ["connection lost"],
    outcome: { error: "Network connection lost." },
    retries: [],
  },
  {
    name: "a write is never sent twice",
    call: ["itx", "repos", ["get", "/repos/config"], ["writeFile", "a.md", "x"]],
    failures: ["storage timeout"],
    outcome: { error: STORAGE_TIMEOUT },
    retries: [],
  },
  {
    name: "a deploy's reset is expected, not the platform's failure: a read fails at once",
    call: ["itx", ["readEvents", 0, 10]],
    failures: ["deploy reset"],
    outcome: { error: "Durable Object reset because its code was updated." },
    retries: [],
  },
  {
    name: "a reset at the isolate's memory limit is not the storage's: a read fails at once",
    call: ["itx", ["readEvents", 0, 10]],
    failures: ["memory limit"],
    outcome: { error: "Durable Object's isolate exceeded its memory limit and was reset." },
    retries: [],
  },
  {
    name: "the callee's own refusal fails at once",
    call: ["itx", ["readEvents", 0, 10]],
    failures: ["refusal"],
    outcome: { error: "no such offset" },
    retries: [],
  },
] satisfies {
  name: string;
  call: ItxExpression;
  args?: unknown[];
  failures: Failure[];
  outcome: { answer: string } | { error: string };
  retries: { name: string; message: string }[];
}[])(
  "platform failures at the edge: $name",
  async ({ call, args = [], failures, outcome, retries }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const left = [...failures];
    const invoke = vi.fn(async () => {
      const failure = left.shift();
      if (failure) throw platformError(failure);
      return "answered";
    });
    const getByName = vi.fn(() => ({ invoke }));
    const context = new IterateContextRpcTarget(
      // The fake namespace answers the one method the edge calls on it.
      { getByName } as unknown as IterateContextNamespace,
      DurableObjectNameCodec.address({ projectId: "prj_edge", path: "/" }),
      new SessionTeardown(),
      () => {},
      { principal: null },
    );
    const settled = await context.invoke(call, ...args).then(
      (answer) => ({ answer }),
      (error: Error) => ({ error: error.message }),
    );
    expect(settled).toEqual(outcome);
    expect(invoke).toHaveBeenCalledTimes(1 + retries.length);
    expect(getByName).toHaveBeenCalledTimes(1 + retries.length); // each attempt on a fresh stub
    expect(warn.mock.calls.map(([line]) => line)).toEqual(
      retries.map((retry) => ({
        event: "itx.platform-failure-retry",
        projectId: "prj_edge",
        path: "/",
        attempt: 1,
        retryInMs: 0,
        ...retry,
      })),
    );
  },
);

type Failure =
  | "storage timeout"
  | "storage internal error"
  | "connection lost"
  | "deploy reset"
  | "memory limit"
  | "refusal";

/** Each failure as workerd hands it to the caller: its message and the flags jsg stamps on it — a
 *  `broken.` failure `durableObjectReset`, a DISCONNECTED one `retryable`, an OVERLOADED one
 *  `overloaded` (workerd jsg/util.c++ `decodeTunneledException`). */
function platformError(failure: Failure): Error {
  const flags = {
    "storage timeout": {
      message: STORAGE_TIMEOUT,
      overloaded: true,
      durableObjectReset: true,
    },
    "storage internal error": { message: STORAGE_INTERNAL_ERROR, durableObjectReset: true },
    "connection lost": { message: "Network connection lost.", retryable: true },
    "deploy reset": {
      message: "Durable Object reset because its code was updated.",
      retryable: true,
      durableObjectReset: true,
    },
    "memory limit": {
      message: "Durable Object's isolate exceeded its memory limit and was reset.",
      overloaded: true,
      durableObjectReset: true,
    },
    refusal: { message: "no such offset" },
  }[failure];
  const { message, ...stamped } = flags;
  return Object.assign(new Error(message), stamped);
}
