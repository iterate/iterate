// platform-retry.test.ts — the failure model's classifiers, and the one retry loop's decisions:
// what it repeats, when it gives up, and what it logs. The call sites' own rows live beside them.
import { expect, onTestFinished, test, vi } from "vitest";
import {
  CI_HTTP,
  failureKind,
  fetchRetryingPlatformFailures,
  type FailureKind,
  HttpAnswerError,
  httpFailureKind,
  isNotRoutedYet,
  isOpaqueInternalError,
  ONCE_NOW,
  retryPlatformFailures,
  type Schedule,
  UPSTREAM_ONCE,
} from "./platform-retry.ts";

test.for([
  {
    name: "a coded refusal is refused, whatever else it carries",
    error: stamped("no such offset", { code: "OFFSET_CONFLICT", retryable: true }),
    kind: "refused",
  },
  {
    name: "UNAVAILABLE is the kind it carries",
    error: stamped("x", { code: "UNAVAILABLE", data: { kind: "overloaded" } }),
    kind: "overloaded",
  },
  {
    name: "UNAVAILABLE with no kind of the platform's is failed",
    error: stamped("x", { code: "UNAVAILABLE", data: { kind: "refused" } }),
    kind: "failed",
  },
  {
    name: "a deploy's reset is a deploy reset, though workerd stamps it retryable",
    error: stamped("Durable Object reset because its code was updated.", {
      retryable: true,
      durableObjectReset: true,
    }),
    kind: "deploy-reset",
  },
  {
    name: "D1's deploy reset, in the cause sqlfu wraps, is a deploy reset",
    error: new Error("wrapped", { cause: d1("D1 DB reset because its code was updated.") }),
    kind: "deploy-reset",
  },
  {
    name: "a lost connection is disconnected",
    error: stamped("Network connection lost.", { retryable: true }),
    kind: "disconnected",
  },
  {
    name: "a storage timeout reset is overloaded: workerd throws it OVERLOADED",
    error: stamped(
      "Durable Object storage operation exceeded timeout which caused object to be reset.",
      { overloaded: true, durableObjectReset: true },
    ),
    kind: "overloaded",
  },
  {
    name: "a storage write's internal error reset is disconnected: the next call gets a fresh object",
    error: stamped(
      "Internal error in Durable Object storage write caused object to be reset; reference = abc",
      { durableObjectReset: true },
    ),
    kind: "disconnected",
  },
  {
    name: "a call on an instance Cloudflare replaced is disconnected: the next call reaches the instance that replaced it",
    error: stamped(
      "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
      { durableObjectReset: true },
    ),
    kind: "disconnected",
  },
  {
    name: "workerd's opaque internal error is failed: a facet whose class is not exported meets it too",
    error: new Error("internal error; reference = 0123"),
    kind: "failed",
  },
  { name: "a thrown string is failed", error: "boom", kind: "failed" },
])("failureKind: $name", ({ error, kind }) => {
  expect(failureKind(error)).toBe(kind);
});

// D1's documented failures (https://developers.cloudflare.com/d1/observability/debug-d1/#error-list),
// which its binding throws with no flags; a call's own — its SQL, its data, a size limit — is not
// the platform's at all.
test.for([
  {
    name: "its transient errors are disconnected",
    kind: "disconnected",
    messages: [
      "Network connection lost.",
      "Replica disconnected from primary.",
      "Internal error in D1 DB storage caused object to be reset.",
      "Internal error while starting up D1 DB storage caused object to be reset.",
      "Cannot resolve D1 DB due to transient issue on remote node.",
      "Can't read from request stream because client disconnected.",
    ],
  },
  {
    name: "its overloads are overloaded",
    kind: "overloaded",
    messages: [
      "D1 DB is overloaded. Requests queued for too long.",
      "D1 DB is overloaded. Too many requests queued.",
      "D1 DB storage operation exceeded timeout which caused object to be reset.",
      "D1 DB's isolate exceeded its memory limit and was reset.",
      "D1 DB exceeded its CPU time limit and was reset.",
    ],
  },
  {
    name: "a call's own failure is failed",
    kind: "failed",
    messages: [
      "no such table: users: SQLITE_ERROR",
      "UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT",
      "Exceeded maximum DB size.",
      "No SQL statements detected.",
    ],
  },
] satisfies { name: string; kind: FailureKind; messages: string[] }[])(
  "failureKind of D1: $name",
  ({ kind, messages }) => {
    expect(messages.map((message) => failureKind(d1(message)))).toEqual(messages.map(() => kind));
  },
);

