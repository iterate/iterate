import type { WebClient } from "@slack/web-api";
import { expect, test, vi } from "vitest";
import {
  alarm,
  deployResetSummaries,
  type FaultReading,
  renderFaultPage,
  run,
} from "./prd-fault-alarm.ts";
import { slackChannelIds } from "./slack.ts";

const quiet: FaultReading = {
  serverErrors: [],
  heals: [],
  errors: [],
};
const now = new Date("2026-09-23T07:30:00Z");
const credentials = { accountId: "account", apiToken: "token" };

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
    "🚨 prd fault page: os-prd, 30 min to 07:30 UTC <@U067G4QRFK2>
    • 13 5xx responses: garple.com 7, lispwoso.com 6
    • 1815 platform-failure heals: project 1279, repo 536
    • 1201 errors: ProjectDurableObject.jsrpc 1199, internal error; reference = … 2
    <https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/workers-and-pages/observability|Workers Logs>"
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
  const slack = fakeSlack([]);
  await expect(
    alarm({ now, windowEnd: now, cloudflare: credentials, slack: () => slack.client }),
  ).rejects.toThrow('Workers Logs query failed: [{"code":10000,"message":"Authentication error"}]');
  expect(cloudflare.fetch).toHaveBeenCalledTimes(6);
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

// A page is the alarm and the run ends green; the page repeats at most hourly.
test.for([
  { name: "a quiet prd: no page", serverErrors: 0, history: [], posted: false },
  { name: "no page in the last hour: pages", serverErrors: 1, history: [], posted: true },
  {
    name: "paged half an hour ago: stays quiet",
    serverErrors: 1,
    history: [{ at: "2026-09-23T07:00:05Z", bot_id: "B1" }],
    posted: false,
  },
  {
    name: "paged over an hour ago: pages again",
    serverErrors: 1,
    history: [{ at: "2026-09-23T06:25:05Z", bot_id: "B1" }],
    posted: true,
  },
  {
    name: "a person quoting a page is not one",
    serverErrors: 1,
    history: [{ at: "2026-09-23T07:00:05Z", bot_id: undefined }],
    posted: true,
  },
])("a run that reads prd resolves: $name", async (row) => {
  await using _cloudflare = workersLogs(serverErrorsOnly(row.serverErrors));
  const slack = fakeSlack(
    row.history.map((message) => ({
      ts: String(Date.parse(message.at) / 1000),
      bot_id: message.bot_id,
      text: ":rotating_light: prd fault page: os-prd, 30 min to 07:00 UTC",
    })),
  );
  const expected = row.serverErrors
    ? page({ serverErrors: [["https://lispwoso.com/", row.serverErrors]] })
    : "os-prd is quiet";
  await expect(
    alarm({ now, windowEnd: now, cloudflare: credentials, slack: () => slack.client }),
  ).resolves.toBe(expected);
  expect(slack).toMatchObject({
    posts: row.posted ? [{ channel: slackChannelIds["#error-pulse"], text: expected }] : [],
  });
});

test("a dry run (no Slack client) resolves to the page it would post", async () => {
  await using _cloudflare = workersLogs(serverErrorsOnly(1));
  await expect(alarm({ now, windowEnd: now, cloudflare: credentials, slack: null })).resolves.toBe(
    page({ serverErrors: [["https://lispwoso.com/", 1]] }),
  );
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
  const slack = fakeSlack([]);
  await expect(
    alarm({ now, windowEnd: now, cloudflare: credentials, slack: () => slack.client }),
  ).resolves.toBe("os-prd is quiet");
  expect(slack).toMatchObject({ posts: [] });
  expect(logs.fetch).toHaveBeenCalledTimes(9);
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
  const result = await alarm({ now, windowEnd: now, cloudflare: credentials, slack: null });
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
  const result = await alarm({ now, windowEnd: now, cloudflare: credentials, slack: null });
  expect(result).toContain("1 errors: GET https://rpc-stub-pager.internal/ 1");
});

test("a full evidence page keeps the alarm and reports the cap", async () => {
  await using _logs = queryableWorkersLogs(Array.from({ length: 25 }, () => resetPair()).flat());
  using log = vi.spyOn(console, "log");
  const result = await alarm({ now, windowEnd: now, cloudflare: credentials, slack: null });
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
    const slack = fakeSlack([]);
    const result = await alarm({
      now,
      windowEnd: now,
      cloudflare: credentials,
      slack: () => slack.client,
    });
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
  await expect(alarm({ now, windowEnd: now, cloudflare: credentials, slack: null })).resolves.toBe(
    "os-prd is quiet",
  );
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
  const result = await alarm({ now, windowEnd: now, cloudflare: credentials, slack: null });
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
  const summary = resetPair()[2]!;
  await using _logs = queryableWorkersLogs([
    ...resetPair(),
    { ...summary, $workers: { ...summary.$workers, executionModel: "stateless" } },
  ]);
  const result = await alarm({ now, windowEnd: now, cloudflare: credentials, slack: null });
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
    const result = await alarm({ now, windowEnd: now, cloudflare: credentials, slack: null });
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
  const result = await alarm({ now, windowEnd: now, cloudflare: credentials, slack: null });
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
    await expect(
      alarm({ now, windowEnd: now, cloudflare: credentials, slack: null }),
    ).resolves.toBe("os-prd is quiet");
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
    const result = await alarm({ now, windowEnd: now, cloudflare: credentials, slack: null });
    expect(result).toContain(
      "1 errors: Can't read from request stream after response has been sent. 1",
    );
  },
);

/** The page for `reading` (quiet elsewhere) in the half hour to `now`. */
function page(reading: Partial<FaultReading>) {
  return renderFaultPage({ ...quiet, ...reading }, now);
}

/** A Workers Logs API that answers each query with `answer(the field it groups by)`. */
function workersLogs(answer: (groupBy: string) => unknown) {
  const fetch = vi.fn(async (_url: string, init: { body: string }) => {
    const query = JSON.parse(init.body) as {
      view: string;
      parameters: { groupBys?: { value: string }[] };
    };
    return new Response(
      JSON.stringify(
        query.view === "events"
          ? { success: true, result: { events: { events: [] } } }
          : answer(query.parameters.groupBys![0]!.value),
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

/** A prd whose only signal is `count` 5xx responses from lispwoso.com. */
function serverErrorsOnly(count: number) {
  return (groupBy: string) => ({
    success: true,
    result: {
      calculations: [
        {
          aggregates:
            groupBy === "$workers.event.request.url" && count
              ? [{ groupKey: "https://lispwoso.com/", count }]
              : [],
        },
      ],
    },
  });
}

/** A WebClient stand-in: serves `messages` as the channel history (honouring `oldest`, as Slack
 *  does) and records every post. */
function fakeSlack(messages: Array<{ ts: string; bot_id: string | undefined; text: string }>) {
  const posts: unknown[] = [];
  const client = {
    conversations: {
      history: async (args: { oldest: string }) => ({
        messages: messages.filter((message) => Number(message.ts) >= Number(args.oldest)),
      }),
    },
    chat: {
      postMessage: async (args: unknown) => {
        posts.push(args);
        return { ok: true, ts: "999.0" };
      },
    },
  } as unknown as WebClient;
  return { client, posts };
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
    const counts = new Map<string, number>();
    for (const event of selected) {
      const value = logField(event, query.parameters.groupBys![0]!.value);
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
