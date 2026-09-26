import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebClient } from "@slack/web-api";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import {
  type AlarmState,
  alarm,
  type LogFilter,
  DEPLOY_RESET_SUMMARIES,
  deployResetSummaries,
  type Exclusion,
  exclusionQueries,
  type FaultReading,
  filterNodes,
  logWindow,
  MAX_FILTER_NODES,
  PIN_QUIET_DAYS,
  PINNED_WORKAROUNDS,
  pinnedWorkarounds,
  RAY_EXCLUSIONS,
  run,
  triageIncidents,
} from "./prd-fault-alarm.ts";
import { slackChannelIds } from "./slack.ts";

const quiet: FaultReading = {
  serverErrors: [],
  heals: [],
  healEvents: [],
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
  ).toBe(
    [
      "🚨 prd fault page: 07:00–07:30 UTC <@U067G4QRFK2>",
      "• 13 5xx responses: garple.com 7, lispwoso.com 6",
      "• 1815 platform-failure heals: project 1279, repo 536",
      "• 1201 errors: ProjectDurableObject.jsrpc 1199, internal error; reference = … 2",
      "<https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/workers-and-pages/observability|Workers Logs>",
      "No state from the last run: an incident already paged pages again.",
    ].join("\n"),
  );
});

test.for([
  ["a quiet prd", {}, false],
  ["one 5xx", { serverErrors: [["https://lispwoso.com/", 1]] }, true],
  ["9 heals", { heals: [["repo", 9]] }, false],
  ["10 heals", { heals: [["repo", 10]] }, true],
  ["one error", { errors: [["boom", 1]] }, true],
] satisfies [string, Partial<FaultReading>, boolean][])("%s pages: %s", ([, reading, pages]) => {
  expect(page(reading) !== null).toBe(pages);
});

// A run that could not read prd must fail, never pass as a quiet prd.
test("a run that cannot read prd fails: a failed Workers Logs query", async () => {
  const cloudflare = workersLogs(() => ({
    success: false,
    errors: [{ code: 10000, message: "Authentication error" }],
  }));
  const slack = fakeSlack();
  await expect(summary(() => slack.client)).rejects.toThrow(
    'Workers Logs query failed: [{"code":10000,"message":"Authentication error"}]',
  );
  expect(cloudflare.fetch).toHaveBeenCalledTimes(12);
  expect(slack).toMatchObject({ posts: [] });
});

test("a run that cannot read prd fails: no Cloudflare credentials", async () => {
  const cloudflare = workersLogs(() => ({ success: true }));
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  await expect(run({ dryRun: true })).rejects.toThrow(
    "run under doppler --project os --config prd",
  );
  expect(cloudflare.fetch).not.toHaveBeenCalled();
});

// Cloudflare's HTML error page, a 5xx or not, is its own failure, not an answer about the query.
test.for([502, 200])(
  "a Workers Logs query answered with an HTML %i is asked again, and the retry logged",
  async (status) => {
    const cloudflare = workersLogs(serverErrorsOnly(0));
    cloudflare.fetch.mockImplementationOnce(async () => cloudflareErrorPage(status));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(summary()).resolves.toBe("prd is quiet");
    // A quiet run's 12 queries, one of them twice.
    expect(cloudflare.fetch).toHaveBeenCalledTimes(13);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith({
      event: "prd-fault-alarm.platform-failure-retry",
      view: "calculations",
      status,
      message: `Workers Logs query answered HTTP ${status} (text/html; charset=UTF-8): ${errorPage.slice(0, 200)}`,
      attempt: 1,
      retryInMs: 0,
    });
  },
);

test("a run that cannot read prd fails: Cloudflare keeps answering its HTML error page", async () => {
  const cloudflare = workersLogs(serverErrorsOnly(0));
  cloudflare.fetch.mockImplementation(async () => cloudflareErrorPage(502));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const slack = fakeSlack();
  await expect(summary(() => slack.client)).rejects.toMatchObject({
    message: `Workers Logs query answered HTTP 502 (text/html; charset=UTF-8): ${errorPage.slice(0, 200)}`,
  });
  // Each of the 12 queries asked four times, the first and three repeats, then no more.
  await vi.waitFor(() => expect(cloudflare.fetch).toHaveBeenCalledTimes(48));
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ event: "prd-fault-alarm.platform-failure-retry", attempt: 3 }),
  );
  expect(warn).not.toHaveBeenCalledWith(expect.objectContaining({ attempt: 4 }));
  expect(slack).toMatchObject({ posts: [] });
});