// The control plane reads workerd's opaque internal error as an overload (control-plane/edge.ts):
// D1 runs no code of ours, so there it is the runtime's own failure.
test("isOpaqueInternalError: workerd's opaque internal error, through the cause sqlfu wraps, never a message that only mentions one", () => {
  expect(isOpaqueInternalError(new Error("internal error; reference = 0123"))).toBe(true);
  expect(
    isOpaqueInternalError(
      new Error("wrapped", { cause: new Error("D1_ERROR: internal error; reference = 0123") }),
    ),
  ).toBe(true);
  expect(
    isOpaqueInternalError(new Error("the parser met an internal error; reference = 0123")),
  ).toBe(false);
  expect(isOpaqueInternalError("internal error; reference = 0123")).toBe(false);
});

test.for([
  { name: "a 500", answer: answerError(500), kind: "disconnected" },
  { name: "a 503 Response", answer: new Response(null, { status: 503 }), kind: "disconnected" },
  { name: "a 429", answer: answerError(429), kind: "overloaded" },
  { name: "a 408", answer: answerError(408), kind: "overloaded" },
  { name: "a 404, an answer about the request", answer: answerError(404), kind: "refused" },
  { name: "a connection that failed", answer: new TypeError("fetch failed"), kind: "disconnected" },
  {
    name: "a timeout of the caller's own",
    answer: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    kind: "failed",
  },
  { name: "any other error", answer: new Error("boom"), kind: "failed" },
])("httpFailureKind: $name", ({ answer, kind }) => {
  expect(httpFailureKind(answer)).toBe(kind);
});

// Cloudflare's own answers, as a brand-new -os hostname got them from servers in LHR and in the
// colos Depot's runners reach (2026-09-28), beside the Worker's own answers shaped like them.
test.for([
  {
    name: "the There is nothing here yet page, by its header alone",
    answer: { status: 404, headers: { "x-preview-user-error": "true" } },
    notRouted: true,
  },
  { name: "error code: 1042, a 404", answer: plain(404, "error code: 1042"), notRouted: true },
  { name: "error code: 1104, a 500", answer: plain(500, "error code: 1104\n"), notRouted: true },
  {
    name: "the Worker's own Page not found page",
    answer: {
      status: 404,
      headers: { "content-type": "text/html" },
      body: "<title>Page not found</title>",
    },
    notRouted: false,
  },
  { name: "the Worker's JSON 404", answer: plain(404, '{"error":"not found"}'), notRouted: false },
  {
    name: "the page's header on a 200",
    answer: { status: 200, headers: { "x-preview-user-error": "true" } },
    notRouted: false,
  },
  { name: "1104's code on a 404", answer: plain(404, "error code: 1104"), notRouted: false },
  { name: "1042's code on a 500", answer: plain(500, "error code: 1042"), notRouted: false },
  {
    name: "a plain 404 whose body was not read",
    answer: { status: 404, headers: { "content-type": "text/plain" } },
    notRouted: false,
  },
])("isNotRoutedYet: $name", ({ answer, notRouted }) => {
  expect(isNotRoutedYet(answer)).toBe(notRouted);
});

