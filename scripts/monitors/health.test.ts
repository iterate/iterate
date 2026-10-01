import { expect, onTestFinished, test, vi } from "vitest";
import { fakeSlack } from "../ci/fake-slack.ts";
import { fakeDepot, mainRun } from "./fake-depot.ts";
import {
  AWAIT_OLDER_RUNS,
  awaitOlderMainE2eRuns,
  judgeMainE2eRun,
  postThenKeep,
  readMainE2eState,
  readState,
  sendUpdates,
  slackPoster,
  type OpenPages,
  type PagePoster,
} from "./health.ts";
import type { PageUpdate } from "./page.ts";

const page = {
  what: "main e2e red at `012345678`",
  impact: "failed: E2E tests",
  action: "fix or revert `012345678`",
  link: "https://depot.dev/main",
};
const pageText = [
  "🚨 main e2e red at `012345678` <@U067G4QRFK2> <@U099JH9TAF2>",
  "Impact: failed: E2E tests",
  "Do: fix or revert `012345678`",
  "<https://depot.dev/main|run>",
].join("\n");
const open: OpenPages = { "main e2e": { ts: "100.1", text: pageText } };

test.for<{
  name: string;
  pages: OpenPages;
  update: PageUpdate;
  calls: unknown[];
  after: OpenPages;
}>([
  {
    name: "a post opens the signal's page, one message with the mentions and no other line",
    pages: {},
    update: { signal: "main e2e", kind: "post", page },
    calls: [{ post: pageText }],
    after: { "main e2e": { ts: "1", text: pageText } },
  },
  {
    name: "an edit rewrites the open page and sends nothing else",
    pages: open,
    update: { signal: "main e2e", kind: "edit", page: { ...page, impact: "failed: specs" } },
    calls: [{ update: "100.1", text: pageText.replace("failed: E2E tests", "failed: specs") }],
    after: {
      "main e2e": { ts: "100.1", text: pageText.replace("failed: E2E tests", "failed: specs") },
    },
  },
  {
    name: "an escalation edits the page and posts what got worse beside it, with the mentions",
    pages: open,
    update: {
      signal: "main e2e",
      kind: "escalate",
      page,
      news: "main e2e has new failures at `abc`: a row",
    },
    calls: [
      { update: "100.1", text: pageText },
      { post: "🚨 main e2e has new failures at `abc`: a row <@U067G4QRFK2> <@U099JH9TAF2>" },
    ],
    after: open,
  },
  {
    name: "an edit of a signal with no open page posts its page",
    pages: {},
    update: { signal: "main e2e", kind: "edit", page },
    calls: [{ post: pageText }],
    after: { "main e2e": { ts: "1", text: pageText } },
  },
  {
    name: "a resolution edits the page to say resolved and why, sends nothing else, and closes it",
    pages: open,
    update: { signal: "main e2e", kind: "resolve", why: "main e2e green again at `abc`" },
    calls: [
      {
        update: "100.1",
        text: [
          "✅ resolved: main e2e red at `012345678` <@U067G4QRFK2> <@U099JH9TAF2>",
          "✅ main e2e green again at `abc`",
          "Impact: failed: E2E tests",
          "Do: fix or revert `012345678`",
          "<https://depot.dev/main|run>",
        ].join("\n"),
      },
    ],
    after: {},
  },
  {
    name: "a replacement resolves the open page by an edit and opens another",
    pages: open,
    update: {
      signal: "main e2e",
      kind: "replace",
      why: "unjudged, on a page of its own",
      page: { ...page, what: "main e2e unjudged" },
    },
    calls: [
      {
        update: "100.1",
        text: [
          "✅ resolved: main e2e red at `012345678` <@U067G4QRFK2> <@U099JH9TAF2>",
          "✅ unjudged, on a page of its own",
          "Impact: failed: E2E tests",
          "Do: fix or revert `012345678`",
          "<https://depot.dev/main|run>",
        ].join("\n"),
      },
      { post: pageText.replace("main e2e red at `012345678`", "main e2e unjudged") },
    ],
    after: {
      "main e2e": {
        ts: "1",
        text: pageText.replace("main e2e red at `012345678`", "main e2e unjudged"),
      },
    },
  },
])("$name", async ({ pages, update, calls, after }) => {
  const poster = fakePoster();
  const next = await sendUpdates(poster, { updates: [update], pages, testRun: false });
  // exact: these Slack calls and no others, and the pages they leave open
  expect({ calls: poster.calls, after: next }).toEqual({ calls, after });
});

