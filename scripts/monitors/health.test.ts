import { expect, test } from "vitest";
import { fakeDepot, mainRun } from "./fake-depot.ts";
import {
  judgeMainE2eRun,
  readMainE2eState,
  readState,
  sendUpdates,
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
    name: "an escalation edits the page and replies in its thread with the mentions",
    pages: open,
    update: {
      signal: "main e2e",
      kind: "escalate",
      page,
      news: "main e2e has new failures at `abc`: a row",
      broadcast: false,
    },
    calls: [
      { update: "100.1", text: pageText },
      {
        post: "🚨 main e2e has new failures at `abc`: a row <@U067G4QRFK2> <@U099JH9TAF2>",
        thread: { ts: "100.1", broadcast: false },
      },
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
    name: "a resolution marks the page resolved before it replies, and closes it",
    pages: open,
    update: { signal: "main e2e", kind: "resolve", why: "main e2e green again at `abc`" },
    calls: [
      { update: "100.1", text: pageText.replace("🚨 ", "✅ resolved: ") },
      {
        post: "✅ resolved: main e2e green again at `abc` <@U067G4QRFK2> <@U099JH9TAF2>",
        thread: { ts: "100.1", broadcast: false },
      },
    ],
    after: {},
  },
  {
    name: "a replacement resolves the open page and opens another",
    pages: open,
    update: {
      signal: "main e2e",
      kind: "replace",
      why: "unjudged, on a page of its own",
      page: { ...page, what: "main e2e unjudged" },
    },
    calls: [
      { update: "100.1", text: pageText.replace("🚨 ", "✅ resolved: ") },
      {
        post: "✅ resolved: unjudged, on a page of its own <@U067G4QRFK2> <@U099JH9TAF2>",
        thread: { ts: "100.1", broadcast: false },
      },
      { post: pageText.replace("main e2e red at `012345678`", "main e2e unjudged") },
    ],
    after: {
      "main e2e": {
        ts: "2",
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
    name: "an escalation of a gone page opens a new one and replies in its thread",
    update: { signal: "main e2e", kind: "escalate", page, news: "worse", broadcast: true },
    calls: [
      { gone: "100.1" },
      { post: pageText },
      {
        post: "🚨 worse <@U067G4QRFK2> <@U099JH9TAF2>",
        thread: { ts: "1", broadcast: true },
      },
    ],
    after: { "main e2e": { ts: "1", text: pageText } },
  },
  {
    name: "a resolution of a gone page posts its reply top-level",
    update: { signal: "main e2e", kind: "resolve", why: "green again" },
    calls: [{ gone: "100.1" }, { post: "✅ resolved: green again <@U067G4QRFK2> <@U099JH9TAF2>" }],
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
  });
  // the state as kept and read back: the same run owes nothing again
  expect(await judge(JSON.parse(JSON.stringify(judged.next)), "wf-red")).toMatchObject({
    updates: [],
    next: judged.next,
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

/** A poster that records each call and answers each post with the next ts, "1" first; with
 *  `failUpdate`, every edit fails as Slack refuses one. */
/** A poster that records its calls; its edits succeed, answer "gone" as a deleted page's would, or
 *  fail with another Slack error. */
function fakePoster(
  options: { update?: "edited" | "gone" | "fails" } = {},
): PagePoster & { calls: unknown[] } {
  const calls: unknown[] = [];
  let posts = 0;
  return {
    calls,
    async post(text, thread) {
      calls.push(thread ? { post: text, thread } : { post: text });
      return String(++posts);
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