test.for([
  {
    name: "an idempotent call a deploy reset is made again, logged at info",
    failures: ["deploy-reset"],
    schedule: ONCE_NOW,
    idempotent: true,
    outcome: { value: "answered" },
    lines: [["info", retryLine("deploy-reset", { attempt: 1, retryInMs: 0 })]],
  },
  {
    name: "an idempotent call a lost connection failed is made again, logged as the platform's failure",
    failures: ["disconnected"],
    schedule: ONCE_NOW,
    idempotent: true,
    outcome: { value: "answered" },
    lines: [["warn", retryLine("disconnected", { attempt: 1, retryInMs: 0 })]],
  },
  {
    name: "a second failure ends the schedule, and the give-up is logged",
    failures: ["disconnected", "deploy-reset"],
    schedule: ONCE_NOW,
    idempotent: true,
    outcome: { error: "deploy-reset" },
    lines: [
      ["warn", retryLine("disconnected", { attempt: 1, retryInMs: 0 })],
      ["info", gaveUpLine("deploy-reset", 2)],
    ],
  },
  {
    name: "an overloaded failure is never made again at once",
    failures: ["overloaded"],
    schedule: UPSTREAM_ONCE,
    idempotent: true,
    outcome: { error: "overloaded" },
    lines: [["warn", gaveUpLine("overloaded", 1)]],
  },
  {
    name: "a CI script waits an overload out",
    failures: ["overloaded"],
    schedule: CI_HTTP,
    idempotent: true,
    outcome: { value: "answered" },
    lines: [["warn", retryLine("overloaded", { attempt: 1, retryInMs: 2_000 })]],
  },
  {
    name: "a call that is not idempotent is made once, and its failure is the caller's",
    failures: ["disconnected"],
    schedule: ONCE_NOW,
    idempotent: false,
    outcome: { error: "disconnected" },
    lines: [],
  },
  {
    name: "a refusal and our own defect are thrown at once",
    failures: ["refused", "failed"],
    schedule: ONCE_NOW,
    idempotent: true,
    outcome: { error: "refused" },
    lines: [],
  },
] satisfies {
  name: string;
  failures: FailureKind[];
  schedule: Schedule;
  idempotent: boolean;
  outcome: { value: string } | { error: string };
  lines: [string, object][];
}[])("retryPlatformFailures: $name", async ({ failures, schedule, idempotent, outcome, lines }) => {
  // Each schedule's own waits, on a fake clock, each at its longest.
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  vi.spyOn(Math, "random").mockReturnValue(1);
  const logged: [string, unknown][] = [];
  vi.spyOn(console, "info").mockImplementation((line) => void logged.push(["info", line]));
  vi.spyOn(console, "warn").mockImplementation((line) => void logged.push(["warn", line]));
  const left = [...failures];
  const settled = retryPlatformFailures(
    async () => {
      const failure = left.shift();
      if (failure) throw new Error(failure);
      return "answered";
    },
    {
      area: "call",
      schedule,
      idempotent,
      kind: kindNamedByMessage,
      describe: () => ({ name: "the-call" }),
    },
  ).then(
    (value) => ({ value }),
    (error: Error) => ({ error: error.message }),
  );
  await vi.runAllTimersAsync();
  expect(await settled).toEqual(outcome);
  // Exact: the lines are the prd fault alarm's input.
  expect(logged).toEqual(lines);
});

test.for([
  { name: "at its shortest, half the schedule's", random: 0, waits: [1_000, 2_500] },
  { name: "halfway", random: 0.5, waits: [1_500, 3_750] },
])("each wait is jittered: $name", async ({ random, waits }) => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  vi.spyOn(Math, "random").mockReturnValue(random);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let calls = 0;
  const answer = retryPlatformFailures(
    async () => {
      if (++calls < 3) throw new TypeError("fetch failed");
      return "answered";
    },
    {
      area: "ci",
      schedule: CI_HTTP,
      idempotent: true,
      kind: httpFailureKind,
      describe: () => ({}),
    },
  );
  await vi.runAllTimersAsync();
  await expect(answer).resolves.toBe("answered");
  expect(warn.mock.calls.map(([line]) => line)).toMatchObject(
    waits.map((retryInMs) => ({ event: "ci.platform-failure-retry", retryInMs })),
  );
});

