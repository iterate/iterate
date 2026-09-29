// iterate-context.test.ts — the edge's policy for a call the platform failed (context-stub.ts, the
// failure model in docs/engineering-invariants.md#failures-and-retries): an idempotent call (a read,
// an append whose every event carries an idempotency key) a deploy's reset or a lost connection
// failed is sent ONCE more on a fresh stub; an overloaded failure never; and a platform failure that
// stands reaches the client as UNAVAILABLE. Node: the namespace is a fake whose stubs fail as
// workerd stamps each failure.

import { expect, test, vi } from "vitest";
import type { ItxExpression } from "iterate/expression";
import { DurableObjectNameCodec } from "./context/paths.ts";
import { IterateContextRpcTarget, type IterateContextNamespace } from "./iterate-context.ts";
import { SessionTeardown } from "./session.ts";

const STORAGE_TIMEOUT =
  "Durable Object storage operation exceeded timeout which caused object to be reset.";
const STORAGE_INTERNAL_ERROR =
  "Internal error in Durable Object storage caused object to be reset; reference = abc123";
const DEPLOY_RESET = "Durable Object reset because its code was updated.";
const MEMORY_LIMIT = "Durable Object's isolate exceeded its memory limit and was reset.";

test.for([
  {
    name: "a read a deploy reset is sent again and answers, logged at info",
    call: ["itx", ["readEvents", 0, 10]],
    failures: ["deploy reset"],
    outcome: { answer: "answered" },
    lines: [["info", retried("deploy-reset", "itx.readEvents", DEPLOY_RESET)]],
  },
  {
    name: "a processor's snapshot a deploy reset is sent again",
    call: ["itx", "builtins", "facets", ["get", "agent"], ["snapshot"]],
    failures: ["deploy reset"],
    outcome: { answer: "answered" },
    lines: [["info", retried("deploy-reset", "itx.builtins.facets.get.snapshot", DEPLOY_RESET)]],
  },
  {
    name: "a repo read the storage's internal error reset is sent again and answers",
    call: ["itx", "repos", ["get", "/repos/config"], ["readFile", "worker.ts"]],
    failures: ["storage internal error"],
    outcome: { answer: "answered" },
    lines: [["warn", retried("disconnected", "itx.repos.get.readFile", STORAGE_INTERNAL_ERROR)]],
  },
  {
    name: "an append whose every event carries an idempotency key is sent again after a lost connection",
    call: [
      "itx",
      ["append", { type: "a", idempotencyKey: "k1" }, { type: "b", idempotencyKey: "k2" }],
    ],
    failures: ["connection lost"],
    outcome: { answer: "answered" },
    lines: [["warn", retried("disconnected", "itx.append", "Network connection lost.")]],
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
    lines: [
      [
        "warn",
        retried("disconnected", "itx.facets.get.waitUntilProcessed", "Network connection lost."),
      ],
    ],
  },
  {
    name: "a processor enable, which appends nothing for a row it already holds, is sent again",
    call: ["itx", "processors", ["enable", "account"]],
    failures: ["deploy reset"],
    outcome: { answer: "answered" },
    lines: [["info", retried("deploy-reset", "itx.processors.enable", DEPLOY_RESET)]],
  },
  {
    name: "a read through cd is sent again",
    call: ["itx", ["cd", "/notes"], ["waitForEvent", { type: "x" }]],
    failures: ["connection lost"],
    outcome: { answer: "answered" },
    lines: [["warn", retried("disconnected", "itx.cd.waitForEvent", "Network connection lost.")]],
  },
  {
    name: "a read the storage timeout reset is never sent again at once: an overload is answered UNAVAILABLE",
    call: ["itx", ["readEvents", 0, 10]],
    failures: ["storage timeout"],
    outcome: { error: unavailable("overloaded", STORAGE_TIMEOUT) },
    lines: [["warn", gaveUp("overloaded", "itx.readEvents", STORAGE_TIMEOUT, 1)]],
  },
  {
    name: "a reset at the isolate's memory limit is an overload too",
    call: ["itx", ["readEvents", 0, 10]],
    failures: ["memory limit"],
    outcome: { error: unavailable("overloaded", MEMORY_LIMIT) },
    lines: [["warn", gaveUp("overloaded", "itx.readEvents", MEMORY_LIMIT, 1)]],
  },
  {
    name: "a read the platform failed twice fails with the second failure, and the give-up is logged",
    call: ["itx", "builtins", ["readEvents", 0, 10]],
    failures: ["storage internal error", "deploy reset"],
    outcome: { error: unavailable("deploy-reset", DEPLOY_RESET) },
    lines: [
      ["warn", retried("disconnected", "itx.builtins.readEvents", STORAGE_INTERNAL_ERROR)],
      ["info", gaveUp("deploy-reset", "itx.builtins.readEvents", DEPLOY_RESET, 2)],
    ],
  },
  {
    name: "a facet's own method is never sent twice",
    call: ["itx", "facets", ["get", "agent"], ["message", "hello"]],
    failures: ["connection lost"],
    outcome: { error: unavailable("disconnected", "Network connection lost.") },
    lines: [],
  },
  {
    name: "a write a deploy reset is never sent twice",
    call: ["itx", "repos", ["get", "/repos/config"], ["writeFile", "a.md", "x"]],
    failures: ["deploy reset"],
    outcome: { error: unavailable("deploy-reset", DEPLOY_RESET) },
    lines: [],
  },
  {
    name: "an append with no idempotency key is never sent twice",
    call: ["itx", ["append", { type: "a" }]],
    failures: ["connection lost"],
    outcome: { error: unavailable("disconnected", "Network connection lost.") },
    lines: [],
  },
  {
    name: "an append with one event of the batch unkeyed is never sent twice",
    call: ["itx", ["append", { type: "a", idempotencyKey: "k1" }, { type: "b" }]],
    failures: ["connection lost"],
    outcome: { error: unavailable("disconnected", "Network connection lost.") },
    lines: [],
  },
  {
    name: "a keyed ephemeral append is never sent twice: no row holds its key",
    call: ["itx", ["append", { type: "a", idempotencyKey: "k1", ephemeral: true }]],
    failures: ["connection lost"],
    outcome: { error: unavailable("disconnected", "Network connection lost.") },
    lines: [],
  },
  {
    name: "a read with a live argument is never sent twice",
    call: ["itx", ["readEvents", 0, 10]],
    args: [() => {}],
    failures: ["connection lost"],
    outcome: { error: unavailable("disconnected", "Network connection lost.") },
    lines: [],
  },
  {
    name: "the callee's own failure fails at once, as itself",
    call: ["itx", ["readEvents", 0, 10]],
    failures: ["own"],
    outcome: { error: { message: "no such offset" } },
    lines: [],
  },
] satisfies {
  name: string;
  call: ItxExpression;
  args?: unknown[];
  failures: Failure[];
  outcome: { answer: string } | { error: object };
  lines: [string, object][];
}[])(
  "platform failures at the edge: $name",
  async ({ call, args = [], failures, outcome, lines }) => {
    const logged: [string, unknown][] = [];
    vi.spyOn(console, "info").mockImplementation((line) => void logged.push(["info", line]));
    vi.spyOn(console, "warn").mockImplementation((line) => void logged.push(["warn", line]));
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
      (error: unknown) => ({ error }),
    );
    expect(settled).toMatchObject(outcome);
    const attempts = 1 + lines.filter(([, line]) => "retryInMs" in line).length;
    expect(invoke).toHaveBeenCalledTimes(attempts);
    expect(getByName).toHaveBeenCalledTimes(attempts); // each attempt on a fresh stub
    // Exact: the lines are the prd fault alarm's input.
    expect(logged).toEqual(lines);
  },
);