test("a test run posts its page and its resolution top-level, marked and mentioning nobody", async () => {
  const poster = fakePoster();
  const next = await sendUpdates(poster, {
    updates: [
      { signal: "main e2e", kind: "post", page },
      { signal: "latency", kind: "resolve", why: "latency under its lines at `abc`" },
    ],
    pages: {},
    testRun: true,
  });
  expect({ calls: poster.calls, next }).toEqual({
    calls: [
      {
        post: pageText
          .replace("🚨", "🧪 TEST RUN — 🚨")
          .replace(" <@U067G4QRFK2> <@U099JH9TAF2>", ""),
      },
      { post: "🧪 TEST RUN — ✅ resolved: latency under its lines at `abc`" },
    ],
    next: {
      "main e2e": {
        ts: "1",
        text: pageText
          .replace("🚨", "🧪 TEST RUN — 🚨")
          .replace(" <@U067G4QRFK2> <@U099JH9TAF2>", ""),
      },
    },
  });
});

test("a real run's resolution with no open page sends nothing: its state started over", async () => {
  const poster = fakePoster();
  const next = await sendUpdates(poster, {
    updates: [{ signal: "latency", kind: "resolve", why: "latency under its lines at `abc`" }],
    pages: {},
    testRun: false,
  });
  // exact: no Slack call and no page
  expect({ calls: poster.calls, next }).toEqual({ calls: [], next: {} });
});

test("a row-only signal sends nothing on a real run but the edit that resolves a page it opened before the dashboard", async () => {
  const poster = fakePoster();
  const next = await sendUpdates(poster, {
    updates: [
      { signal: "PR time to green", kind: "post", page },
      // its open page stays as it was until the signal resolves
      {
        signal: "latency",
        kind: "escalate",
        page,
        news: "latency: context.wake over its lines too",
      },
      { signal: "latency", kind: "resolve", why: "latency under its lines at `abc`" },
      // a replacement resolves the open page and opens none
      {
        signal: "slow e2e rows",
        kind: "replace",
        why: "slow e2e rows judged again at `abc`: red, on a page of its own",
        page: { ...page, what: "slow e2e rows red at `abc`" },
      },
    ],
    pages: {
      latency: { ts: "100.1", text: "🚨 latency over its lines at `012345678`" },
      "slow e2e rows": { ts: "100.2", text: "🚨 slow e2e rows unjudged at `012345678`" },
    },
    testRun: false,
  });
  // exact: two edits, no post
  expect({ calls: poster.calls, next }).toEqual({
    calls: [
      {
        update: "100.1",
        text: "✅ resolved: latency over its lines at `012345678`\n✅ latency under its lines at `abc`",
      },
      {
        update: "100.2",
        text: "✅ resolved: slow e2e rows unjudged at `012345678`\n✅ slow e2e rows red at `abc`, on the dashboard",
      },
    ],
    next: {},
  });
});

test("an edit that fails sends nothing after it: the state is kept only once every update is sent", async () => {
  const poster = fakePoster({ update: "fails" });
  await expect(
    sendUpdates(poster, {
      updates: [{ signal: "main e2e", kind: "resolve", why: "green again" }],
      pages: open,
      testRun: false,
    }),
  ).rejects.toThrow("ratelimited");
  expect(poster).toMatchObject({ calls: [] });
});

