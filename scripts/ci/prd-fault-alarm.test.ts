import type { WebClient } from "@slack/web-api";
import { expect, test, vi } from "vitest";
import {
  type AlarmState,
  alarm,
  deployResetSummaries,
  type FaultReading,
  logWindow,
  run,
  triageIncidents,
} from "./prd-fault-alarm.ts";
import { slackChannelIds } from "./slack.ts";

const quiet: FaultReading = {
  serverErrors: [],
  heals: [],
  errors: [],
  pagers: [],
};
const now = new Date("2026-09-23T07:30:00Z");
const window = { from: new Date("2026-09-23T07:00:00Z"), to: now };
const credentials = { accountId: "account", apiToken: "token" };
const channel = slackChannelIds["#error-pulse"];

test("the 2026-09-23 fault window pages with hosts, healed facets and collapsed references", () => {
  // A sample of 07:00–07:30Z that day (`run --at 2026-09-23T07:30:00Z --dry-run`).
  expect(
    page({
      serverErrors: [
        ["https://garple.com/", 4],
        ["https://lispwoso.com/", 4],
        ["https://garple.com/d/ferovo.com", 3],
        ["http://lispwoso.com/", 2],
      ],
      heals: [
        ["project", 1279],
        ["repo", 536],
      ],
      errors: [
        ["ProjectDurableObject.jsrpc", 1199],
        ["internal error; reference = m6mc1rpui1cli5qkt7sqpp87", 1],
        ["internal error; reference = c1k0cg2egm9c43toh6sfipct", 1],
      ],
    }),
  ).toMatchInlineSnapshot(`
    "🚨 prd fault page: 07:00–07:30 UTC <@U067G4QRFK2>
    • 13 5xx responses: garple.com 7, lispwoso.com 6
    • 1815 platform-failure heals: project 1279, repo 536
    • 1201 errors: ProjectDurableObject.jsrpc 1199, internal error; reference = … 2
    <https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/workers-and-pages/observability|Workers Logs>
    No state from the last run: an incident already paged pages again."
  `);
});

test.each([
  ["a quiet prd", {}, false],
  ["one 5xx", { serverErrors: [["https://lispwoso.com/", 1]] }, true],
  ["9 heals", { heals: [["repo", 9]] }, false],
  ["10 heals", { heals: [["repo", 10]] }, true],
  ["one error", { errors: [["boom", 1]] }, true],
] satisfies [string, Partial<FaultReading>, boolean][])(
  "%s pages: %s",
  (_label, reading, pages) => {
    expect(page(reading) !== null).toBe(pages);
  },
);

// A run that could not read prd must fail, never pass as a quiet prd.
test("a run that cannot read prd fails: a failed Workers Logs query", async () => {
  await using cloudflare = workersLogs(() => ({
    success: false,
    errors: [{ code: 10000, message: "Authentication error" }],
  }));
  const slack = fakeSlack();
  await expect(summary(() => slack.client)).rejects.toThrow(
    'Workers Logs query failed: [{"code":10000,"message":"Authentication error"}]',
  );
  expect(cloudflare.fetch).toHaveBeenCalledTimes(8);
  expect(slack).toMatchObject({ posts: [] });
});

test("a run that cannot read prd fails: no Cloudflare credentials", async () => {
  await using cloudflare = workersLogs(() => ({ success: true }));
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  await expect(run({ dryRun: true })).rejects.toThrow(
    "run under doppler --project os --config prd",
  );
  expect(cloudflare.fetch).not.toHaveBeenCalled();
});

// Each fault is an incident: a new one pages, its repeats go into that page's thread.
test("a quiet run never builds a Slack client, so a broken token cannot turn it red", async () => {
  await using _cloudflare = workersLogs(serverErrorsOnly(0));
  const slack = vi.fn(() => {
    throw new Error("no Slack token");
  });
  await expect(
    alarm({ window, state: null, cloudflare: credentials, slack }),
  ).resolves.toMatchObject({ summary: "prd is quiet" });
  expect(slack).not.toHaveBeenCalled();
});