// A dispatch on a branch reads and pages like any run, but must not move main's read window or its
// open incidents.
test.for([
  ["refs/heads/main", true],
  ["refs/heads/a-branch", false],
  [undefined, false],
] as const)("a run on %s keeps its state: %s", async ([ref, kept]) => {
  workersLogs(serverErrorsOnly(0));
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", credentials.accountId);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", credentials.apiToken);
  const directory = mkdtempSync(join(tmpdir(), "prd-fault-alarm-"));
  try {
    const stateOut = join(directory, "state.json");
    await expect(run({ ref, stateOut })).resolves.toBe("prd is quiet");
    expect(existsSync(stateOut)).toBe(kept);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

// Each fault is an incident: a new one pages, its repeats go into that page's thread.
test("a quiet run never builds a Slack client, so a broken token cannot turn it red", async () => {
  workersLogs(serverErrorsOnly(0));
  const slack = vi.fn(() => {
    throw new Error("no Slack token");
  });
  await expect(
    alarm({ window, state: null, cloudflare: credentials, slack }),
  ).resolves.toMatchObject({ summary: "prd is quiet" });
  expect(slack).not.toHaveBeenCalled();
});

test("a quiet prd posts nothing and the next run reads on from where this one stopped", async () => {
  workersLogs(serverErrorsOnly(0));
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
  const state = readUntil && { readUntil, incidents: {}, pins: {} };
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
      ["rpc-stub-pager-redialed", 3],
      ["rpc-stub-pager-redial-failed", 1],
    ],
  };
  const recovery = "• pagers in the window: 4 dropped, 3 re-dialed, 1 gave up";
  const opened = triageIncidents(reading, window, null);
  expect(opened.page?.text).toContain(recovery);
  const state = { readUntil: now.toISOString(), incidents: opened.incidents, pins: {} };
  expect(triageIncidents(reading, window, state).replies[0]?.text).toContain(recovery);
  expect(triageIncidents({ ...reading, pagers: [] }, window, null).page?.text).not.toContain(
    "pagers",
  );
});

test("a failed invocation's request line is one incident per method and host, not per path", () => {
  const opened = triageIncidents(
    {
      ...quiet,
      errors: [
        ["GET https://est-01k4yj6assfqfshsahjshe9pdp.iterate.com/credentials.csv", 10],
        ["GET https://est-01k4yj6assfqfshsahjshe9pdp.iterate.com/.env?x=1", 1],
        ["POST https://k.iterate.com/?rest_route=%2Fbatch%2Fv1", 1],
        ["call timed out", 2],
      ],
    },
    window,
    null,
  );
  expect(Object.keys(opened.incidents)).toEqual([
    "errors: GET https://est-01k4yj6assfqfshsahjshe9pdp.iterate.com/…",
    "errors: POST https://k.iterate.com/…",
    "errors: call timed out",
  ]);
});

test("every first-party prd Worker is read, not os-prd alone", async () => {
  const cloudflare = workersLogs(serverErrorsOnly(0));
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
  const state = { readUntil: now.toISOString(), incidents: opened.incidents, pins: {} };
  expect(triageIncidents({ ...quiet, heals: [["repo", 1]] }, window, state).replies).toHaveLength(
    1,
  );
  expect(triageIncidents({ ...quiet, heals: [["project", 1]] }, window, state).page).toBeNull();
});

test("a dry run (no Slack client) resolves to the page it would post", async () => {
  workersLogs(serverErrorsOnly(1));
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
  const logs = queryableWorkersLogs(resetPair());
  const slack = fakeSlack();
  await expect(summary(() => slack.client)).resolves.toBe("prd is quiet");
  expect(slack).toMatchObject({ posts: [] });
  // the re-count reads each of its two counts in two parts: the resets' request IDs, and the rest
  expect(logs.fetch).toHaveBeenCalledTimes(17);
});