test.for<{ name: string; update: PageUpdate; calls: unknown[]; after: OpenPages }>([
  {
    name: "an edit of a gone page opens a new one",
    update: { signal: "main e2e", kind: "edit", page },
    calls: [{ gone: "100.1" }, { post: pageText }],
    after: { "main e2e": { ts: "1", text: pageText } },
  },
  {
    name: "an escalation of a gone page opens a new one and posts what got worse beside it",
    update: { signal: "main e2e", kind: "escalate", page, news: "worse" },
    calls: [
      { gone: "100.1" },
      { post: pageText },
      { post: "🚨 worse <@U067G4QRFK2> <@U099JH9TAF2>" },
    ],
    after: { "main e2e": { ts: "1", text: pageText } },
  },
  {
    name: "a resolution of a gone page sends nothing more",
    update: { signal: "main e2e", kind: "resolve", why: "green again" },
    calls: [{ gone: "100.1" }],
    after: {},
  },
])(
  "$name: a page Slack can no longer edit never wedges its signal",
  async ({ update, calls, after }) => {
    const poster = fakePoster({ update: "gone" });
    const next = await sendUpdates(poster, { updates: [update], pages: open, testRun: false });
    // exact: these Slack calls and no others, and the pages they leave open
    expect({ calls: poster.calls, after: next }).toEqual({ calls, after });
  },
);

test.for([
  { name: "no previous state starts empty", previous: undefined },
  { name: "a state of another schemaVersion starts over", previous: { schemaVersion: 1 } },
])("$name", ({ previous }) => {
  // exact: starting over remembers nothing
  expect(readState(previous)).toEqual({
    schemaVersion: 2,
    ttg: { pushes: [] },
    latency: { runs: [], red: [] },
    e2e: { suites: {}, judgedAt: {} },
    pages: {},
  });
});