test("a quiet prd posts nothing and the next run reads on from where this one stopped", async () => {
  await using _cloudflare = workersLogs(serverErrorsOnly(0));
  const slack = fakeSlack();
  const run1 = await runAt("07:30", null, slack);
  expect(run1).toMatchObject({ summary: "prd is quiet", next: { incidents: {} } });
  expect(slack).toMatchObject({ posts: [] });
  expect(logWindow(new Date("2026-09-23T07:45:00Z"), run1.next)).toEqual({
    from: new Date("2026-09-23T07:28:00Z"),
    to: new Date("2026-09-23T07:43:00Z"),
  });
});

test.for([
  ["no state: the last half hour", null, "07:13"],
  ["a stale state: the last day at most", "2026-09-20T00:00:00Z", "2026-09-22T07:43"],
] as const)("a run reads %s", ([, readUntil, from]) => {
  const state = readUntil && { readUntil, incidents: {} };
  expect(logWindow(new Date("2026-09-23T07:45:00Z"), state).from.toISOString()).toContain(from);
});

test("a new 5xx pages; its repeats reply in the page's thread without mentioning anyone", async () => {
  const slack = fakeSlack();
  const run1 = await runAt("07:30", null, slack, serverErrorsOnly(1));
  const run2 = await runAt("07:45", run1.next, slack, serverErrorsOnly(2));
  expect(slack).toMatchObject({
    posts: [
      {
        channel,
        text: [
          "🚨 prd fault page: 06:58–07:28 UTC <@U067G4QRFK2>",
          "• 1 5xx responses: lispwoso.com 1",
          "<https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/workers-and-pages/observability|Workers Logs>",
          "No state from the last run: an incident already paged pages again.",
        ].join("\n"),
      },
      {
        channel,
        thread_ts: "1.0",
        reply_broadcast: false,
        text: "still failing, 07:28–07:43 UTC\n• 2 more 5xx responses: lispwoso.com (3 in all)",
      },
    ],
  });
  expect(run2.next).toMatchObject({
    incidents: {
      "5xx responses: lispwoso.com": {
        thread: "1.0",
        lastSeen: "2026-09-23T07:43:00.000Z",
        count: 3,
        told: 1,
      },
    },
  });
});

// Until 2026-09-24 a page held every page for an hour, while each run read only the half hour
// before it: a different 500 in that hour was never posted.
test("a different 5xx during an open incident pages at once", async () => {
  const slack = fakeSlack();
  const run1 = await runAt("07:30", null, slack, serverErrorsOnly(1));
  await runAt("07:45", run1.next, slack, (groupBy) =>
    groupBy === "$workers.event.request.url"
      ? {
          success: true,
          result: {
            calculations: [{ aggregates: [{ groupKey: "https://garple.com/", count: 1 }] }],
          },
        }
      : serverErrorsOnly(1)(groupBy),
  );
  expect(slack.posts).toHaveLength(2);
  expect(slack.posts[1]).toMatchObject({
    channel,
    text: expect.stringMatching(
      /^🚨 prd fault page: 07:28–07:43 UTC <@U067G4QRFK2>\n• 1 5xx responses: garple.com 1\n/,
    ),
  });
  expect(slack.posts[1]).not.toHaveProperty("thread_ts");
});

test("an incident that grows tenfold is broadcast to the channel with a mention", async () => {
  const slack = fakeSlack();
  const run1 = await runAt("07:30", null, slack, serverErrorsOnly(1));
  const run2 = await runAt("07:45", run1.next, slack, serverErrorsOnly(9));
  await runAt("08:00", run2.next, slack, serverErrorsOnly(1));
  expect(slack.posts.slice(1)).toEqual([
    {
      channel,
      thread_ts: "1.0",
      reply_broadcast: true,
      text: "🚨 grew tenfold, 07:28–07:43 UTC <@U067G4QRFK2>\n• 9 more 5xx responses: lispwoso.com (10 in all)",
    },
    {
      channel,
      thread_ts: "1.0",
      reply_broadcast: false,
      text: "still failing, 07:43–07:58 UTC\n• 1 more 5xx responses: lispwoso.com (11 in all)",
    },
  ]);
});