test("a fetch's Response is answered on a stream of this isolate's own, its status, headers and bytes as sent", async () => {
  const chunks = ['{"total_count":2,', '"repositories":[', '{"name":"a"},', '{"name":"b"}]}'];
  const upstream = new Response(streamOf(chunks), { status: 201, headers: { "x-upstream": "1" } });
  const answer = await fetchThrough(
    { fetch: async () => upstream },
    new Request("https://api.github.com/installation/repositories"),
  );
  // The context's body is never the one answered: this isolate reads it and hands it on.
  expect(upstream.body).toMatchObject({ locked: true });
  expect(answer).toMatchObject({ status: 201, headers: new Headers({ "x-upstream": "1" }) });
  expect(await answer.text()).toBe(chunks.join(""));
});

type Failure =
  | "storage timeout"
  | "storage internal error"
  | "connection lost"
  | "deploy reset"
  | "memory limit"
  | "own";

/** Each failure as workerd hands it to the caller: its message and the flags jsg stamps on it — a
 *  `broken.` failure `durableObjectReset`, a DISCONNECTED one `retryable`, an OVERLOADED one
 *  `overloaded` (workerd jsg/util.c++ `addAdditionalInfo`). */
function platformError(failure: Failure): Error {
  const flags = {
    "storage timeout": { message: STORAGE_TIMEOUT, overloaded: true, durableObjectReset: true },
    "storage internal error": { message: STORAGE_INTERNAL_ERROR, durableObjectReset: true },
    "connection lost": { message: "Network connection lost.", retryable: true },
    "deploy reset": { message: DEPLOY_RESET, retryable: true, durableObjectReset: true },
    "memory limit": { message: MEMORY_LIMIT, overloaded: true, durableObjectReset: true },
    own: { message: "no such offset" },
  }[failure];
  const { message, ...stamped } = flags;
  return Object.assign(new Error(message), stamped);
}