test("a fresh error sharing the pager URL and every HTTP 5xx survive reset classification", async () => {
  queryableWorkersLogs([
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
    "3 errors: POST https://docs.iterate.com/… 2, GET https://rpc-stub-pager.internal/… 1",
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
  queryableWorkersLogs(events, (query) => {
    if (query.view === "events") events.push(...resetPair());
  });
  const result = await summary();
  expect(result).toContain("1 errors: GET https://rpc-stub-pager.internal/… 1");
});

test("a full evidence page keeps the alarm and reports the cap", async () => {
  queryableWorkersLogs(Array.from({ length: 25 }, () => resetPair()).flat());
  const log = vi.spyOn(console, "log");
  const result = await summary();
  expect(result).toContain("50 errors: GET https://rpc-stub-pager.internal/… 50");
  expect(log).toHaveBeenCalledWith(
    JSON.stringify({ event: "prd-fault-alarm.reset-evidence", count: 100, capped: true }),
  );
});

test.for(["network", "HTML", "API", "schema", "re-count"])(
  "a failed optional %s query still posts the original errors and 5xx",
  async (failure) => {
    queryableWorkersLogs([...resetPair(), ...failedDocsRequest()], (query) => {
      if (failure === "re-count" && JSON.stringify(query.parameters.filters).includes('not_in"'))
        throw new Error("re-count failed");
      if (query.view !== "events") return;
      if (failure === "network") throw new Error("network failed");
      if (failure === "HTML") return new Response("<!DOCTYPE html>", { status: 502 });
      if (failure === "API") return Response.json({ success: false, errors: ["rate limited"] });
      if (failure === "schema")
        return Response.json({ success: true, result: { events: { events: [{}] } } });
    });
    const warn = vi.spyOn(console, "warn");
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
  queryableWorkersLogs(events);
  const warn = vi.spyOn(console, "warn");
  await expect(summary()).resolves.toBe("prd is quiet");
  expect(warn).not.toHaveBeenCalled();
});

test("null identities leave ambiguous summaries visible without treating the payload as malformed", async () => {
  queryableWorkersLogs(
    resetPair().map((event) => ({
      ...event,
      $workers: { ...event.$workers, durableObjectId: null, scriptVersion: null },
    })),
  );
  const warn = vi.spyOn(console, "warn");
  const result = await summary();
  expect(result).toContain("2 errors: GET https://rpc-stub-pager.internal/… 2");
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
  queryableWorkersLogs([
    ...resetPair(),
    { ...stateless, $workers: { ...stateless.$workers, executionModel: "stateless" } },
  ]);
  const result = await summary();
  expect(result).toContain("1 errors: GET https://rpc-stub-pager.internal/… 1");
});

test.for([undefined, null, "", "Network connection lost."])(
  "a structured error is counted exactly once with message %s",
  async (message) => {
    queryableWorkersLogs([
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
  queryableWorkersLogs([
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
    queryableWorkersLogs(
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
    queryableWorkersLogs([
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

// A killed `iterate tunnel` leaves its fetch route's target, a lent stub, offline until its rule is
// un-set: 502s, every hop logging a 502 summary, all in the ray of the context DO's
// `expression-fetch.rpc-stub-offline` info line.
test("a tunnel's offline-stub 502s, every hop of them, page nothing", async () => {
  queryableWorkersLogs(rpcStubOfflineRequest("vite-ping"));
  await expect(summary()).resolves.toBe("prd is quiet");
});

test.for([
  ["a 500 in the offline request's ray", { status: 500 }, "4 5xx responses: blog--p.iterate.app 4"],
  ["a 502 in another ray", { rayId: "other" }, "4 5xx responses: blog--p.iterate.app 4"],
  ["a 502 without a ray", { rayId: undefined }, "4 5xx responses: blog--p.iterate.app 4"],
  [
    "an exception in the offline request's ray",
    { type: "cf-worker", message: "boom", status: undefined },
    "4 errors: boom 4",
  ],
] as const)("%s still pages", async ([, change, line]) => {
  queryableWorkersLogs([
    ...rpcStubOfflineRequest("vite-ping"),
    ...rpcStubOfflineRequest("vite-ping", change).slice(1),
  ]);
  expect(await summary()).toContain(line);
});

// A deploy that resets a context an expression fetch dialed, where the hop could not send it again
// (a request with a body), answers 503: every hop's 503 summary is in the ray of the context DO's
// `expression-fetch.deploy-reset` info line (prd os-prd 2026-09-25 14:45:21Z paged on these as 500s).
const deployReset = { event: "expression-fetch.deploy-reset", status: 503 };
test("a deploy reset's 503s, every hop of them, page nothing", async () => {
  queryableWorkersLogs(rpcStubOfflineRequest("post", {}, deployReset));
  await expect(summary()).resolves.toBe("prd is quiet");
});

test.for([
  [
    "a 502 in a deploy reset's ray",
    rpcStubOfflineRequest("post", { status: 502 }, deployReset).slice(1),
  ],
  ["a 503 in an offline stub's ray", rpcStubOfflineRequest("vite-ping", { status: 503 }).slice(1)],
] as const)("%s still pages", async ([, summaries]) => {
  queryableWorkersLogs([
    ...rpcStubOfflineRequest("post", {}, deployReset),
    ...rpcStubOfflineRequest("vite-ping"),
    ...summaries,
  ]);
  expect(await summary()).toContain("4 5xx responses: blog--p.iterate.app 4");
});

test.for(["capped", "failed"])(
  "a %s read of the offline rays keeps every 502 paging",
  async (reason) => {
    const events = [
      ...rpcStubOfflineRequest("vite-ping"),
      ...(reason === "capped"
        ? Array.from({ length: 2000 }, (_, i) => rpcStubOfflineRequest(`t${i}`)[0]!)
        : []),
    ];
    queryableWorkersLogs(events, (query) => {
      if (reason === "failed" && JSON.stringify(query.parameters.groupBys).includes("rayId"))
        throw new Error("network failed");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await summary()).toContain("4 5xx responses: blog--p.iterate.app 4");
  },
);

// A visitor whose connection to a tunnel's WebSocket vanished without a close frame: the edge logs
// `fetch-upgrade.local-gone` at info, and the runtime fails that invocation with "Network connection
// lost." and an exception summary, all in one ray (apps/os context/fetch-upgrade-splice.ts).
test("a vanished visitor's Network connection lost. and its exception summary page nothing", async () => {
  queryableWorkersLogs(vanishedVisitorRequest("gone"));
  await expect(summary()).resolves.toBe("prd is quiet");
});

test.for([
  [
    "Network connection lost. in another ray",
    vanishedVisitorRequest("other").slice(1),
    "2 errors: Network connection lost. 1, GET https://here-public.templestein.com/… 1",
  ],
  [
    "another error in the vanished visitor's ray",
    [
      {
        ...vanishedVisitorRequest("gone")[1]!,
        $metadata: { type: "cf-worker", rayId: "gone", message: "boom" },
      },
    ],
    "1 errors: boom 1",
  ],
] as const)("%s still pages", async ([, events, line]) => {
  queryableWorkersLogs([...vanishedVisitorRequest("gone"), ...events]);
  expect(await summary()).toContain(line);
});

// Probed against prd's Workers Logs: 16 leaves, a group of 15, or 13 leaves beside a group of a
// group pass; one more leaf in any of them answers "maximum is 16 filter nodes".
test("filter nodes count as Cloudflare counts them: every leaf and every group, not the top-level list", () => {
  const leaf = {
    key: "$metadata.message",
    operation: "neq",
    value: "probe",
    type: "string",
  } as const;
  const or = (...filters: LogFilter[]): LogFilter => ({
    kind: "group",
    filterCombination: "or",
    filters,
  });
  const leaves = (n: number) => Array.from({ length: n }, () => leaf);
  expect(filterNodes(leaves(16))).toBe(MAX_FILTER_NODES);
  expect(filterNodes([or(...leaves(15))])).toBe(MAX_FILTER_NODES);
  expect(filterNodes([...leaves(13), or(or(leaf))])).toBe(MAX_FILTER_NODES);
  expect(filterNodes([...leaves(14), or(or(leaf))])).toBe(MAX_FILTER_NODES + 1);
});

test("every query a run sends stays within 16 filter nodes, with every outcome's rays, a ray all three logged, and deploy resets", async () => {
  const [offline, deployed, gone] = RAY_EXCLUSIONS.map(({ event }) => event);
  // 1,997 rays and one logged by all three: as many as a run excludes, four `not_in` of them
  const events = [
    ...rayInfoLines(offline!, [...rays("offline-", 899), "shared"]),
    ...rayInfoLines(deployed!, [...rays("deployed-", 599), "shared"]),
    ...rayInfoLines(gone!, [...rays("gone-", 497), "shared"]),
    ...rpcStubOfflineRequest("offline-7").slice(1),
    ...vanishedVisitorRequest("gone-3").slice(1),
    { timestamp: 42, $metadata: { type: "cf-worker", rayId: "shared", message: "boom" } },
    { timestamp: 42, $metadata: { type: "cf-worker", error: "structured" } },
    ...failedDocsRequest(),
    ...resetPair(),
  ];
  const logs = queryableWorkersLogs(events);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const result = await summary();
  const nodes = logs.fetch.mock.calls.map(([, init]) =>
    filterNodes((JSON.parse(init.body) as LogQuery).parameters.filters),
  );
  expect(Math.max(...nodes)).toBeLessThanOrEqual(MAX_FILTER_NODES);
  expect(result).toContain("2 5xx responses: docs.iterate.com 2\n");
  // The expected 502s and the vanished visitor's two rows go. Past one `not_in` of rays, a query
  // cannot also hold the resets' keep: their summaries page, and the warn says so.
  expect(result).toContain(
    "6 errors: POST https://docs.iterate.com/… 2, GET https://rpc-stub-pager.internal/… 2, boom 1, structured 1\n",
  );
  expect(warn).toHaveBeenCalledWith(
    JSON.stringify({
      event: "prd-fault-alarm.exclusion-dropped",
      dropped: [DEPLOY_RESET_SUMMARIES.name],
      rows: 2,
    }),
  );
});

// The check that fails in CI, not on prd, when an outcome's keep cannot fit beside a count's own
// filters: each outcome applies in full while the rays a run excludes fit one `not_in`.
test("each expected outcome applies in full beside the others and deploy resets", async () => {
  const events = RAY_EXCLUSIONS.flatMap(({ event }, index) => [
    ...rayInfoLines(event, [...rays(`${index}-`, 100)]),
    {
      timestamp: 42,
      $metadata: { type: "cf-worker", rayId: `${index}-7`, message: `boom ${index}` },
    },
    {
      timestamp: 42,
      $metadata: {
        type: "cf-worker",
        rayId: `${index}-8`,
        message: "",
        error: `structured ${index}`,
      },
    },
  ]);
  const logs = queryableWorkersLogs([
    ...events,
    ...rpcStubOfflineRequest("0-3").slice(1),
    ...vanishedVisitorRequest("2-3").slice(1),
    ...resetPair(),
  ]);
  const warn = vi.spyOn(console, "warn");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await summary();
  const { reading } = z
    .object({
      reading: z.object({ serverErrors: z.array(z.unknown()), errors: z.array(z.unknown()) }),
    })
    .parse(
      JSON.parse(String(log.mock.calls.find(([line]) => String(line).includes('"reading"'))![0])),
    );
  expect(reading).toEqual({
    serverErrors: [],
    errors: [...RAY_EXCLUSIONS.keys()]
      .flatMap((index) => [`boom ${index}`, `structured ${index}`])
      .sort((a, b) => Number(a.startsWith("structured")) - Number(b.startsWith("structured")))
      .map((label) => [label, 1]),
  });
  expect(warn).not.toHaveBeenCalled();
  for (const [, init] of logs.fetch.mock.calls)
    expect(filterNodes((JSON.parse(init.body) as LogQuery).parameters.filters)).toBeLessThanOrEqual(
      MAX_FILTER_NODES,
    );
});

test.for([
  ["errors by message", "$metadata.message", true],
  ["5xx by URL", "$workers.event.request.url", false],
] as const)(
  "the split queries count exactly what the one query counted: %s",
  ([, groupBy, errors]) => {
    const [offline, deployed, gone] = RAY_EXCLUSIONS.map((exclusion) => ({
      ...exclusion,
      name: exclusion.event,
      key: "$metadata.rayId",
    }));
    const answers: Exclusion[] = [
      { ...offline!, values: [...rays("o-", 1200), "s"] },
      { ...deployed!, values: ["d-0", "d-1", "s"] },
    ];
    const exclusions: Exclusion[] = errors
      ? [
          { ...DEPLOY_RESET_SUMMARIES, values: ["first", "second"] },
          ...answers,
          { ...gone!, values: ["g-0", "g-1"] },
        ]
      : answers;
    const row = (
      rayId: string | undefined,
      type: string | undefined,
      message: string,
      workers: Record<string, unknown> = {},
      requestId?: string,
    ) => ({
      $metadata: { service: "os-prd", level: "error", type, rayId, requestId, message },
      $workers: { event: { request: { url: `https://${message}.test/` } }, ...workers },
    });
    const status = (code: number | undefined, outcome = "ok") => ({
      outcome,
      event: { request: { url: "https://host.test/" }, response: { status: code } },
    });
    const events = [
      // an offline stub's rays: first and third `not_in` chunk
      ...["o-0", "o-1100"].flatMap((ray) => [
        row(ray, "cf-worker-event", "GET 502", status(502)),
        row(ray, "cf-worker-event", "GET 500", status(500)),
        row(ray, "cf-worker-event", "GET no status", status(undefined)),
        row(ray, "cf-worker", "boom"),
      ]),
      // a deploy reset's answer
      row("d-0", "cf-worker-event", "POST 503", status(503)),
      row("d-0", "cf-worker-event", "POST 502", status(502)),
      // a vanished visitor, and a row whose type Workers Logs left out
      row("g-0", "cf-worker", "Network connection lost."),
      row("g-0", "cf-worker-event", "GET exception", status(101, "exception")),
      row("g-0", "cf-worker-event", "GET ok", status(101)),
      row("g-0", "cf-worker", "other"),
      row("g-1", undefined, "untyped"),
      // one ray both answers logged
      row("s", "cf-worker-event", "GET 502", status(502)),
      row("s", "cf-worker-event", "POST 503", status(503)),
      row("s", "cf-worker-event", "GET 500", status(500)),
      row("s", "cf-worker", "boom"),
      // no ray, and a ray no outcome logged
      row(undefined, "cf-worker-event", "GET 502", status(502)),
      row(undefined, "cf-worker", "Network connection lost."),
      row("x", "cf-worker-event", "GET 502", status(502)),
      // a reset's summaries: a Durable Object's, a stateless one's, and another type
      row(undefined, "cf-worker-event", "GET reset", { executionModel: "durableObject" }, "first"),
      row(undefined, "cf-worker-event", "GET reset", { executionModel: "stateless" }, "first"),
      row(undefined, "cf-worker", "GET reset", { executionModel: "durableObject" }, "second"),
      row(
        "o-5",
        "cf-worker-event",
        "GET reset",
        { ...status(500), executionModel: "durableObject" },
        "second",
      ),
    ];
    const base: LogFilter[] = errors
      ? [{ key: "$metadata.level", operation: "eq", value: "error", type: "string" }]
      : [{ key: "$workers.event.response.status", operation: "gte", value: 500, type: "number" }];
    const counted = (filterLists: LogFilter[][]) => {
      const counts = new Map<string, number>();
      for (const filters of filterLists)
        for (const event of events)
          if (filters.every((filter) => matchesLogFilter(event, filter))) {
            const key = String(logField(event, groupBy));
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
      return Object.fromEntries([...counts].sort());
    };
    const parts = exclusionQueries(base, exclusions);
    // a part too big for its keeps (a reset's request IDs in the shared ray) holds no rows here
    expect(
      counted(parts.filter(({ dropped }) => dropped.length).map(({ filters }) => filters)),
    ).toEqual({});
    expect(counted(parts.map(({ filters }) => filters))).toEqual(
      counted([oneQuery(base, exclusions)]),
    );
    expect(Object.values(counted([base])).reduce((sum, n) => sum + n)).toBeGreaterThan(
      Object.values(counted([oneQuery(base, exclusions)])).reduce((sum, n) => sum + n),
    );
  },
);

// A workaround whose defect is too rare for a failing test is pinned by its heal's absence.
const [heldAlarm] = PINNED_WORKAROUNDS;
const day = 86_400_000;
test("a pinned workaround posts once when its heal has been absent PIN_QUIET_DAYS, never again, and a heal after that starts the count over", () => {
  const heal: [string, number][] = [["iterate-context.platform-failure-alarm-rearm", 2]];
  let state: AlarmState | null = null;
  const runs = (
    [
      [heal, 0],
      [[], PIN_QUIET_DAYS - 0.01],
      [[], PIN_QUIET_DAYS],
      [[], PIN_QUIET_DAYS + 1],
      [heal, PIN_QUIET_DAYS + 2],
    ] as const
  ).map(([heals, days]) => {
    const outcome = pinnedWorkarounds([...heals], at(days), state);
    state = { readUntil: at(days).to.toISOString(), incidents: {}, pins: outcome.pins };
    return outcome;
  });
  expect({
    posts: runs.map((outcome) => outcome.posts),
    pins: runs.map((outcome) => outcome.pins[heldAlarm!.event]),
  }).toEqual({
    posts: [
      [],
      [],
      [
        "✅ Cloudflare seems to have fixed held Durable Object alarms: delete the overdue watch in apps/os/src/alarm-coordinator.ts. prd has logged no `iterate-context.platform-failure-alarm-*` since 2026-09-23 (28 days) <@U067G4QRFK2>",
        "✅ Cloudflare seems to have fixed the Worker Loader defect at facet start: delete the restart in apps/os/src/context/facet-host.ts (`isFacetStartPlatformFailure`). prd has logged no `facet.platform-failure-*` since 2026-09-23 (28 days) <@U067G4QRFK2>",
        "✅ Cloudflare seems to have fixed the Worker Loader clone-version defect in workers.get: delete its retire and replay in apps/os/src/context/built-ins.ts. prd has logged no `workers.platform-failure-*` since 2026-09-23 (28 days) <@U067G4QRFK2>",
      ],
      [],
      [],
    ],
    pins: [
      { lastSeen: now.toISOString(), told: false },
      { lastSeen: now.toISOString(), told: false },
      { lastSeen: now.toISOString(), told: true },
      { lastSeen: now.toISOString(), told: true },
      { lastSeen: at(PIN_QUIET_DAYS + 2).to.toISOString(), told: false },
    ],
  });
});

test("a run without a pin's state starts its count: a late post, never a false one", () => {
  expect(pinnedWorkarounds([], window, null)).toEqual({
    posts: [],
    pins: {
      "iterate-context.platform-failure-alarm-": { lastSeen: now.toISOString(), told: false },
      "facet.platform-failure-": { lastSeen: now.toISOString(), told: false },
      "workers.platform-failure-": { lastSeen: now.toISOString(), told: false },
    },
  });
  expect(
    pinnedWorkarounds([], window, { readUntil: now.toISOString(), incidents: {}, pins: {} }),
  ).toMatchObject({ posts: [] });
});

test("the held-alarm pin reads prd's heals by event and posts its one message to #error-pulse; the next run posts nothing", async () => {
  const slack = fakeSlack();
  // Another workaround's heal, by event: not the pinned one's.
  const anotherHeal = (groupBy: string | undefined) =>
    groupBy === "event"
      ? {
          success: true,
          result: {
            calculations: [
              { aggregates: [{ groupKey: "context.platform-failure-other", count: 3 }] },
            ],
          },
        }
      : serverErrorsOnly(0)(groupBy);
  const lastSeen = new Date(Date.parse("2026-09-23T07:28:00Z") - PIN_QUIET_DAYS * day);
  const run1 = await runAt("07:30", pinState(lastSeen), slack, anotherHeal);
  const run2 = await runAt("07:45", run1.next, slack, anotherHeal);
  expect({
    posts: slack.posts.map((post) => [
      post.channel,
      post.thread_ts,
      String(post.text).slice(0, 32),
    ]),
    pin: run2.next.pins[heldAlarm!.event],
  }).toEqual({
    posts: [[channel, undefined, "✅ Cloudflare seems to have fixed"]],
    pin: { lastSeen: lastSeen.toISOString(), told: true },
  });
});

/** The quarter hour a run `days` after `now` reads. */
function at(days: number) {
  return {
    from: new Date(now.getTime() + days * day - 15 * 60_000),
    to: new Date(now.getTime() + days * day),
  };
}

/** A state whose held-alarm pin last saw its heal at `lastSeen`, and has not posted. */
function pinState(lastSeen: Date): AlarmState {
  return {
    readUntil: lastSeen.toISOString(),
    incidents: {},
    pins: { [heldAlarm!.event]: { lastSeen: lastSeen.toISOString(), told: false } },
  };
}

/** The page a run without state owes for `reading` (quiet elsewhere) in the half hour to `now`. */
function page(reading: Partial<FaultReading>) {
  return triageIncidents({ ...quiet, ...reading }, window, null).page?.text ?? null;
}

/** What one run without state over the half hour to `now` posts (or would post). A query
 *  Cloudflare fails is asked again without a wait. */
async function summary(slack: (() => WebClient) | null = null) {
  return (await alarm({ window, state: null, cloudflare: credentials, slack, delaysMs: [0, 0, 0] }))
    .summary;
}

/** Cloudflare's HTML error page, longer than the 200 bytes a failure's message quotes. */
const errorPage = `<!DOCTYPE html>\n<html lang="en-US"><head><title>api.cloudflare.com | 502: Bad gateway</title></head><body>${'<div class="cf-error-details"></div>'.repeat(20)}</body></html>`;
function cloudflareErrorPage(status: number) {
  return new Response(errorPage, {
    status,
    headers: { "content-type": "text/html; charset=UTF-8" },
  });
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
  return { fetch };
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
  workersLogs(answer);
  return await alarm({
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

// The Workers Logs wire contract used here: filters select events before grouping, and a query past
// 16 filter nodes is refused as Cloudflare refuses it. Unlike a fixed count response, this fixture
// catches a discarded re-count or an exclusion that drops other rows.
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
    if (filterNodes(query.parameters.filters) > MAX_FILTER_NODES)
      return Response.json(
        {
          success: false,
          errors: [
            {
              message: "Bad Request",
              detail: "Filter expression is too complex; maximum is 16 filter nodes",
            },
          ],
        },
        { status: 400 },
      );
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
  return { fetch };
}
function logField(event: unknown, key: string): unknown {
  return key.split(".").reduce(
    // oxlint-disable-next-line iterate/simple-truthiness-check -- the wire fixture contains unknown nested values, including strings and numbers
    (value, part) => (value && typeof value === "object" ? Reflect.get(value, part) : undefined),
    event,
  );
}
function matchesLogFilter(event: unknown, filter: LogFilter): boolean {
  if ("kind" in filter)
    return filter.filterCombination === "and"
      ? filter.filters.every((child) => matchesLogFilter(event, child))
      : filter.filters.some((child) => matchesLogFilter(event, child));
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

/** `n` ray IDs starting with `prefix`. */
function rays(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

/** The info line `event` in each of `rayIds`. */
function rayInfoLines(event: string, rayIds: string[]) {
  return rayIds.map((rayId) => ({
    timestamp: 42,
    event,
    $metadata: { type: "cf-worker", level: "info", rayId },
  }));
}

// Each expected outcome as one query sent it: a group per 500 values of its key, kept when the key
// is null, is none of them, or the row passes the keep. The split queries must count the same rows.
function oneQuery(base: LogFilter[], exclusions: Exclusion[]): LogFilter[] {
  return [
    ...base,
    ...exclusions.flatMap(({ key, values, keep }) =>
      Array.from({ length: Math.ceil(values.length / 500) }, (_, i): LogFilter => ({
        kind: "group",
        filterCombination: "or",
        filters: [
          { key, operation: "is_null", type: "string" },
          {
            key,
            operation: "not_in",
            value: values.slice(i * 500, i * 500 + 500).join(","),
            type: "string",
          },
          { kind: "group", filterCombination: "and", filters: keep },
        ],
      })),
    ),
  ];
}

/** One visitor's WebSocket to a tunnel on the edge whose connection vanished, as prd logged it
 *  (2026-09-25 14:56:17Z, but for the info line, which the edge logs since): the edge's
 *  `fetch-upgrade.local-gone`, the runtime's "Network connection lost." and the invocation's
 *  exception summary, one requestId, all in `rayId`. */
function vanishedVisitorRequest(rayId: string) {
  const url = "https://here-public.templestein.com/clock";
  const invocation = { requestId: `${rayId}-edge`, rayId };
  const $workers = { executionModel: "stateless", event: { request: { url } } };
  return [
    {
      timestamp: 42,
      event: "fetch-upgrade.local-gone",
      $metadata: { type: "cf-worker", level: "info", ...invocation },
      $workers,
    },
    {
      timestamp: 42,
      $metadata: { type: "cf-worker", message: "Network connection lost.", ...invocation },
      $workers,
    },
    {
      timestamp: 42,
      $metadata: { type: "cf-worker-event", message: `GET ${url}`, ...invocation },
      $workers: { ...$workers, outcome: "exception" },
    },
  ];
}

/** One request to a killed tunnel's host, as a preview logged it (2026-09-24): the offline stub's info
 *  line in the context DO, then a 502 summary from each hop — the project host's Worker, the DO's fetch,
 *  the config worker's ItxEntrypoint and the DO's fetch again — each with its own requestId and all
 *  in `rayId`. `change` alters the four summaries; `answer` is another expected answer's line and
 *  status (a deploy reset's 503). */
function rpcStubOfflineRequest(
  rayId: string,
  change: { status?: number; rayId?: string; type?: string; message?: string } = {},
  answer: { event: string; status: number } = {
    event: "expression-fetch.rpc-stub-offline",
    status: 502,
  },
) {
  const url = "https://blog--p.iterate.app/__vite_ping";
  const summaryRayId = "rayId" in change ? change.rayId : rayId;
  return [
    {
      timestamp: 42,
      event: answer.event,
      $metadata: { type: "cf-worker", level: "info", requestId: `${rayId}-inner-do`, rayId },
      $workers: { executionModel: "durableObject", event: { request: { url } } },
    },
    ...["stateless", "durableObject", "stateless", "durableObject"].map((executionModel, hop) => ({
      timestamp: 42,
      $metadata: {
        type: change.type || "cf-worker-event",
        requestId: `${rayId}-${hop}`,
        rayId: summaryRayId,
        message: change.message || `GET ${url}`,
      },
      $workers: {
        executionModel,
        outcome: "ok",
        event: {
          request: { url },
          response: "status" in change ? { status: change.status } : { status: answer.status },
        },
      },
    })),
  ];
}