test("an incident unseen for a day is closed: its return pages as new", async () => {
  const slack = fakeSlack();
  const run1 = await runAt("07:30", null, slack, serverErrorsOnly(1));
  const nextDay = { ...run1.next, readUntil: "2026-09-24T07:28:00Z" };
  const run2 = await runAt("07:30", nextDay, slack, serverErrorsOnly(1), "2026-09-24");
  expect(slack.posts.map((post) => post.thread_ts)).toEqual([undefined, undefined]);
  expect(slack.posts[1]!.text).toMatch(/Repeats go in this thread\.$/);
  expect(run2.next).toMatchObject({
    incidents: {
      "5xx responses: lispwoso.com": {
        thread: "2.0",
        lastSeen: "2026-09-24T07:28:00.000Z",
        count: 1,
        told: 1,
      },
    },
  });
});

test("5xx responses the URL rows miss page as unknown", async () => {
  const slack = fakeSlack();
  const run1 = await runAt("07:30", null, slack, serverErrorsOnly(1, 2));
  expect(run1.summary).toContain("• 3 5xx responses: unknown 2, lispwoso.com 1");
});

// The 12:42 and 12:57 pages on 2026-09-24: a DO shutdown closed four voice boards' pagers, each
// logging an error; the page now says beside them whether the pagers came back.
test("a page and a thread reply show how the pagers recovered in the window", () => {
  const reading: FaultReading = {
    ...quiet,
    errors: [["Connection closed: this Durable Object instance is no longer active.", 2]],
    pagers: [
      ["rpc-stub-pager-dropped", 4],
      ["rpc-stub-pager-redialed", 3],
      ["rpc-stub-pager-redial-failed", 1],
    ],
  };
  const recovery = "• pagers in the window: 4 dropped, 3 re-dialed, 1 gave up";
  const opened = triageIncidents(reading, window, null);
  expect(opened.page?.text).toContain(recovery);
  const state = { readUntil: now.toISOString(), incidents: opened.incidents };
  expect(triageIncidents(reading, window, state).replies[0]?.text).toContain(recovery);
  expect(triageIncidents({ ...reading, pagers: [] }, window, null).page?.text).not.toContain(
    "pagers",
  );
});

test("every first-party prd Worker is read, not os-prd alone", async () => {
  await using cloudflare = workersLogs(serverErrorsOnly(0));
  await summary();
  const services = cloudflare.fetch.mock.calls.map(
    ([, init]) =>
      (JSON.parse(init.body) as { parameters: { filters: { key: string; value: string }[] } })
        .parameters.filters[0],
  );
  expect(new Set(services.map((filter) => JSON.stringify(filter)))).toEqual(
    new Set([
      JSON.stringify({
        key: "$metadata.service",
        operation: "in",
        value: "os-prd,dash,agents,notes,voice,kiterate,iterate-spa",
        type: "string",
      }),
    ]),
  );
});

test("heals page only in a burst, or as an incident already open", () => {
  const opened = triageIncidents({ ...quiet, heals: [["repo", 10]] }, window, null);
  const state = { readUntil: now.toISOString(), incidents: opened.incidents };
  expect(triageIncidents({ ...quiet, heals: [["repo", 1]] }, window, state).replies).toHaveLength(
    1,
  );
  expect(triageIncidents({ ...quiet, heals: [["project", 1]] }, window, state).page).toBeNull();
});

test("a dry run (no Slack client) resolves to the page it would post", async () => {
  await using _cloudflare = workersLogs(serverErrorsOnly(1));
  await expect(summary()).resolves.toBe(page({ serverErrors: [["https://lispwoso.com/", 1]] }));
});

test.for(["GET https://rpc-stub-pager.internal/", "IterateContextDurableObject.jsrpc"])(
  "deploy reset summaries are classified by DO, version and millisecond: %s",
  (message) => {
    expect([...deployResetSummaries(resetPair(message))]).toEqual(["first", "second"]);
  },
);