/** What the client holds for a platform failure that stands. */
function unavailable(kind: string, message: string) {
  const retryAfterMs = kind === "overloaded" ? 10_000 : 1_000;
  return { message, code: "UNAVAILABLE", data: { kind, retryAfterMs } };
}

/** The line a repeat logs. */
function retried(kind: string, name: string, message: string) {
  return {
    event: `itx.${kind === "deploy-reset" ? "deploy-reset" : "platform-failure"}-retry`,
    kind,
    name,
    projectId: "prj_edge",
    path: "/",
    message: `Error: ${message}`,
    attempt: 1,
    retryInMs: 0,
  };
}

/** The line giving up on an idempotent call logs. */
function gaveUp(kind: string, name: string, message: string, attempts: number) {
  return {
    event: `itx.${kind === "deploy-reset" ? "deploy-reset" : "platform-failure"}-gave-up`,
    kind,
    name,
    projectId: "prj_edge",
    path: "/",
    message: `Error: ${message}`,
    attempts,
  };
}

/** `request` fetched through an edge context whose Durable Object answers with `stub.fetch`. */
async function fetchThrough(
  stub: { fetch: (request: Request) => Promise<Response> },
  request: Request,
): Promise<Response> {
  const context = new IterateContextRpcTarget(
    // The fake namespace answers the one method a session's terminal fetch calls on it.
    { getByName: () => stub } as unknown as IterateContextNamespace,
    DurableObjectNameCodec.address({ projectId: "prj_edge", path: "/" }),
    new SessionTeardown(),
    () => {},
    { principal: null },
  );
  // A terminal fetch answers the Response its context answered.
  return (await context.invoke(["itx", "fetch"], request)) as Response;
}

/** A body that arrives in `chunks`, one read each. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const left = [...chunks];
  return new ReadableStream({
    pull(controller) {
      const chunk = left.shift();
      if (chunk) controller.enqueue(encoder.encode(chunk));
      else controller.close();
    },
  });
}