test("a state of this version reads back as written, and one that does not parse throws", () => {
  const state = {
    schemaVersion: 2,
    ttg: { pushes: [], lastPage: { judgement: "over", bestP50: 208 } },
    latency: {
      runs: [],
      red: ["sign-in"],
      signal: { state: "red", since: "abc", runs: 2, failures: ["sign-in"] },
      judgedAt: "2026-09-26T21:29:00.000Z",
    },
    e2e: {
      suites: { "real-model e2e": { state: "green" } },
      judgedAt: { "OS real model": "2026-09-26T20:00:00.000Z" },
    },
    pages: { latency: { ts: "100.1", text: "🚨 latency over its lines" } },
  };
  // exact: the state reads back untouched
  expect(readState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  expect(() => readState({ ...state, latency: { runs: "none" } })).toThrow();
});

test("Main OS e2e's page job owes a red run a page, and keeps the state its next run reads", async () => {
  const red = mainRun("red", "2026-09-27T01:00:00Z", {
    e2e: "failed",
    e2eTests: [
      { name: "a slow row", tags: ["slow"] },
      { name: "a plain row", failed: true },
    ],
    running: true,
  });
  const judge = (state: unknown, workflowId: string) =>
    judgeMainE2eRun({
      depot: fakeDepot({
        "Main OS e2e": [mainRun("green", "2026-09-27T00:30:00Z", {}), red],
      }),
      state: readMainE2eState(state),
      workflowId,
      testRun: false,
      subject: async (sha) => `the subject of ${sha.slice(0, 3)}`,
    });
  const previous = {
    schemaVersion: 3,
    e2e: {
      suites: { "main e2e": { state: "green" }, "slow e2e rows": { state: "green" } },
      judgedAt: { "Main OS e2e": "2026-09-27T00:30:00Z" },
    },
    pages: {},
  };

  const judged = await judge(previous, "wf-red");

  expect(judged).toEqual({
    updates: [
      {
        signal: "main e2e",
        kind: "post",
        page: {
          what: "main e2e red at `redaaaaaa` (the subject of red)",
          impact: "failed: E2E tests; failing rows: a plain row",
          action: "fix or revert `redaaaaaa`; a flaky row gets a fix, not a retry",
          link: "https://depot.dev/orgs/0p91s0lz49/workflows/wf-red",
        },
      },
    ],
    next: {
      schemaVersion: 3,
      e2e: {
        suites: {
          "main e2e": {
            state: "red",
            since: "red".padEnd(40, "a"),
            runs: 1,
            failures: ["E2E tests", "a plain row"],
          },
          "slow e2e rows": { state: "green" },
        },
        judgedAt: { "Main OS e2e": "2026-09-27T01:00:00Z" },
      },
      pages: {},
    },
    failures: [],
    rows: [
      { signal: "main e2e", state: "red", text: "red at `redaaaaaa` (the subject of red)" },
      {
        signal: "slow e2e rows",
        state: "green",
        text: "green at `redaaaaaa` (the subject of red)",
      },
    ],
  });
  // the state as kept and read back: the same run owes nothing again
  expect(await judge(JSON.parse(JSON.stringify(judged.next)), "wf-red")).toMatchObject({
    updates: [],
    next: judged.next,
  });
});

test("a red main e2e pages in today's dashboard thread with both mentions, never to the channel, and both suites set their rows", async () => {
  const slack = fakeSlack({ now: Date.parse("2026-09-27T01:05:00Z") });
  const judged = await judgeMainE2eRun({
    depot: fakeDepot({
      "Main OS e2e": [
        mainRun("red", "2026-09-27T01:00:00Z", {
          e2e: "failed",
          e2eTests: [{ name: "a slow row", tags: ["slow"], failed: true }],
          running: true,
        }),
      ],
    }),
    state: readMainE2eState(undefined),
    workflowId: "wf-red",
    testRun: false,
    subject: async (sha) => `the subject of ${sha.slice(0, 3)}`,
  });

  const kept = await postThenKeep(
    slackPoster(slack.client, { testRun: false, now: new Date(slack.clock.now) }),
    { ...judged, testRun: false, keep: true, stateOut: undefined },
  );

  const [dashboard] = slack.channel("#error-pulse");
  const redPage = [
    "🚨 main e2e red at `redaaaaaa` (the subject of red) <@U067G4QRFK2> <@U099JH9TAF2>",
    "Impact: failed: E2E tests; failing rows: a slow row",
    "Do: fix or revert `redaaaaaa`; a flaky row gets a fix, not a retry",
    "<https://depot.dev/orgs/0p91s0lz49/workflows/wf-red|run>",
  ].join("\n");
  // slow e2e rows is red too, but pages nothing: its row is all the channel gets
  expect({
    channel: slack.channel("#error-pulse").map((message) => message.text),
    replies: dashboard!.replies.map(({ text, reply_broadcast }) => ({ text, reply_broadcast })),
    pages: kept.pages,
  }).toEqual({
    channel: [
      [
        "📟 error-pulse · Sun 27 Sep · 01:05 UTC",
        "🔴 main e2e: red at `redaaaaaa` (the subject of red)",
        "🔴 slow e2e rows: red at `redaaaaaa` (the subject of red)",
      ].join("\n"),
    ],
    replies: [{ text: redPage, reply_broadcast: undefined }],
    pages: { "main e2e": { ts: dashboard!.replies[0]!.ts, text: redPage } },
  });
});

test("row-only signals send #error-pulse nothing but their dashboard rows", async () => {
  const slack = fakeSlack({ now: Date.parse("2026-10-01T09:41:00Z") });
  const kept = await postThenKeep(
    slackPoster(slack.client, { testRun: false, now: new Date(slack.clock.now) }),
    {
      updates: [
        { signal: "real-model e2e", kind: "post", page },
        { signal: "latency", kind: "post", page },
        { signal: "PR time to green", kind: "escalate", page, news: "more than 20 s worse again" },
      ],
      rows: [
        { signal: "real-model e2e", state: "red", text: "red at `012345678` (a subject)" },
        { signal: "latency", state: "red", text: "over its lines at `012345678`: context.wake" },
        { signal: "PR time to green", state: "amber", text: "p50 169 s (line 165 s)" },
      ],
      testRun: false,
      keep: true,
      stateOut: undefined,
      next: readState(undefined),
    },
  );
  // exact: the dashboard, with no reply in its thread, and no page open
  expect({
    channel: slack.timeline("#error-pulse").map((message) => message.text),
    pages: kept.pages,
  }).toEqual({
    channel: [
      [
        "📟 error-pulse · Thu 1 Oct · 09:41 UTC",
        "🔴 real-model e2e: red at `012345678` (a subject)",
        "🔴 latency: over its lines at `012345678`: context.wake",
        "🟡 PR time to green: p50 169 s (line 165 s)",
      ].join("\n"),
    ],
    pages: {},
  });
});

test("a test run posts its pages top-level in #ci, mentioning nobody, and sets no row", async () => {
  const slack = fakeSlack({ now: Date.parse("2026-10-01T09:41:00Z") });
  await postThenKeep(slackPoster(slack.client, { testRun: true, now: new Date(slack.clock.now) }), {
    updates: [
      { signal: "main e2e", kind: "post", page },
      { signal: "latency", kind: "resolve", why: "latency under its lines at `abc`" },
    ],
    rows: [{ signal: "main e2e", state: "red", text: "red at `012345678`" }],
    testRun: true,
    keep: false,
    stateOut: undefined,
    next: readMainE2eState(undefined),
  });
  expect({
    ci: slack.timeline("#ci").map(({ text, thread_ts }) => ({ text, thread_ts })),
    pulse: slack.timeline("#error-pulse"),
  }).toEqual({
    ci: [
      {
        text: pageText
          .replace("🚨", "🧪 TEST RUN — 🚨")
          .replace(" <@U067G4QRFK2> <@U099JH9TAF2>", ""),
        thread_ts: undefined,
      },
      { text: "🧪 TEST RUN — ✅ resolved: latency under its lines at `abc`", thread_ts: undefined },
    ],
    pulse: [],
  });
});

test("Main OS e2e's page job gives a broken slow-rows probe of a green run its own page, and has no failure", async () => {
  const current = mainRun("current", "2026-09-27T01:00:00Z", {
    e2eTests: [{ name: "the careless facet", tags: ["slow"] }],
    e2eSummary: {
      status: "incomplete",
      diagnostics: ["Test did not finish: Sign in with Cloudflare and with GitHub"],
    },
    running: true,
  });
  const judged = await judgeMainE2eRun({
    depot: fakeDepot({ "Main OS e2e": [current] }),
    state: readMainE2eState({
      schemaVersion: 3,
      e2e: {
        suites: { "main e2e": { state: "green" }, "slow e2e rows": { state: "green" } },
        judgedAt: { "Main OS e2e": "2026-09-27T00:30:00Z" },
      },
      pages: {},
    }),
    workflowId: "wf-current",
    testRun: false,
    subject: async (sha) => `the subject of ${sha.slice(0, 3)}`,
  });
  expect(judged).toMatchObject({
    updates: [
      {
        signal: "slow e2e rows",
        kind: "post",
        page: {
          what: "slow e2e rows unjudged at `currentaa` (the subject of cur)",
          impact:
            "broken probe: an incomplete run: Test did not finish: Sign in with Cloudflare and with GitHub",
        },
      },
    ],
    next: { e2e: { suites: { "slow e2e rows": { state: "broken", runs: 1, failures: [] } } } },
    failures: [],
  });
});

test("Main OS e2e's state starts empty with none, or one of another schemaVersion", () => {
  const empty = { schemaVersion: 3, e2e: { suites: {}, judgedAt: {} }, pages: {} };
  expect({
    none: readMainE2eState(undefined),
    // version 2, whose suites were a bare state with no page
    two: readMainE2eState({
      schemaVersion: 2,
      e2e: { suites: { "main e2e": "red" }, judgedAt: {} },
    }),
    four: readMainE2eState({ schemaVersion: 4 }),
  }).toEqual({ none: empty, two: empty, four: empty });
});

// Main OS e2e's page jobs take turns, oldest run first (health.ts `awaitOlderMainE2eRuns`), on a
// fake clock: `ends` is how many of the wait's Depot listings see the older push run still running.
test.for<{ name: string; ends: number; expected: { seconds: number; logged: string[] } }>([
  {
    name: "an older push run still in progress holds this run's page job until it ends",
    ends: 3,
    expected: {
      seconds: 30,
      logged: [
        "[await-older-runs] 0 s: waiting for wf-older (olderaaaa, running)",
        "[await-older-runs] 30 s: no older run in progress",
      ],
    },
  },
  {
    name: "with no older push run in progress it goes at once",
    ends: 0,
    expected: { seconds: 0, logged: ["[await-older-runs] 0 s: no older run in progress"] },
  },
])(
  "$name; a newer run, a dispatch and a run of the same second but a later id never do",
  async ({ ends, expected }) => {
    const turns = takingTurns(ends);

    await awaitOlderMainE2eRuns({ depot: turns.depot, workflowId: "wf-current", log: turns.log });

    expect({ seconds: (Date.now() - turns.started) / 1000, logged: turns.lines }).toEqual(expected);
  },
);

test("an older run that never ends fails the wait after its bound, naming the run", async () => {
  const turns = takingTurns(Infinity);

  await expect(
    awaitOlderMainE2eRuns({ depot: turns.depot, workflowId: "wf-current", log: turns.log }),
  ).rejects.toThrow(
    "the older runs wf-older (olderaaaa, running) are still in progress after 30 minutes: the next run's page job judges this run after them",
  );
  expect((Date.now() - turns.started) / 1000).toBe(AWAIT_OLDER_RUNS.boundMs / 1000);
});

/** A poster that records its calls and answers each post with the next ts, "1" first; its edits
 *  succeed, answer "gone" as a deleted page's would, or fail with another Slack error. */
function fakePoster(
  options: { update?: "edited" | "gone" | "fails" } = {},
): PagePoster & { calls: unknown[] } {
  const calls: unknown[] = [];
  let posts = 0;
  return {
    calls,
    async post(text) {
      calls.push({ post: text });
      return String(++posts);
    },
    async setRow(row) {
      calls.push({ row });
    },
    async update(ts, text) {
      if (options.update === "fails") throw new Error("An API error occurred: ratelimited");
      if (options.update === "gone") {
        calls.push({ gone: ts });
        return "gone";
      }
      calls.push({ update: ts, text });
      return "edited";
    },
  };
}

/** The current push run of Main OS e2e at 01:00:00, and in progress beside it: an older push run,
 *  running for the wait's first `ends` listings; an older dispatch; a newer push run; and a push run
 *  of the same second with a later workflow id. */
function takingTurns(ends: number) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setTimerTickMode("nextTimerAsync");
  onTestFinished(() => void vi.useRealTimers());
  const older = mainRun("older", "2026-09-27T00:58:00Z", { running: true });
  const fake = fakeDepot({
    "Main OS e2e": [
      mainRun("current", "2026-09-27T01:00:00Z", { running: true }),
      older,
      {
        ...mainRun("dispatch", "2026-09-27T00:30:00Z", { running: true }),
        trigger: "workflow_dispatch",
      },
      mainRun("newer", "2026-09-27T01:02:00Z", { running: true }),
      mainRun("same-second", "2026-09-27T01:00:00Z", { running: true }),
    ],
  });
  const turns = {
    started: Date.now(),
    listings: 0,
    lines: [] as string[],
    log: (line: string) => void turns.lines.push(line),
    depot: async (method: string, body: object) => {
      if (method === "ListWorkflows") {
        older.status = turns.listings < ends ? "running" : "finished";
        turns.listings++;
      }
      return fake(method, body);
    },
  };
  return turns;
}