test.for([
  "no exception",
  "different object",
  "different version",
  "different millisecond",
  "missing identity",
  "missing request",
  "truncated",
  "another error",
  "structured error",
  "conflicting fields",
])("a summary stays an error with incomplete or conflicting evidence: %s", (reason) => {
  const [exception, , summary] = resetPair();
  const events: Parameters<typeof deployResetSummaries>[0] = [
    structuredClone(exception!),
    structuredClone(summary!),
  ];
  if (reason === "no exception") events.shift();
  if (reason === "different object") events[0]!.$workers.durableObjectId = "other";
  if (reason === "different version") events[0]!.$workers.scriptVersion!.id = "other";
  if (reason === "different millisecond") events[0]!.timestamp++;
  if (reason === "missing identity") events[0]!.$workers.durableObjectId = "";
  if (reason === "missing request") events[1]!.$metadata.requestId = "";
  if (reason === "truncated") events[0]!.$workers.truncated = true;
  if (reason === "another error")
    events.push({
      ...exception!,
      $metadata: { type: "cf-worker", requestId: "first", message: "Network connection lost." },
    });
  if (reason === "structured error" || reason === "conflicting fields")
    events.push({
      ...exception!,
      $metadata: {
        type: "cf-worker",
        error: "Network connection lost.",
        ...(reason === "conflicting fields" && { message: exception!.$metadata.message }),
      },
    });
  expect([...deployResetSummaries(events)]).toEqual([]);
});

test("a reset-only window goes quiet after the re-count and posts nothing", async () => {
  await using logs = queryableWorkersLogs(resetPair());
  const slack = fakeSlack();
  await expect(summary(() => slack.client)).resolves.toBe("prd is quiet");
  expect(slack).toMatchObject({ posts: [] });
  expect(logs.fetch).toHaveBeenCalledTimes(11);
});

test("a fresh error sharing the pager URL and every HTTP 5xx survive reset classification", async () => {
  await using _logs = queryableWorkersLogs([
    ...resetPair(),
    {
      ...resetPair()[2]!,
      timestamp: 42,
      $metadata: {
        type: "cf-worker-event",
        requestId: "genuine",
        message: "GET https://rpc-stub-pager.internal/",
      },
    },
    ...failedDocsRequest(),
  ]);
  const result = await summary();
  expect(result).toContain("2 5xx responses: docs.iterate.com 2");
  expect(result).toContain(
    "3 errors: POST https://docs.iterate.com/_iterate/auth/refresh 2, GET https://rpc-stub-pager.internal/ 1",
  );
});

test("resets arriving between the count and evidence read never subtract away a genuine failure", async () => {
  const events: Record<string, unknown>[] = [
    {
      ...resetPair()[2]!,
      timestamp: 42,
      $metadata: {
        type: "cf-worker-event",
        requestId: "genuine",
        message: "GET https://rpc-stub-pager.internal/",
      },
    },
  ];
  await using _logs = queryableWorkersLogs(events, (query) => {
    if (query.view === "events") events.push(...resetPair());
  });
  const result = await summary();
  expect(result).toContain("1 errors: GET https://rpc-stub-pager.internal/ 1");
});

test("a full evidence page keeps the alarm and reports the cap", async () => {
  await using _logs = queryableWorkersLogs(Array.from({ length: 25 }, () => resetPair()).flat());
  using log = vi.spyOn(console, "log");
  const result = await summary();
  expect(result).toContain("50 errors: GET https://rpc-stub-pager.internal/ 50");
  expect(log).toHaveBeenCalledWith(
    JSON.stringify({ event: "prd-fault-alarm.reset-evidence", count: 100, capped: true }),
  );
});