// RFC 9110 §10.2.3: delay-seconds or an HTTP-date. A script is the caller waiting a 429 out, so
// it waits as long as the far side asks, but never past its schedule's longest wait.
test.for([
  { name: "a shorter one leaves the wait as it was", retryAfter: "1", retryInMs: 2_000 },
  { name: "a longer one replaces the wait", retryAfter: "9", retryInMs: 9_000 },
  {
    name: "one past the schedule's longest wait stops there",
    retryAfter: "600",
    retryInMs: 10_000,
  },
  {
    name: "an HTTP-date is read as the time until it",
    retryAfter: "Sat, 26 Sep 2026 12:00:07 GMT",
    retryInMs: 7_000,
  },
])("a 429's Retry-After: $name", async ({ retryAfter, retryInMs }) => {
  vi.useFakeTimers({ now: NOW });
  onTestFinished(() => void vi.useRealTimers());
  vi.spyOn(Math, "random").mockReturnValue(1);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let calls = 0;
  const answer = retryPlatformFailures(
    async () => {
      if (++calls === 1) throw answerError(429, { "retry-after": retryAfter });
      return "answered";
    },
    {
      area: "ci",
      schedule: CI_HTTP,
      idempotent: true,
      kind: httpFailureKind,
      describe: () => ({}),
    },
  );
  await vi.runAllTimersAsync();
  await expect(answer).resolves.toBe("answered");
  expect(warn.mock.calls.map(([line]) => line)).toMatchObject([
    { event: "ci.platform-failure-retry", retryInMs },
  ]);
});

test.for([
  {
    name: "a 5xx is sent again, and the answer after it returned",
    answers: [503, 200],
    idempotent: true,
    outcome: { status: 200 },
    lines: ["retry"],
  },
  {
    name: "a connection that failed is sent again",
    answers: ["reset", 200],
    idempotent: true,
    outcome: { status: 200 },
    lines: ["retry"],
  },
  {
    name: "a TypeError of our own, such as a bad header, is thrown at once and never sent again",
    answers: ["bad header"],
    idempotent: true,
    outcome: { error: 'Headers.append: "a\nb" is an invalid header value.' },
    lines: [],
  },
  {
    name: "an answer about the request is the caller's, sent once",
    answers: [404],
    idempotent: true,
    outcome: { status: 404 },
    lines: [],
  },
  {
    name: "a request that is not idempotent is sent once, its 5xx thrown quoting the answer",
    answers: [500],
    idempotent: false,
    outcome: { error: "POST /things answered HTTP 500: down" },
    lines: [],
  },
  {
    name: "a 429 is sent again whatever the request: the far side refused it unrun",
    answers: [429, 200],
    idempotent: false,
    outcome: { status: 200 },
    lines: ["retry"],
  },
  {
    name: "the schedule is bounded: the last failure is thrown, and the give-up logged",
    answers: [502, 502, 502, 502],
    idempotent: true,
    outcome: { error: "POST /things answered HTTP 502: down" },
    lines: ["retry", "retry", "retry", "gave-up"],
  },
] satisfies {
  name: string;
  answers: (number | "reset" | "bad header")[];
  idempotent: boolean;
  outcome: { status: number } | { error: string };
  lines: string[];
}[])("fetchRetryingPlatformFailures: $name", async ({ answers, idempotent, outcome, lines }) => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const left = [...answers];
  const send = vi.fn(async () => {
    const answer = left.shift();
    if (answer === "reset") throw new TypeError("fetch failed");
    // A request built wrong fails in the building, as fetch's own Headers does.
    if (answer === "bad header") return new Response("ok", { headers: { "x-name": "a\nb" } });
    return new Response(answer === 200 ? "ok" : "down", { status: answer });
  });
  const settled = fetchRetryingPlatformFailures("POST /things", send, {
    area: "things",
    idempotent,
  }).then(
    (response) => ({ status: response.status }),
    (error: Error) => ({ error: error.message }),
  );
  await vi.runAllTimersAsync();
  expect(await settled).toEqual(outcome);
  expect(send).toHaveBeenCalledTimes(answers.length);
  expect(warn.mock.calls.map(([line]) => line)).toMatchObject(
    lines.map((outcome) => ({
      event: `things.platform-failure-${outcome}`,
      request: "POST /things",
    })),
  );
});