test.for(["network", "HTML", "API", "schema", "re-count"])(
  "a failed optional %s query still posts the original errors and 5xx",
  async (failure) => {
    await using _logs = queryableWorkersLogs([...resetPair(), ...failedDocsRequest()], (query) => {
      if (failure === "re-count" && JSON.stringify(query.parameters.filters).includes('not_in"'))
        throw new Error("re-count failed");
      if (query.view !== "events") return;
      if (failure === "network") throw new Error("network failed");
      if (failure === "HTML") return new Response("<!DOCTYPE html>", { status: 502 });
      if (failure === "API") return Response.json({ success: false, errors: ["rate limited"] });
      if (failure === "schema")
        return Response.json({ success: true, result: { events: { events: [{}] } } });
    });
    using warn = vi.spyOn(console, "warn");
    const slack = fakeSlack();
    const result = await summary(() => slack.client);
    expect(result).toContain("2 5xx responses: docs.iterate.com 2");
    expect(result).toContain("4 errors:");
    expect(slack).toMatchObject({
      posts: [{ channel: slackChannelIds["#error-pulse"], text: result }],
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"event":"prd-fault-alarm.reset-classification-failed"'),
    );
  },
);

test("null optional evidence fields do not prevent classification of complete reset groups", async () => {
  const events = resetPair().map((event) => ({
    ...event,
    $metadata: { ...event.$metadata, error: null },
    $workers: {
      ...event.$workers,
      truncated: null,
      outcome: event.$metadata.type === "cf-worker-event" ? "exception" : null,
    },
  }));
  await using _logs = queryableWorkersLogs(events);
  using warn = vi.spyOn(console, "warn");
  await expect(summary()).resolves.toBe("prd is quiet");
  expect(warn).not.toHaveBeenCalled();
});

test("null identities leave ambiguous summaries visible without treating the payload as malformed", async () => {
  await using _logs = queryableWorkersLogs(
    resetPair().map((event) => ({
      ...event,
      $workers: { ...event.$workers, durableObjectId: null, scriptVersion: null },
    })),
  );
  using warn = vi.spyOn(console, "warn");
  const result = await summary();
  expect(result).toContain("2 errors: GET https://rpc-stub-pager.internal/ 2");
  expect(warn).not.toHaveBeenCalled();
});

test.for(["different time", "missing identity", "another worker"])(
  "a request ID shared with an unproven summary stays visible: %s",
  (reason) => {
    const events = resetPair();
    const other = { ...events[2]!, timestamp: 42, $workers: { ...events[2]!.$workers } };
    if (reason === "missing identity") other.$workers.durableObjectId = "";
    if (reason === "another worker") other.$workers.executionModel = "stateless";
    expect([...deployResetSummaries([...events, other])]).toEqual(["second"]);
  },
);

test("a stateless summary with a reset's request ID is never excluded from the count", async () => {
  const stateless = resetPair()[2]!;
  await using _logs = queryableWorkersLogs([
    ...resetPair(),
    { ...stateless, $workers: { ...stateless.$workers, executionModel: "stateless" } },
  ]);
  const result = await summary();
  expect(result).toContain("1 errors: GET https://rpc-stub-pager.internal/ 1");
});

test.for([undefined, null, "", "Network connection lost."])(
  "a structured error is counted exactly once with message %s",
  async (message) => {
    await using _logs = queryableWorkersLogs([
      {
        timestamp: 42,
        $metadata: { type: "cf-worker", message, error: "Network connection lost." },
        $workers: {},
      },
    ]);
    const result = await summary();
    expect(result).toContain("1 errors: Network connection lost. 1");
  },
);

test("the 11:52 window retains the structured delivery failure while removing the reset summaries", async () => {
  await using _logs = queryableWorkersLogs([
    ...resetPair(),
    {
      timestamp: 1790250570333,
      $metadata: { type: "cf-worker", error: "Network connection lost." },
      $workers: {
        executionModel: "durableObject",
        durableObjectId: "context",
        scriptVersion: { id: "next-version" },
      },
    },
  ]);
  const result = await summary();
  expect(result).toContain("1 errors: Network connection lost. 1");
  expect(result).not.toContain("rpc-stub-pager.internal");
});

test.for(["message", "error"])(
  "expected outcomes have the same policy in metadata.%s",
  async (key) => {
    const messages = [
      "Durable Object reset because its code was updated.",
      "itx.abort() reset the context",
      "Can't read from request stream after response has been sent.",
    ];
    await using _logs = queryableWorkersLogs(
      messages.map((message) => ({
        timestamp: 42,
        $metadata: { type: "cf-worker", [key]: message },
        $workers: {},
      })),
    );
    await expect(summary()).resolves.toBe("prd is quiet");
  },
);

test.for(["message", "error"])(
  "an unread /api body remains actionable in metadata.%s",
  async (key) => {
    await using _logs = queryableWorkersLogs([
      {
        timestamp: 42,
        $metadata: {
          type: "cf-worker",
          [key]: "Can't read from request stream after response has been sent.",
        },
        $workers: { event: { request: { url: "https://os.iterate.com/api?session=1" } } },
      },
    ]);
    const result = await summary();
    expect(result).toContain(
      "1 errors: Can't read from request stream after response has been sent. 1",
    );
  },
);

/** The page a run without state owes for `reading` (quiet elsewhere) in the half hour to `now`. */
function page(reading: Partial<FaultReading>) {
  return triageIncidents({ ...quiet, ...reading }, window, null).page?.text ?? null;
}

/** What one run without state over the half hour to `now` posts (or would post). */
async function summary(slack: (() => WebClient) | null = null) {
  return (await alarm({ window, state: null, cloudflare: credentials, slack })).summary;
}

/** A Workers Logs API that answers each query with `answer(the field it groups by)`. */
function workersLogs(answer: (groupBy: string | undefined) => unknown) {
  const fetch = vi.fn(async (_url: string, init: { body: string }) => {
    const query = JSON.parse(init.body) as {
      view: string;
      parameters: { groupBys?: { value: string }[] };
    };
    return new Response(
      JSON.stringify(
        query.view === "events"
          ? { success: true, result: { events: { events: [] } } }
          : answer(query.parameters.groupBys?.[0]?.value),
      ),
    );
  });
  vi.stubGlobal("fetch", fetch);
  return {
    fetch,
    async [Symbol.asyncDispose]() {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    },
  };
}

/** A prd whose only signal is `count` 5xx responses from lispwoso.com, `unlogged` more without
 *  a URL. Without a group, the one query that counts is the 5xx total. */
function serverErrorsOnly(count: number, unlogged = 0) {
  return (groupBy: string | undefined) => ({
    success: true,
    result: {
      calculations: [
        {
          aggregates: !groupBy
            ? [{ count: count + unlogged }]
            : groupBy === "$workers.event.request.url" && count
              ? [{ groupKey: "https://lispwoso.com/", count }]
              : [],
        },
      ],
    },
  });
}

/** A WebClient stand-in recording every post; the Nth post's ts is "N.0". */
function fakeSlack() {
  const posts: Record<string, unknown>[] = [];
  const client = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        posts.push(args);
        return { ok: true, ts: `${posts.length}.0` };
      },
    },
  } as unknown as WebClient;
  return { client, posts };
}

/** One run at `hhmm` on `day` after `state`, Workers Logs answering with `answer`. */
async function runAt(
  hhmm: string,
  state: AlarmState | null,
  slack: ReturnType<typeof fakeSlack>,
  answer = serverErrorsOnly(0),
  day = "2026-09-23",
) {
  await using _cloudflare = workersLogs(answer);
  return alarm({
    window: logWindow(new Date(`${day}T${hhmm}:00Z`), state),
    state,
    cloudflare: credentials,
    slack: () => slack.client,
  });
}

// Production 2026-09-24: two pager calls at 11:41:21.252Z, and two jsrpc calls at
// 10:30:06.305Z. In both pairs Cloudflare copied one requestId onto both reset lines.
function resetPair(message = "GET https://rpc-stub-pager.internal/") {
  const worker = {
    durableObjectId: "context",
    scriptVersion: { id: "version" },
    executionModel: "durableObject",
    truncated: false,
  };
  const exception = {
    timestamp: 1790250081252,
    $metadata: {
      type: "cf-worker",
      requestId: "first",
      message: "Durable Object reset because its code was updated.",
    },
    $workers: worker,
  };
  const summary = {
    ...exception,
    $metadata: { type: "cf-worker-event", requestId: "first", message },
    $workers: { ...worker, outcome: "exception" },
  };
  return [
    exception,
    exception,
    summary,
    { ...summary, $metadata: { ...summary.$metadata, requestId: "second" } },
  ];
}