test("fetchRetryingPlatformFailures: an attempt with no answer in its time is our own deadline, an overload, sent again", async () => {
  // The fake clock cannot move AbortSignal.timeout's own timer, so the attempt's deadline is kept at
  // its default and made a fake setTimeout that aborts as the real one does.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.setTimerTickMode("nextTimerAsync");
  onTestFinished(() => void vi.useRealTimers());
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(new DOMException("timed out", "TimeoutError")), ms);
    return deadline.signal;
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let calls = 0;
  const response = await fetchRetryingPlatformFailures(
    "GET /slow",
    async (signal) => {
      if (++calls > 1) return new Response("ok");
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      throw signal.reason;
    },
    { area: "slow", idempotent: true },
  );
  expect(response).toMatchObject({ status: 200 });
  expect(warn.mock.calls.map(([line]) => line)).toMatchObject([
    {
      event: "slow.platform-failure-retry",
      kind: "overloaded",
      status: "network",
      message: "GET /slow: no answer within 30 s",
    },
  ]);
});

test("fetchRetryingPlatformFailures: once the caller's signal aborts, no retry starts", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const caller = new AbortController();
  const send = vi.fn(async () => {
    caller.abort();
    return new Response("down", { status: 503 });
  });
  await expect(
    fetchRetryingPlatformFailures("GET /late", send, {
      area: "late",
      idempotent: true,
      signal: caller.signal,
    }),
  ).rejects.toThrow("GET /late answered HTTP 503: down");
  expect(send).toHaveBeenCalledOnce();
  expect(warn.mock.calls.map(([line]) => line)).toMatchObject([
    { event: "late.platform-failure-gave-up", attempts: 1 },
  ]);
});

/** A row's failure is an Error whose message names its kind, so the rows exercise the loop's
 *  decisions apart from failureKind's. */
function kindNamedByMessage(error: unknown) {
  // The rows only ever throw an Error whose message is a FailureKind.
  return (error as Error).message as FailureKind;
}

/** The line a repeat of the row's call logs. */
function retryLine(kind: FailureKind, fields: { attempt: number; retryInMs: number }) {
  return {
    event: `call.${kind === "deploy-reset" ? "deploy-reset" : "platform-failure"}-retry`,
    kind,
    name: "the-call",
    message: `Error: ${kind}`,
    ...fields,
  };
}

/** The line giving up on the row's call logs. */
function gaveUpLine(kind: FailureKind, attempts: number) {
  return {
    event: `call.${kind === "deploy-reset" ? "deploy-reset" : "platform-failure"}-gave-up`,
    kind,
    name: "the-call",
    message: `Error: ${kind}`,
    attempts,
  };
}

/** An error with the own properties a hop stamps on it. */
function stamped(message: string, stamps: object): Error {
  return Object.assign(new Error(message), stamps);
}

/** A D1 failure as its binding throws it. */
function d1(message: string): Error {
  return new Error(`D1_ERROR: ${message}`);
}

/** A plain-text answer, read. */
function plain(status: number, body: string) {
  return { status, headers: { "content-type": "text/plain; charset=UTF-8" }, body };
}

/** A failed HTTP answer, as a script's call throws it. */
function answerError(status: number, headers: Record<string, string> = {}) {
  return new HttpAnswerError(`HTTP ${status}`, new Response(null, { status, headers }));
}

/** The clock the Retry-After rows run on: seven seconds before their HTTP-date. */
const NOW = Date.parse("2026-09-26T12:00:00Z");