// The Workers Logs wire contract used here: filters select events before grouping. Unlike a fixed
// count response, this fixture catches a discarded re-count or an exclusion that drops other rows.
type LogFilter =
  | { key: string; operation: string; value?: unknown }
  | { kind: "group"; filterCombination: "or"; filters: LogFilter[] };
type LogQuery = {
  view: string;
  limit?: number;
  parameters: { filters: LogFilter[]; groupBys?: { value: string }[] };
};
function queryableWorkersLogs(
  events: Record<string, unknown>[],
  intercept?: (query: LogQuery) => Response | void,
) {
  const fetch = vi.fn(async (_url: string, init: { body: string }) => {
    const query = JSON.parse(init.body) as LogQuery;
    const response = intercept?.(query);
    if (response) return response;
    const selected = events
      .map((event) => ({
        ...event,
        $metadata: { service: "os-prd", level: "error", ...(event.$metadata as object) },
      }))
      .filter((event) =>
        query.parameters.filters.every((filter) => matchesLogFilter(event, filter)),
      );
    if (query.view === "events")
      return Response.json({
        success: true,
        result: { events: { events: selected.slice(0, query.limit) } },
      });
    const groupBy = query.parameters.groupBys?.[0]?.value;
    if (!groupBy)
      return Response.json({
        success: true,
        result: { calculations: [{ aggregates: [{ count: selected.length }] }] },
      });
    const counts = new Map<string, number>();
    for (const event of selected) {
      const value = logField(event, groupBy);
      if (typeof value === "string") counts.set(value, (counts.get(value) || 0) + 1);
    }
    return Response.json({
      success: true,
      result: {
        calculations: [
          {
            aggregates: [...counts]
              .sort((a, b) => b[1] - a[1])
              .map(([groupKey, count]) => ({ groupKey, count })),
          },
        ],
      },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return {
    fetch,
    async [Symbol.asyncDispose]() {
      vi.unstubAllGlobals();
    },
  };
}
function logField(event: unknown, key: string): unknown {
  return key.split(".").reduce(
    // oxlint-disable-next-line iterate/simple-truthiness-check -- the wire fixture contains unknown nested values, including strings and numbers
    (value, part) => (value && typeof value === "object" ? Reflect.get(value, part) : undefined),
    event,
  );
}
function matchesLogFilter(event: unknown, filter: LogFilter): boolean {
  if ("kind" in filter) return filter.filters.some((child) => matchesLogFilter(event, child));
  const value = logField(event, filter.key);
  // oxlint-disable-next-line iterate/simple-truthiness-check -- Cloudflare is_null distinguishes missing fields from present empty strings and zero
  if (filter.operation === "is_null") return value === undefined || value === null;
  // oxlint-disable-next-line iterate/simple-truthiness-check -- non-existence differs from an empty message, which is selected by eq ""
  if (value === undefined || value === null) return false;
  switch (filter.operation) {
    case "eq":
      return value === filter.value;
    case "neq":
      return value !== filter.value;
    case "gte":
      return typeof value === "number" && value >= Number(filter.value);
    case "includes":
      return typeof value === "string" && value.includes(String(filter.value));
    case "not_includes":
      return typeof value === "string" && !value.includes(String(filter.value));
    case "in":
      return typeof value === "string" && String(filter.value).split(",").includes(value);
    case "not_in":
      return typeof value === "string" && !String(filter.value).split(",").includes(value);
    case "regex":
      return typeof value === "string" && new RegExp(String(filter.value)).test(value);
    default:
      throw new Error(`unsupported test filter: ${filter.operation}`);
  }
}
function failedDocsRequest() {
  return ["durableObject", "stateless"].map((executionModel) => ({
    timestamp: 42,
    $metadata: {
      type: "cf-worker-event",
      requestId: `docs-${executionModel}`,
      message: "POST https://docs.iterate.com/_iterate/auth/refresh",
    },
    $workers: {
      executionModel,
      outcome: "ok",
      event: {
        request: { url: "https://docs.iterate.com/_iterate/auth/refresh" },
        response: { status: 500 },
      },
    },
  }));
}
