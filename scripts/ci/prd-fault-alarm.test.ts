// The prd fault alarm: how it reads prd's Workers Logs (a wire fixture of the calculations API) and
// what it owes Slack (triageIncidents, pure, over readings shaped as prd logged them). Posting to a
// real Slack is proven by the workflow's 🧪 TEST RUN, not here.
import { tmpdir } from "node:os";
import { writeFileSync, mkdtempDisposableSync } from "node:fs";
import { join } from "node:path";
import type { WebClient } from "@slack/web-api";
import { expect, onTestFinished, test, vi } from "vitest";
import { fakeDoppler } from "../lib/fake-doppler.ts";
import {
  type AlarmState,
  alarm,
  type Exclusion,
  exclusionQueries,
  faultRow,
  type FaultReading,
  filterNodes,
  incidentsOf,
  type LogFilter,
  logWindow,
  MAX_FILTER_NODES,
  PIN_QUIET_DAYS,
  PINNED_WORKAROUNDS,
  pinnedWorkarounds,
  readState,
  run,
  runMode,
  triageIncidents,
} from "./prd-fault-alarm.ts";
import { fakeSlack } from "./fake-slack.ts";

const quiet: FaultReading = {
  serverErrors: [],
  causes: [],
  heals: [],
  healEvents: [],
  errors: [],
  closeResets: [],
  pagers: [],
};
const now = new Date("2026-09-23T07:30:00Z");
const window = { from: new Date("2026-09-23T07:00:00Z"), to: now };
const credentials = { accountId: "account", apiToken: "token" };
const mentions = "<@U067G4QRFK2> <@U099JH9TAF2>";
const doLine =
  "Do: open <https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/workers-and-pages/observability|Workers Logs> for these rays; /debug-os-worker";

// ── what a window owes Slack ──

test("a window's page names its causes and totals, and lists each incident with when it was last seen", () => {
  // A sample of 2026-09-23 07:00–07:30Z (`run --at 2026-09-23T07:30:00Z --dry-run`).
  expect(
    triageIncidents(
      {
        ...quiet,
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
      },
      window,
      null,
      false,
    ),
  ).toMatchObject({
    posts: [
      {
        page: {
          ts: "",
          text: [
            `🚨 prd: 13 visitor 5xx, 1201 errors, 1815 platform-failure heals ${mentions}`,
            "Impact: since 07:30 UTC",
            "• platform-failure heals: project 1279 · last 07:30 UTC",
            "• errors: ProjectDurableObject.jsrpc 1199 · last 07:30 UTC",
            "• platform-failure heals: repo 536 · last 07:30 UTC",
            "• visitor 5xx: garple.com 7 · last 07:30 UTC",
            "• visitor 5xx: lispwoso.com 6 · last 07:30 UTC",
            "• errors: internal error; reference = … 2 · last 07:30 UTC",
            doLine,
          ].join("\n"),
        },
        broadcast: false,
      },
    ],
    held: [],
    updates: [],
  });
});

// Whether a window is a fault at all: it opens a page, posted or held (which of them pings is below).
test.for([
  { name: "a quiet prd pages nothing", reading: {}, pages: false },
  {
    name: "one visitor 5xx pages",
    reading: { serverErrors: [["https://a.com/", 1]] },
    pages: true,
  },
  { name: "9 heals page nothing", reading: { heals: [["repo", 9]] }, pages: false },
  { name: "10 heals page", reading: { heals: [["repo", 10]] }, pages: true },
  { name: "one error pages", reading: { errors: [["boom", 1]] }, pages: true },
  {
    name: "a close with every pager re-dialed (2026-09-27 23:50) pages nothing",
    reading: {
      errors: [
        [
          "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
          2,
        ],
        ["close", 2],
      ],
      pagers: [["rpc-stub-pager-redialed", 2]],
    },
    pages: false,
  },
  {
    name: "a close with a pager that gave up pages",
    reading: {
      errors: [["close", 2]],
      pagers: [
        ["rpc-stub-pager-redialed", 2],
        ["rpc-stub-pager-redial-failed", 1],
      ],
    },
    pages: true,
  },
  {
    name: "a socket close's reset with every pager re-dialed (2026-09-28 14:49) pages nothing",
    reading: {
      closeResets: [["internal error; reference = 3pq1nd2d1ovl2vse8jv5vgfo", 3]],
      pagers: [["rpc-stub-pager-redialed", 3]],
    },
    pages: false,
  },
  {
    name: "a socket close's reset with a pager that gave up pages",
    reading: {
      closeResets: [["internal error; reference = 3pq1nd2d1ovl2vse8jv5vgfo", 3]],
      pagers: [
        ["rpc-stub-pager-redialed", 2],
        ["rpc-stub-pager-redial-failed", 1],
      ],
    },
    pages: true,
  },
  {
    name: "a socket close's reset no pager re-dialed through pages",
    reading: { closeResets: [["internal error; reference = 3pq1nd2d1ovl2vse8jv5vgfo", 1]] },
    pages: true,
  },
  {
    name: "an internal error that is not a socket close's pages with every pager re-dialed (a 500 from the expression fetch, 2026-09-28 13:04)",
    reading: {
      errors: [["internal error; reference = 4b2bd3s1lpsjhc4kfd1fh7gm", 1]],
      pagers: [["rpc-stub-pager-redialed", 3]],
    },
    pages: true,
  },
  {
    name: "a storage reset no pager re-dialed through pages",
    reading: {
      errors: [
        [
          "Internal error in Durable Object storage caused object to be reset; reference = 1fg9pk06ot",
          8,
        ],
      ],
    },
    pages: true,
  },
  {
    name: "a lent stub's pager that could not be re-dialed (2026-09-25 14:21) pages",
    reading: {
      errors: [
        [
          "a lent stub's pager dropped under a live session and could not be re-dialed; the lend ends and the DO has un-set what named it",
          3,
        ],
      ],
      pagers: [
        ["rpc-stub-pager-redialed", 24],
        ["rpc-stub-pager-redial-failed", 5],
      ],
    },
    pages: true,
  },
] satisfies { name: string; reading: Partial<FaultReading>; pages: boolean }[])(
  "$name",
  ({ reading, pages }) => {
    expect({ pages: Boolean(pageFor(reading)) }).toEqual({ pages });
  },
);

test("a repeat edits the page with its running count and posts nothing", () => {
  const first = triageAt("07:30", reading5xx(1), null);
  const repeat = triageAt("07:45", reading5xx(2), first.next);
  expect(repeat).toMatchObject({
    triage: {
      posts: [],
      updates: [
        {
          ts: "1.0",
          text: [
            `🚨 prd: 3 visitor 5xx ${mentions}`,
            "Impact: since 07:28 UTC",
            "• visitor 5xx: os.iterate.com 3 · last 07:43 UTC",
            doLine,
          ].join("\n"),
          reply: null,
        },
      ],
    },
    next: {
      pages: [
        {
          ts: "1.0",
          incidents: {
            "visitor 5xx: os.iterate.com": {
              count: 3,
              told: 1,
              firstSeen: "2026-09-23T07:28:00.000Z",
              lastSeen: "2026-09-23T07:43:00.000Z",
              closed: false,
            },
          },
        },
      ],
    },
  });
});

test("an unchanged page is not edited: a window that saw nothing new owes nothing", () => {
  const first = triageAt("07:30", reading5xx(1), null);
  expect(triageAt("07:45", quiet, first.next).triage).toMatchObject({ posts: [], updates: [] });
});

test("an incident grown tenfold since the channel last heard is told in today's dashboard thread, not the channel", () => {
  const first = triageAt("07:30", reading5xx(1), null);
  const grown = triageAt("07:45", reading5xx(9), first.next);
  const after = triageAt("08:00", reading5xx(1), grown.next);
  expect({
    grown: grown.triage.updates.map((update) => update.reply),
    after: after.triage.updates.map((update) => update.reply),
  }).toEqual({
    grown: [
      {
        text: `🚨 prd fault escalated, 07:28–07:43 UTC ${mentions}\n• grew tenfold: visitor 5xx: os.iterate.com 10`,
        broadcast: false,
      },
    ],
    after: [null],
  });
});

test("a deploy's incident grown tenfold is told with the hosts this window added", () => {
  const reset = (hosts: [string, number][]): FaultReading => ({
    ...quiet,
    causes: [{ cause: "deploy reset", worker: "os-prd", serverErrors: hosts }],
  });
  const first = triageAt("07:30", reset([["https://os.iterate.com/", 1]]), null);
  const grown = triageAt(
    "07:45",
    reset([
      ["https://os.iterate.com/", 4],
      ["https://dash.iterate.com/", 5],
    ]),
    first.next,
  );
  expect(grown.triage.updates.map((update) => update.reply?.text.split("\n")[1])).toEqual([
    "• grew tenfold: deploy reset (os-prd): 10 visitor 5xx on os.iterate.com 5, dash.iterate.com 5",
  ]);
});

test("an incident back in a burst after an hour's quiet is told in today's dashboard thread; a lone return, or a burst within six hours, only edits", () => {
  const quietHour = (state: AlarmState, from: number) =>
    [0, 15, 30, 45, 60].reduce(
      (quieter, minutes) => triageAt(clock(from + minutes), quiet, quieter).next,
      state,
    );
  const first = triageAt("07:30", reading5xx(5), null);
  // Four quiet windows: the page says so, by an edit.
  const quietOnce = quietHour(first.next, 7 * 60 + 45);
  expect(quietOnce.pages[0]!.text).toContain(
    "• visitor 5xx: os.iterate.com 5 · quiet since 07:28 UTC",
  );
  const lone = triageAt("09:00", reading5xx(1), quietOnce);
  const burst = triageAt("10:30", reading5xx(10), quietHour(lone.next, 9 * 60 + 15));
  const burstAgain = triageAt("12:00", reading5xx(10), quietHour(burst.next, 10 * 60 + 45));
  expect({
    lone: lone.triage.updates.map((update) => update.reply),
    burst: burst.triage.updates.map((update) => update.reply),
    burstAgain: burstAgain.triage.updates.map((update) => update.reply),
  }).toEqual({
    lone: [null],
    burst: [
      {
        text: `🚨 prd fault escalated, 10:13–10:28 UTC ${mentions}\n• back after quiet since 08:58 UTC: visitor 5xx: os.iterate.com 10`,
        // a first-party host's burst of 5xx: prd is down again
        broadcast: true,
      },
    ],
    burstAgain: [null],
  });
});

test("a page whose incidents all went a day unseen is resolved, and leaves the state", () => {
  const first = triageAt("07:30", reading5xx(1), null);
  const dayLater = triageAt("07:30", quiet, first.next, "2026-09-24");
  expect(dayLater).toMatchObject({
    triage: {
      posts: [],
      updates: [],
      resolved: [
        {
          ts: "1.0",
          text: [
            `🚨 prd: 1 visitor 5xx ${mentions}`,
            "Impact: since 09-23 07:28 UTC",
            "• ✅ visitor 5xx: os.iterate.com 1 · quiet since 09-23 07:28 UTC",
            doLine,
          ].join("\n"),
          why: "no sighting for a day, quiet since 09-23 07:28 UTC",
        },
      ],
    },
    next: { pages: [] },
  });
});

test("an incident closed while its page stays open is ticked, and seen again the next day it opens that day's page", () => {
  const first = triageAt(
    "07:30",
    { ...quiet, errors: [["boom", 1]], serverErrors: [["https://os.iterate.com/", 1]] },
    null,
  );
  // boom goes on; os.iterate.com's 5xx stops.
  const kept = ["12:00", "18:00"].reduce(
    (state, hhmm) => triageAt(hhmm, { ...quiet, errors: [["boom", 1]] }, state).next,
    first.next,
  );
  const dayLater = triageAt(
    "07:30",
    { ...quiet, serverErrors: [["https://os.iterate.com/", 1]], errors: [["boom", 1]] },
    kept,
    "2026-09-24",
  );
  expect(dayLater.triage).toMatchObject({
    posts: [
      {
        page: { text: expect.stringContaining("• visitor 5xx: os.iterate.com 1 · last 07:28 UTC") },
      },
    ],
    updates: [
      {
        ts: "1.0",
        text: expect.stringContaining(
          "• ✅ visitor 5xx: os.iterate.com 1 · quiet since 09-23 07:28 UTC",
        ),
        reply: null,
      },
    ],
  });
  expect(dayLater.triage.posts[0]?.page.text).not.toContain("boom");
});

test("a new incident the same UTC day joins that day's page by an edit; one that pings is told in today's dashboard thread", () => {
  const first = triageAt("07:30", reading5xx(1), null);
  const lone = triageAt(
    "07:45",
    { ...quiet, serverErrors: [["https://garple.com/", 1]] },
    first.next,
  );
  const burst = triageAt("08:00", { ...quiet, errors: [["boom", 12]] }, lone.next);
  // garple.com's 5xx, a lone one at 07:45, comes in a burst: a reply in the thread
  const garpleBurst = triageAt(
    "08:15",
    { ...quiet, serverErrors: [["https://garple.com/", 12]] },
    burst.next,
  );
  expect({
    posts: [first, lone, burst, garpleBurst].map((run) => run.triage.posts.length),
    lone: lone.triage.updates,
    burst: burst.triage.updates,
    garpleBurst: garpleBurst.triage.updates.map((update) => update.reply),
  }).toMatchObject({
    posts: [1, 0, 0, 0],
    lone: [
      { ts: "1.0", text: expect.stringContaining("• visitor 5xx: garple.com 1"), reply: null },
    ],
    burst: [
      {
        ts: "1.0",
        text: expect.stringContaining("• errors: boom 12"),
        reply: {
          text: `🚨 prd fault escalated, 07:43–07:58 UTC ${mentions}\n• new: errors: boom 12`,
          broadcast: false,
        },
      },
    ],
    garpleBurst: [
      {
        text: `🚨 prd fault escalated, 07:58–08:13 UTC ${mentions}\n• new: visitor 5xx: garple.com 13`,
        broadcast: false,
      },
    ],
  });
  expect(garpleBurst.next.pages.map((page) => Object.keys(page.incidents))).toEqual([
    ["visitor 5xx: os.iterate.com", "visitor 5xx: garple.com", "errors: boom"],
  ]);
});

test("the first incident of a new UTC day opens that day's page, while yesterday's stays open for its own", () => {
  const first = triageAt("23:30", reading5xx(1), null);
  const nextDay = triageAt(
    "00:15",
    { ...quiet, serverErrors: [["https://garple.com/", 1]] },
    first.next,
    "2026-09-24",
  );
  expect(nextDay.triage).toMatchObject({
    // a minor incident: the new day's page is held unposted
    posts: [],
    held: [{ ts: "", text: expect.stringContaining("• visitor 5xx: garple.com 1") }],
    // yesterday's page only restamps its times with their date
    updates: [{ ts: "1.0", text: expect.not.stringContaining("garple.com"), reply: null }],
  });
  expect(nextDay.next.pages).toHaveLength(2);
});

test("heals below a burst add nothing to an open heals incident", () => {
  const first = triageAt("07:30", { ...quiet, heals: [["repo", 10]] }, null);
  expect(triageAt("07:45", { ...quiet, heals: [["repo", 9]] }, first.next).triage).toMatchObject({
    posts: [],
    updates: [],
  });
});

test.for([
  {
    name: "a lone 5xx on a project's own host",
    reading: { serverErrors: [["https://lispwoso.com/", 1]] },
    sent: "held",
  },
  {
    name: "a lone 5xx on a made-up iterate.com name, a project's host",
    reading: { serverErrors: [["https://build.iterate.com/.env", 1]] },
    sent: "held",
  },
  { name: "a lone error", reading: { errors: [["boom", 1]] }, sent: "held" },
  {
    name: "a deploy's lone 5xx on a project's own host",
    reading: {
      causes: [
        { cause: "deploy reset", worker: "os-prd", serverErrors: [["https://garple.com/", 1]] },
      ],
    },
    sent: "held",
  },
  {
    name: "a burst of 5xx on a project's own host",
    reading: { serverErrors: [["https://lispwoso.com/", 10]] },
    sent: "thread",
  },
  { name: "a burst of errors", reading: { errors: [["boom", 10]] }, sent: "thread" },
  {
    name: "a lone 5xx on iterate.com",
    reading: { serverErrors: [["https://iterate.com/", 1]] },
    sent: "thread",
  },
  {
    name: "a lone 5xx on www.iterate.com",
    reading: { serverErrors: [["https://www.iterate.com/", 1]] },
    sent: "thread",
  },
  {
    name: "a lone 5xx on a first-party app",
    reading: { serverErrors: [["https://agents.iterate.com/", 1]] },
    sent: "thread",
  },
  {
    name: "a deploy's lone 5xx on a first-party app",
    reading: {
      causes: [
        { cause: "deploy reset", worker: "dash", serverErrors: [["https://dash.iterate.com/", 1]] },
      ],
    },
    sent: "thread",
  },
  {
    name: "a burst of 5xx on iterate.com (prd is down)",
    reading: { serverErrors: [["https://iterate.com/", 10]] },
    sent: "channel too",
  },
  {
    name: "a burst of 5xx on os.iterate.com (prd is down)",
    reading: { serverErrors: [["https://os.iterate.com/api", 10]] },
    sent: "channel too",
  },
  {
    name: "a deploy's burst of 5xx on a first-party app (prd is down)",
    reading: {
      causes: [
        {
          cause: "version skew",
          worker: "os-prd",
          serverErrors: [
            ["https://os.iterate.com/", 6],
            ["https://mcp.iterate.com/", 4],
          ],
        },
      ],
    },
    sent: "channel too",
  },
] satisfies { name: string; reading: Partial<FaultReading>; sent: string }[])(
  "$name: $sent",
  ({ reading, sent }) => {
    const triage = triageIncidents({ ...quiet, ...reading }, window, null, false);
    const [post] = triage.posts;
    const posted = post?.broadcast ? "channel too" : "thread";
    expect({ sent: post ? posted : "held" }).toEqual({ sent });
  },
);

test("the dashboard's prd faults row names the two biggest open incidents: red while one was seen in the last hour, amber once all are quiet, green once none is open", () => {
  const seen = triageAt(
    "07:30",
    {
      ...quiet,
      serverErrors: [
        ["https://garple.com/", 3],
        ["https://lispwoso.com/", 2],
        ["https://ferovo.com/", 1],
      ],
      errors: [["boom", 12]],
    },
    null,
  );
  const quietHour = triageAt("08:30", quiet, seen.next);
  const dayLater = triageAt("07:30", quiet, quietHour.next, "2026-09-24");
  expect(
    [seen, quietHour, dayLater].map(({ next }) => faultRow(next.pages, Date.parse(next.readUntil))),
  ).toEqual([
    { state: "red", text: "errors: boom 12 · visitor 5xx: garple.com 3 · +2 more" },
    { state: "amber", text: "errors: boom 12 · visitor 5xx: garple.com 3 · +2 more" },
    { state: "green", text: "quiet" },
  ]);
});

test("a long row is cut before its +N more", () => {
  const long = triageAt(
    "07:30",
    {
      ...quiet,
      errors: [
        ["x".repeat(40), 12],
        ["y".repeat(40), 11],
        ["z", 10],
      ],
    },
    null,
  );
  expect(faultRow(long.next.pages, now.getTime())).toEqual({
    state: "red",
    text: `errors: ${"x".repeat(40)} 12 · errors: ${"y".repeat(28)}… · +1 more`,
  });
});

test("a test run posts its page, minor or not, as 🧪 and mentioning nobody", () => {
  const minor: FaultReading = { ...quiet, serverErrors: [["https://lispwoso.com/", 1]] };
  expect(
    triageIncidents(minor, window, null, true).posts.map(({ page }) => page.text.split("\n")[0]),
  ).toEqual(["🧪 TEST RUN — 🚨 prd: 1 visitor 5xx"]);
});

test("a deploy's cause is one incident listing its visitor 5xx by host, at most five", () => {
  const hosts = ["a", "b", "c", "d", "e", "f"].map((host, i): [string, number] => [
    `https://${host}.com/x`,
    6 - i,
  ]);
  expect(
    triageIncidents(
      {
        ...quiet,
        causes: [{ cause: "deploy reset", worker: "os-prd", serverErrors: hosts }],
      },
      window,
      null,
      false,
    ).pages[0]?.text.split("\n"),
  ).toEqual([
    `🚨 prd: deploy reset (os-prd), 21 visitor 5xx ${mentions}`,
    "Impact: since 07:30 UTC",
    "• deploy reset (os-prd): 21 visitor 5xx on a.com 6, b.com 5, c.com 4, d.com 3, e.com 2 +1 · last 07:30 UTC",
    doLine,
  ]);
});

test.for([
  {
    name: "a scanner's paths on one host",
    message: "GET https://est-01k4yj6assfqfshsahjshe9pdp.iterate.com/.env?x=1",
    label: "GET https://est-01k4yj6assfqfshsahjshe9pdp.iterate.com/…",
  },
  {
    name: "a workerd reference",
    message: "internal error; reference = m6mc1rpui1cli5qkt7sqpp87",
    label: "internal error; reference = …",
  },
  {
    name: "an event id",
    message: 'idempotency key "slack-webhook:Ev0C495GFWQ0" already names a different event',
    label: 'idempotency key "slack-webhook:…" already names a different event',
  },
  {
    name: "a stack's frames",
    message: "stream processor registry alarm arming failed     at index.js:18313:27",
    label: "stream processor registry alarm arming failed",
  },
  {
    name: "an alarm's scheduled time",
    message: "Mon Sep 21 2026 17:05:08 GMT+0000 (Coordinated Universal Time)",
    label: "a Durable Object alarm failed",
  },
  { name: "a message with neither", message: "call timed out", label: "call timed out" },
])("an error is keyed by what it says, not its ids and places: $name", ({ message, label }) => {
  expect([...incidentsOf({ ...quiet, errors: [[message, 1]] }).values()]).toEqual([
    { what: "errors", label, count: 1, hosts: {} },
  ]);
});

test("a failed invocation's request line is one incident per method and host, not per path", () => {
  expect([
    ...incidentsOf({
      ...quiet,
      errors: [
        ["GET https://est-01k4yj6assfqfshsahjshe9pdp.iterate.com/credentials.csv", 10],
        ["GET https://est-01k4yj6assfqfshsahjshe9pdp.iterate.com/.env?x=1", 1],
        ["POST https://k.iterate.com/?rest_route=%2Fbatch%2Fv1", 1],
        ["call timed out", 2],
      ],
    }).keys(),
  ]).toEqual([
    "errors: GET https://est-01k4yj6assfqfshsahjshe9pdp.iterate.com/…",
    "errors: POST https://k.iterate.com/…",
    "errors: call timed out",
  ]);
});

// ── which runs post ──

test.for([
  {
    name: "a scheduled run on main",
    options: { ref: "refs/heads/main" },
    mode: { keeps: true, posts: true, readsState: true, testRun: false },
  },
  {
    name: "a dispatch on a branch",
    options: { ref: "refs/heads/a-branch" },
    mode: { keeps: false, posts: false, readsState: true, testRun: false },
  },
  {
    name: "a run without a ref",
    options: {},
    mode: { keeps: false, posts: false, readsState: true, testRun: false },
  },
  {
    name: "a dry run on main",
    options: { ref: "refs/heads/main", dryRun: true },
    mode: { keeps: false, posts: false, readsState: true, testRun: false },
  },
  {
    name: "a replay on main",
    options: { ref: "refs/heads/main", at: "2026-09-23T07:30:00Z" },
    mode: { keeps: false, posts: false, readsState: false, testRun: false },
  },
  {
    name: "a test run on a branch",
    options: { ref: "refs/heads/a-branch", testRun: true },
    mode: { keeps: false, posts: true, readsState: false, testRun: true },
  },
  {
    name: "a test run on main",
    options: { ref: "refs/heads/main", testRun: true },
    mode: { keeps: false, posts: true, readsState: false, testRun: true },
  },
])("$name: $mode", ({ options, mode }) => {
  expect(runMode(options)).toEqual(mode);
});

test.for([
  {
    name: "a state this alarm wrote is read",
    content: JSON.stringify({ readUntil: "2026-09-23T07:28:00.000Z", pages: [], pins: {} }),
    read: true,
  },
  {
    name: "a state of the old shape starts over",
    content: JSON.stringify({
      readUntil: "2026-09-23T07:28:00.000Z",
      incidents: {
        "5xx responses: a.com": {
          thread: "1.0",
          lastSeen: "2026-09-23T07:28:00.000Z",
          count: 1,
          told: 1,
        },
      },
      pins: {},
    }),
    read: false,
  },
  { name: "a state that is not JSON starts over", content: "{", read: false },
])("$name", ({ content, read }) => {
  using directory = mkdtempDisposableSync(join(tmpdir(), "iterate-test-"));
  const path = join(directory.path, "state.json");
  writeFileSync(path, content);
  vi.spyOn(console, "log").mockImplementation(() => {});
  expect({ read: readState(path) !== null }).toEqual({ read });
});

test("a run on main keeps its state after posting; a dispatch on a branch keeps none", async () => {
  workersLogs(serverErrorsOnly(0));
  using _doppler = fakeDoppler({ secrets: { CLOUDFLARE_API_TOKEN: credentials.apiToken } });
  using directory = mkdtempDisposableSync(join(tmpdir(), "iterate-test-"));
  const kept = await Promise.all(
    ["refs/heads/main", "refs/heads/a-branch"].map(async (ref) => {
      const stateOut = join(directory.path, `${ref.replaceAll("/", "-")}.json`);
      await run({ ref, stateOut });
      return readState(stateOut) !== null;
    }),
  );
  expect(kept).toEqual([true, false]);
});

// ── posting ──

test("a quiet run never builds a Slack client, so a broken token cannot turn it red", async () => {
  workersLogs(serverErrorsOnly(0));
  const slack = vi.fn(() => {
    throw new Error("no Slack token");
  });
  await expect(
    alarm({ window, state: null, cloudflare: credentials, slack, testRun: false }),
  ).resolves.toMatchObject({ summary: "prd is quiet" });
  expect(slack).not.toHaveBeenCalled();
});

test("a page that pings is a reply in today's dashboard thread; its repeat is an edit, never a new message", async () => {
  const slack = fakeSlack({ now: now.getTime() });
  const run1 = await runAt("07:30", null, slack, serverErrorsOnly(10));
  await runAt("07:45", run1.next, slack, serverErrorsOnly(2));
  expect(errorPulse(slack)).toEqual([
    {
      dashboard: [
        "📟 error-pulse · Wed 23 Sep · 07:43 UTC",
        "🔴 prd faults: visitor 5xx: lispwoso.com 12",
      ],
      replies: [`🚨 prd: 12 visitor 5xx ${mentions}`],
    },
  ]);
  // the dashboard and the page
  expect(posts(slack)).toHaveLength(2);
});

test("a minor incident pings nobody: its page stays unposted, the row shows it red, then amber once quiet, and it leaves with nothing sent", async () => {
  const slack = fakeSlack({ now: now.getTime() });
  const seen = await runAt("07:30", null, slack, serverErrorsOnly(1));
  const red = errorPulse(slack);
  const callsBefore = slack.calls.length;
  // 45 minutes on, the row still says the same: no call to Slack
  const stillRed = await runAt("08:15", seen.next, slack);
  const quietCalls = slack.calls.length - callsBefore;
  const quietHour = await runAt("08:30", stillRed.next, slack);
  const dayLater = await runAt("07:45", quietHour.next, slack, serverErrorsOnly(0), "2026-09-24");
  expect({
    red,
    quietCalls,
    channel: errorPulse(slack),
    pages: [seen, dayLater].map((run) => run.next.pages.map((page) => page.ts)),
  }).toEqual({
    red: [
      {
        dashboard: [
          "📟 error-pulse · Wed 23 Sep · 07:28 UTC",
          "🔴 prd faults: visitor 5xx: lispwoso.com 1",
        ],
        replies: [],
      },
    ],
    quietCalls: 0,
    channel: [
      {
        dashboard: [
          "📟 error-pulse · Wed 23 Sep · 08:28 UTC",
          "🟡 prd faults: visitor 5xx: lispwoso.com 1",
        ],
        replies: [],
      },
      {
        dashboard: ["📟 error-pulse · Thu 24 Sep · 07:43 UTC", "🟢 prd faults: quiet"],
        replies: [],
      },
    ],
    pages: [[""], []],
  });
});

test("a burst later posts the page its minor incident was held on", async () => {
  const slack = fakeSlack({ now: now.getTime() });
  const lone = await runAt("07:30", null, slack, serverErrorsOnly(1));
  const burst = await runAt("07:45", lone.next, slack, serverErrorsOnly(12));
  const [dashboard] = slack.channel("#error-pulse");
  expect({
    page: dashboard!.replies.map((reply) => reply.text),
    pages: burst.next.pages.map((page) => page.ts),
  }).toEqual({
    page: [
      [
        `🚨 prd: 13 visitor 5xx ${mentions}`,
        "Impact: since 07:28 UTC",
        "• visitor 5xx: lispwoso.com 13 · last 07:43 UTC",
        doLine,
      ].join("\n"),
    ],
    pages: [dashboard!.replies[0]!.ts],
  });
});

test("a burst of 5xx on iterate.com is prd down: its page is sent to the channel too", async () => {
  const slack = fakeSlack({ now: now.getTime() });
  await runAt("07:30", null, slack, serverErrorsOnly(12, { url: "https://iterate.com/" }));
  const [dashboard] = slack.channel("#error-pulse");
  expect(posts(slack).filter((post) => post.thread_ts)).toMatchObject([
    {
      thread_ts: dashboard!.ts,
      reply_broadcast: true,
      text: expect.stringMatching(/^🚨 prd: 12 visitor 5xx /u),
    },
  ]);
});

test("prd down reaches the channel once a page: the same outage growing tenfold is told in the thread alone", async () => {
  const slack = fakeSlack({ now: now.getTime() });
  const run1 = await runAt(
    "07:30",
    null,
    slack,
    serverErrorsOnly(12, { url: "https://iterate.com/" }),
  );
  await runAt("07:45", run1.next, slack, serverErrorsOnly(150, { url: "https://iterate.com/" }));
  expect(
    posts(slack)
      .filter((post) => post.thread_ts)
      .map((post) => [String(post.text).split("\n")[0], Boolean(post.reply_broadcast)]),
  ).toEqual([
    [`🚨 prd: 12 visitor 5xx ${mentions}`, true],
    [`🚨 prd fault escalated, 07:28–07:43 UTC ${mentions}`, false],
  ]);
});

test("a page Slack refuses to edit is posted again, and its state moves there", async () => {
  const slack = fakeSlack({ now: now.getTime() });
  const run1 = await runAt("07:30", null, slack, serverErrorsOnly(10));
  const [dashboard] = slack.channel("#error-pulse");
  dashboard!.replies[0]!.updateError = "edit_window_closed";
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const run2 = await runAt("07:45", run1.next, slack, serverErrorsOnly(90));
  expect({
    channel: errorPulse(slack),
    pages: run2.next.pages.map((open) => open.ts),
  }).toEqual({
    channel: [
      {
        dashboard: [
          "📟 error-pulse · Wed 23 Sep · 07:43 UTC",
          "🔴 prd faults: visitor 5xx: lispwoso.com 100",
        ],
        replies: [
          `🚨 prd: 10 visitor 5xx ${mentions}`,
          `🚨 prd: 100 visitor 5xx ${mentions}`,
          "✅ resolved: this page moved to a new message, which Slack lets this bot edit",
          `🚨 prd fault escalated, 07:28–07:43 UTC ${mentions}`,
        ],
      },
    ],
    pages: [dashboard!.replies[1]!.ts],
  });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"slack.page-gone"'));
});

test("a resolved page is edited to say ✅ resolved: and why, and nothing about it is posted", async () => {
  const slack = fakeSlack({ now: now.getTime() });
  const run1 = await runAt("07:30", null, slack, serverErrorsOnly(10));
  await runAt("07:30", run1.next, slack, serverErrorsOnly(0), "2026-09-24");
  const [yesterday] = slack.channel("#error-pulse");
  expect({
    channel: errorPulse(slack),
    why: yesterday!.replies[0]!.text.split("\n")[1],
  }).toEqual({
    channel: [
      {
        dashboard: [
          "📟 error-pulse · Wed 23 Sep · 07:28 UTC",
          "🔴 prd faults: visitor 5xx: lispwoso.com 10",
        ],
        replies: [`✅ resolved: prd: 10 visitor 5xx ${mentions}`],
      },
      {
        dashboard: ["📟 error-pulse · Thu 24 Sep · 07:28 UTC", "🟢 prd faults: quiet"],
        replies: [],
      },
    ],
    why: "✅ no sighting for a day, quiet since 09-23 07:28 UTC",
  });
});

test("a resolved page someone deleted gets nothing in its place, and leaves the state", async () => {
  const slack = fakeSlack({ now: now.getTime() });
  const run1 = await runAt("07:30", null, slack, serverErrorsOnly(10));
  slack.channel("#error-pulse")[0]!.replies[0]!.updateError = "message_not_found";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const run2 = await runAt("07:30", run1.next, slack, serverErrorsOnly(0), "2026-09-24");
  expect({
    replies: errorPulse(slack).map((dashboard) => dashboard.replies),
    pages: run2.next.pages,
  }).toEqual({ replies: [[`🚨 prd: 10 visitor 5xx ${mentions}`], []], pages: [] });
});

test("a dry run (no Slack client) resolves to what it would post and the row it would set", async () => {
  workersLogs(serverErrorsOnly(10));
  await expect(summary()).resolves.toBe(
    [
      `post:\n${pageFor({ serverErrors: [["https://lispwoso.com/", 10]] })}`,
      "row prd faults: red, visitor 5xx: lispwoso.com 10",
    ].join("\n\n"),
  );
});

test("5xx the URL rows miss page as unknown", async () => {
  workersLogs(serverErrorsOnly(1, { unlogged: 2 }));
  expect(await summary()).toContain("• visitor 5xx: unknown 2 · last 07:30 UTC");
});

// ── reading prd ──

// A run that could not read prd must fail, never pass as a quiet prd.
test("a run that cannot read prd fails: a failed Workers Logs query", async () => {
  const cloudflare = workersLogs(() => ({
    success: false,
    errors: [{ code: 10000, message: "Authentication error" }],
  }));
  const slack = fakeSlack({ now: now.getTime() });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(summary(() => slack.client)).rejects.toThrow(
    'Workers Logs query failed: [{"code":10000,"message":"Authentication error"}]',
  );
  expect(cloudflare.fetch).toHaveBeenCalledTimes(QUIET_RUN_QUERIES);
  expect(posts(slack)).toEqual([]);
});

test("a run that cannot read prd fails: Doppler gives no Cloudflare API token", async () => {
  const cloudflare = workersLogs(() => ({ success: true }));
  using _doppler = fakeDoppler({ refusal: "Doppler Error: Invalid Auth token" });
  await expect(run({ dryRun: true })).rejects.toThrow(
    "doppler secrets download --project _shared --config prd failed: Doppler Error: Invalid Auth token",
  );
  expect(cloudflare.fetch).not.toHaveBeenCalled();
});

// Cloudflare's HTML error page, a 5xx or not, is its own failure, not an answer about the query.
test.for([
  { name: "an HTML 502", status: 502 },
  { name: "an HTML 200", status: 200 },
])(
  "a Workers Logs query answered with $name is asked again, and the retry logged",
  async ({ status }) => {
    const cloudflare = workersLogs(serverErrorsOnly(0));
    cloudflare.fetch.mockImplementationOnce(async () => cloudflareErrorPage(status));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(summary()).resolves.toBe("prd is quiet");
    // A quiet run's queries, one of them twice.
    expect(cloudflare.fetch).toHaveBeenCalledTimes(QUIET_RUN_QUERIES + 1);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith({
      event: "prd-fault-alarm.platform-failure-retry",
      kind: "disconnected",
      status,
      message: `Workers Logs query answered HTTP ${status} (text/html; charset=UTF-8): ${errorPage.slice(0, 200)}`,
      attempt: 1,
      retryInMs: 2_000,
    });
  },
);

test("a run that cannot read prd fails: Cloudflare keeps answering its HTML error page", async () => {
  const cloudflare = workersLogs(serverErrorsOnly(0));
  cloudflare.fetch.mockImplementation(async () => cloudflareErrorPage(502));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const slack = fakeSlack({ now: now.getTime() });
  await expect(summary(() => slack.client)).rejects.toMatchObject({
    message: `Workers Logs query answered HTTP 502 (text/html; charset=UTF-8): ${errorPage.slice(0, 200)}`,
  });
  // Each query asked four times, the first and three repeats, then no more.
  await vi.waitFor(() => expect(cloudflare.fetch).toHaveBeenCalledTimes(4 * QUIET_RUN_QUERIES));
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "prd-fault-alarm.platform-failure-retry",
      attempt: 3,
      retryInMs: 10_000,
    }),
  );
  expect(warn).not.toHaveBeenCalledWith(expect.objectContaining({ attempt: 4 }));
  expect(posts(slack)).toEqual([]);
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
        value: "os-prd,dash,agents,notes,docs,admin,voice,kiterate,iterate-spa",
        type: "string",
      }),
    ]),
  );
});

// What counts as the visitor's own invocation: VISITOR and ERROR_ROWS in ./prd-fault-alarm.ts.
test.for([
  {
    name: "a third party's 502 relayed through the egress hops (docs.parallel.ai, 2026-09-28 11:50) pages nothing",
    events: () => thirdPartyRequest("https://docs.parallel.ai/public-openapi.json", 502),
    page: null,
  },
  {
    name: "SecretRefused's designed 502 from the SecretDurableObject pages nothing",
    events: () => [
      invocation({ hop: "SecretDurableObject", status: 502, url: "https://api.github.com/user" }),
    ],
    page: null,
  },
  {
    name: "a visitor 5xx and its request line are one sighting (GitHub webhook, 2026-09-25 23:05)",
    events: () => [
      invocation({ status: 500, url: "https://os.iterate.com/api/integrations/github/webhook" }),
      invocation({
        status: 500,
        url: "https://os.iterate.com/api/integrations/github/webhook",
        requestId: "second",
      }),
    ],
    page: ["• visitor 5xx: os.iterate.com 2 · last 07:30 UTC"],
  },
  {
    name: "a visitor request line with no status (an exception mid-response) is an error",
    events: () => [invocation({ outcome: "exception", url: "https://garple.com/chat" })],
    page: ["• errors: GET https://garple.com/… 1 · last 07:30 UTC"],
  },
  {
    name: "a 500 a project's own code answered pages as its host (garple.com's POST /chat/warm, 2026-09-28 19:51)",
    events: () => [
      invocation({
        hop: "IterateContextDurableObject",
        status: 500,
        url: "https://garple.com/chat/warm",
        rayId: "warm",
      }),
      invocation({ status: 500, url: "https://garple.com/chat/warm", rayId: "warm" }),
    ],
    page: ["• visitor 5xx: garple.com 1 · last 07:30 UTC"],
  },
  {
    name: "a platform failure the edge answered 503 pages as its host's visitor 5xx: no expected outcome",
    events: () => [
      platformFailureAnswered("stall", "https://garple.com/chat/events"),
      invocation({ status: 503, url: "https://garple.com/chat/events", rayId: "stall" }),
    ],
    page: ["• visitor 5xx: garple.com 1 · last 07:30 UTC"],
  },
  {
    name: "a jsrpc summary of a call that logged its exception is that exception's one sighting",
    events: () => [
      invocation({
        hop: "IterateContextDurableObject",
        eventType: "jsrpc",
        outcome: "exception",
        requestId: "call",
      }),
      line({
        hop: "IterateContextDurableObject",
        requestId: "call",
        message: 'The RPC receiver does not implement the method "append".',
      }),
    ],
    page: ['• errors: The RPC receiver does not implement the method "append". 1 · last 07:30 UTC'],
  },
  {
    name: "an alarm's summary of an alarm that logged its exception is that exception's one sighting",
    events: () => [
      invocation({
        hop: "WorkerBuildCoordinatorDurableObject",
        eventType: "alarm",
        outcome: "exception",
        requestId: "alarm",
        message: "Mon Sep 21 2026 17:05:08 GMT+0000 (Coordinated Universal Time)",
      }),
      line({
        hop: "WorkerBuildCoordinatorDurableObject",
        requestId: "alarm",
        message: "Repo has no commits yet (unseeded or still seeding)",
      }),
    ],
    page: ["• errors: Repo has no commits yet (unseeded or still seeding) 1 · last 07:30 UTC"],
  },
  {
    name: "bare alarm summaries, each naming its scheduled time, are one incident",
    events: () =>
      ["17:05:08", "17:10:01"].map((time) =>
        invocation({
          hop: "WorkerBuildCoordinatorDurableObject",
          eventType: "alarm",
          outcome: "exception",
          requestId: time,
          message: `Mon Sep 21 2026 ${time} GMT+0000 (Coordinated Universal Time)`,
        }),
      ),
    page: ["• errors: a Durable Object alarm failed 2 · last 07:30 UTC"],
  },
  {
    name: "a bare jsrpc summary, with no exception logged, pages",
    events: () => [
      invocation({ hop: "SecretDurableObject", eventType: "jsrpc", outcome: "exception" }),
    ],
    page: ["• errors: SecretDurableObject.jsrpc 1 · last 07:30 UTC"],
  },
  {
    name: "a context destroyed with its deleted project, announced at info, pages nothing, nor its jsrpc summary",
    events: () => announcedReset("context.destroyed", "do-1", "destroyed: its project was deleted"),
    page: null,
  },
  {
    name: "the context sweep's lookup of an id nothing was born at, announced at info, pages nothing, nor its jsrpc summary",
    events: () =>
      announcedReset(
        "context.unborn-by-id",
        "do-1",
        "IterateContextDurableObject must be addressed by name (reach it via getByName); by id, only a context that was born answers.",
      ),
    page: null,
  },
  {
    name: "an itx.abort() reset, announced at info, pages nothing",
    events: () =>
      announcedReset(
        "context.aborted",
        "do-1",
        "itx.abort() reset the context /: a deploy's reset, on demand",
      ),
    page: null,
  },
  {
    name: "a deleted root's reset once its project came back, announced at info, pages nothing",
    events: () =>
      announcedReset(
        "context.root-restored",
        "do-1",
        "project prj_x was restored: its root is born on the next request",
      ),
    page: null,
  },
  {
    name: "the calls in flight a reset rejects with its message page nothing (itx.abort() on a preview, 2026-09-29 09:56)",
    events: () => [
      ...announcedReset("context.aborted", "do-1", "itx.abort() reset the context /: busy"),
      ...rejectedInFlight("do-1", "in-flight", "itx.abort() reset the context /: busy"),
    ],
    page: null,
  },
  {
    name: "the same error in a Durable Object that announced nothing pages",
    events: () => [
      ...announcedReset("context.destroyed", "do-1", "destroyed: its project was deleted"),
      ...rejectedInFlight("do-2", "unannounced", "destroyed: its project was deleted"),
    ],
    page: ["• errors: destroyed: its project was deleted 1 · last 07:30 UTC"],
  },
  {
    name: "a secret facet's last call session, cut off as its deletion was announced at info, pages nothing (prd's secrets.delete, 2026-09-28 11:20)",
    events: () => [deletedSecretFacet("do-1"), cutOffSecretCall("do-1")],
    page: null,
  },
  {
    name: "a bare SecretDurableObject.jsrpc in a Durable Object that announced no deletion pages",
    events: () => [deletedSecretFacet("do-1"), cutOffSecretCall("do-2")],
    page: ["• errors: SecretDurableObject.jsrpc 1 · last 07:30 UTC"],
  },
  {
    name: "another class's bare summary in a Durable Object that deleted its secret facet pages",
    events: () => [
      deletedSecretFacet("do-1"),
      invocation({
        hop: "RepoDurableObject",
        eventType: "jsrpc",
        outcome: "exception",
        requestId: "repo-cut",
        objectId: "do-1",
      }),
    ],
    page: ["• errors: RepoDurableObject.jsrpc 1 · last 07:30 UTC"],
  },
  {
    name: "another error in a Durable Object that announced a reset pages",
    events: () => [
      ...announcedReset("context.aborted", "do-1", "itx.abort() reset the context /: busy"),
      ...rejectedInFlight("do-1", "other", "Durable Object storage operation exceeded timeout"),
    ],
    page: ["• errors: Durable Object storage operation exceeded timeout 1 · last 07:30 UTC"],
  },
])("$name", async ({ events, page }) => {
  queryableWorkersLogs(events());
  const result = await summary();
  expect(page ? bullets(result) : result).toEqual(page || "prd is quiet");
});

// The deploy causes: CAUSES in ./prd-fault-alarm.ts.
test.for([
  {
    name: "a deploy reset's visitor 5xx are one incident of its Worker, and its errors page nothing",
    events: () => [
      ...deployResetRay("r1", "https://api-sandbox.garple.com/proc/self/cgroup"),
      ...deployResetRay("r2", "https://api-sandbox.garple.com/@fs/.env"),
    ],
    page: ["• deploy reset (os-prd): 2 visitor 5xx on api-sandbox.garple.com 2 · last 07:30 UTC"],
  },
  {
    name: "a deploy reset whose visitor got no 5xx pages nothing",
    events: () =>
      deployResetRay("r1", "https://garple.com/").filter(
        (event) => !JSON.stringify(event).includes('"status":500'),
      ),
    page: null,
  },
  {
    name: "a pager that gave up in a deploy reset's ray pages its error",
    events: () => [
      ...deployResetRay("r1", "https://os.iterate.com/api?session=1").filter(
        (event) => !JSON.stringify(event).includes('"status":500'),
      ),
      {
        ...line({
          message: "a lent stub's pager dropped and could not be re-dialed",
          rayId: "r1",
          requestId: "r1-visitor",
          url: "https://os.iterate.com/api?session=1",
        }),
        event: "rpc-stub-pager-redial-failed",
      },
    ],
    page: ["• errors: a lent stub's pager dropped and could not be re-dialed 1 · last 07:30 UTC"],
  },
  {
    name: "a version skew's visitor 5xx are one incident of its Worker",
    events: () =>
      deployResetRay("r1", "https://garple.com/").map((event) =>
        event.$metadata.message?.startsWith("Durable Object reset")
          ? {
              ...event,
              $metadata: {
                ...event.$metadata,
                message: "Unable to deserialize cloned data due to invalid or unsupported version.",
              },
            }
          : event,
      ),
    page: ["• version skew (os-prd): 1 visitor 5xx on garple.com 1 · last 07:30 UTC"],
  },
  {
    name: "a deploy's resets logged by its old and new version, and the next deploy's, are one incident of the Worker",
    events: () => [
      ...deployResetRay("r1", "https://garple.com/"),
      ...deployResetRay("r2", "https://lispwoso.com/", "a65e434e-0000"),
      ...deployResetRay("r3", "https://garple.com/", "c0ffee00-0000"),
    ],
    page: [
      "• deploy reset (os-prd): 3 visitor 5xx on garple.com 2, lispwoso.com 1 · last 07:30 UTC",
    ],
  },
  {
    name: "another Worker's reset is another incident",
    events: () => [
      ...deployResetRay("r1", "https://garple.com/"),
      ...deployResetRay("r2", "https://dash.iterate.com/").map((event) => ({
        ...event,
        $metadata: { ...event.$metadata, service: "dash" },
      })),
    ],
    page: [
      "• deploy reset (os-prd): 1 visitor 5xx on garple.com 1 · last 07:30 UTC",
      "• deploy reset (dash): 1 visitor 5xx on dash.iterate.com 1 · last 07:30 UTC",
    ],
  },
])("$name", async ({ events, page }) => {
  queryableWorkersLogs(events());
  const result = await summary();
  expect(page ? bullets(result) : result).toEqual(page || "prd is quiet");
});

test.for([
  { name: "message", key: "message" },
  { name: "error", key: "error" },
])("expected outcomes have the same policy in metadata.$name", async ({ key }) => {
  const messages = [
    "Durable Object reset because its code was updated.",
    "Can't read from request stream after response has been sent.",
    "Unable to deserialize cloned data due to invalid or unsupported version.",
  ];
  queryableWorkersLogs(
    messages.map((message) => ({
      timestamp: 42,
      $metadata: { type: "cf-worker", [key]: message },
      $workers: {},
    })),
  );
  await expect(summary()).resolves.toBe("prd is quiet");
});

test.for([
  { name: "message", key: "message" },
  { name: "error", key: "error" },
])("an unread /api body remains actionable in metadata.$name", async ({ key }) => {
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
  expect(bullets(await summary())).toEqual([
    "• errors: Can't read from request stream after response has been sent. 1 · last 07:30 UTC",
  ]);
});

const HUNG =
  "The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response. Refer to: https://developers.cloudflare.com/workers/observability/errors/";
const RPC_BODY_ENDED_EARLY = "ReadableStream received over RPC disconnected prematurely.";

// PINNED_LINES and a socket close's reset (CLOSE_RESET) in ./prd-fault-alarm.ts, as prd logged them.
test.for([
  {
    name: "a hung line on ItxEntrypoint is the pinned false one, and its jsrpc summary folds into it",
    events: () => [
      line({ hop: "ItxEntrypoint", requestId: "ai-run", message: HUNG }),
      invocation({
        hop: "ItxEntrypoint",
        eventType: "jsrpc",
        outcome: "exception",
        requestId: "ai-run",
      }),
    ],
    page: null,
  },
  {
    name: "a hung line on any other invocation pages",
    events: () => [line({ message: HUNG })],
    page: [
      "• errors: The Workers runtime canceled this request because it detected that your Worker's 1 · last 07:30 UTC",
    ],
  },
  {
    name: "a context forwarding a repo's git requests logs the pinned RPC body line on its fetch and its jsrpc session (2026-09-29 10:35)",
    events: () => [
      line({
        hop: "IterateContextDurableObject",
        requestId: "session",
        message: RPC_BODY_ENDED_EARLY,
      }),
      line({
        hop: "IterateContextDurableObject",
        requestId: "forward",
        message: RPC_BODY_ENDED_EARLY,
        url: "https://github.com/iterate/config.git/git-upload-pack",
      }),
    ],
    page: null,
  },
  {
    name: "the RPC body line on any other invocation pages",
    events: () => [line({ hop: "ItxEntrypoint", message: RPC_BODY_ENDED_EARLY })],
    page: [
      "• errors: ReadableStream received over RPC disconnected prematurely. 1 · last 07:30 UTC",
    ],
  },
  {
    name: "a context's socket close logging its reset pages nothing once every pager re-dialed (2026-09-28 14:49)",
    events: () => [...closeReset("close"), pagerRedialed()],
    page: null,
  },
  {
    name: "a context's socket close logging its reset pages when no pager re-dialed",
    events: () => closeReset("close"),
    page: ["• errors: internal error; reference = … 1 · last 07:30 UTC"],
  },
  {
    name: "the same reset in a context's jsrpc call pages, every pager re-dialed or not",
    events: () => [
      line({
        hop: "IterateContextDurableObject",
        requestId: "call",
        message: "internal error; reference = 4b2bd3s1lpsjhc4kfd1fh7gm",
      }),
      pagerRedialed(),
    ],
    page: ["• errors: internal error; reference = … 1 · last 07:30 UTC"],
  },
])("$name", async ({ events, page }) => {
  queryableWorkersLogs(events());
  const result = await summary();
  expect(page ? bullets(result) : result).toEqual(page || "prd is quiet");
});

test.for([
  { name: "undefined", message: undefined },
  { name: "null", message: null },
  { name: "empty", message: "" },
  { name: "the same text", message: "boom" },
])("a structured error is counted exactly once with a message $name", async ({ message }) => {
  queryableWorkersLogs([
    { timestamp: 42, $metadata: { type: "cf-worker", message, error: "boom" }, $workers: {} },
  ]);
  expect(bullets(await summary())).toEqual(["• errors: boom 1 · last 07:30 UTC"]);
});

test("past 500 folded summaries, the rest page beside their exception and the log says so", async () => {
  queryableWorkersLogs(
    rays("call-", 600).flatMap((requestId) => [
      invocation({ hop: "RepoDurableObject", eventType: "jsrpc", outcome: "exception", requestId }),
      line({ hop: "RepoDurableObject", requestId, message: "boom" }),
    ]),
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(bullets(await summary())).toEqual([
    "• errors: boom 600 · last 07:30 UTC",
    "• errors: RepoDurableObject.jsrpc 100 · last 07:30 UTC",
  ]);
  expect(warn).toHaveBeenCalledWith(
    JSON.stringify({ event: "prd-fault-alarm.fold-capped", unfolded: 100 }),
  );
});

// A killed `iterate tunnel` leaves its fetch route's target, a lent stub, offline until its rule is
// un-set: 502s, in the ray of the context DO's `expression-fetch.rpc-stub-offline` info line.
test("a tunnel's offline-stub 502s, every hop of them, page nothing", async () => {
  queryableWorkersLogs(rpcStubOfflineRequest("vite-ping"));
  await expect(summary()).resolves.toBe("prd is quiet");
});

test.for([
  {
    name: "a 500 in the offline request's ray",
    change: { status: 500 },
    page: ["• visitor 5xx: blog--p.iterate.app 1 · last 07:30 UTC"],
  },
  {
    name: "a 502 in another ray",
    change: { rayId: "other" },
    page: ["• visitor 5xx: blog--p.iterate.app 1 · last 07:30 UTC"],
  },
  {
    name: "a 502 without a ray",
    change: { rayId: undefined },
    page: ["• visitor 5xx: blog--p.iterate.app 1 · last 07:30 UTC"],
  },
  {
    name: "an exception in the offline request's ray",
    change: { type: "cf-worker", message: "boom", status: undefined },
    page: ["• errors: boom 4 · last 07:30 UTC"],
  },
])("$name still pages", async ({ change, page }) => {
  queryableWorkersLogs([
    ...rpcStubOfflineRequest("vite-ping"),
    ...rpcStubOfflineRequest("vite-ping", change).slice(1),
  ]);
  expect(bullets(await summary())).toEqual(page);
});

// A deploy that resets a context an expression fetch dialed, where the hop could not send it again
// (a request with a body), answers 503, in the ray of the context DO's `expression-fetch.deploy-reset`.
const deployReset503 = { event: "expression-fetch.deploy-reset", status: 503 };
test("a deploy reset's designed 503s page nothing", async () => {
  queryableWorkersLogs(rpcStubOfflineRequest("post", {}, deployReset503));
  await expect(summary()).resolves.toBe("prd is quiet");
});

test.for([
  {
    name: "a 502 in a deploy reset's ray",
    events: () => rpcStubOfflineRequest("post", { status: 502 }, deployReset503).slice(1),
  },
  {
    name: "a 503 in an offline stub's ray",
    events: () => rpcStubOfflineRequest("vite-ping", { status: 503 }).slice(1),
  },
])("$name still pages", async ({ events }) => {
  queryableWorkersLogs([
    ...rpcStubOfflineRequest("post", {}, deployReset503),
    ...rpcStubOfflineRequest("vite-ping"),
    ...events(),
  ]);
  expect(bullets(await summary())).toEqual([
    "• visitor 5xx: blog--p.iterate.app 1 · last 07:30 UTC",
  ]);
});

test.for([
  { name: "capped", reason: "capped" },
  { name: "failed", reason: "failed" },
])("a $name read of the offline rays keeps every 502 paging", async ({ reason }) => {
  const events = [
    ...rpcStubOfflineRequest("vite-ping"),
    ...(reason === "capped"
      ? Array.from({ length: 2000 }, (_, i) => rpcStubOfflineRequest(`t${i}`)[0]!)
      : []),
  ];
  queryableWorkersLogs(events, (query) => {
    if (reason === "failed" && query.parameters.groupBys?.[0]?.value === "$metadata.rayId")
      throw new Error("network failed");
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(bullets(await summary())).toEqual([
    "• visitor 5xx: blog--p.iterate.app 1 · last 07:30 UTC",
  ]);
});

// A visitor whose connection went away mid-response: the runtime fails the visitor's own
// invocation with "Network connection lost." and an exception summary with no status.
test("a visitor gone mid-response pages nothing: its Network connection lost. and exception summary", async () => {
  queryableWorkersLogs(vanishedVisitorRequest("gone"));
  await expect(summary()).resolves.toBe("prd is quiet");
});

test.for([
  {
    name: "Network connection lost. on a Durable Object, without a ray",
    events: () => [
      line({ hop: "IterateContextDurableObject", message: "Network connection lost." }),
    ],
    page: ["• errors: Network connection lost. 1 · last 07:30 UTC"],
  },
  {
    name: "another error in the gone visitor's ray",
    events: () => [
      {
        ...vanishedVisitorRequest("gone")[1]!,
        $metadata: { type: "cf-worker", rayId: "gone", requestId: "x", message: "boom" },
      },
    ],
    page: ["• errors: boom 1 · last 07:30 UTC"],
  },
  {
    name: "a 5xx in the gone visitor's ray",
    events: () => [invocation({ rayId: "gone", status: 500, url: "https://os.iterate.com/api" })],
    page: ["• visitor 5xx: os.iterate.com 1 · last 07:30 UTC"],
  },
])("$name still pages", async ({ events, page }) => {
  queryableWorkersLogs([...vanishedVisitorRequest("gone"), ...events()]);
  expect(bullets(await summary())).toEqual(page);
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

// Each count at its most: 1,999 rays across the outcomes and causes it applies (four `not_in` of
// them), and for the other summaries 500 folded summaries beside them, jsrpc calls' and deleted
// facets'. Every query fits, no keep is dropped, and what is not expected still pages.
test.for([
  {
    name: "the 5xx beside an offline stub's and a deploy reset's rays",
    events: () => [
      ...rayInfoLines("expression-fetch.rpc-stub-offline", [...rays("offline-", 999), "shared"]),
      ...rayInfoLines("expression-fetch.deploy-reset", [...rays("answered-", 998), "shared"]),
      ...rpcStubOfflineRequest("offline-7").slice(1),
      ...failedDocsRequest(),
    ],
    page: ["• visitor 5xx: docs.iterate.com 1 · last 07:30 UTC"],
    most: 15,
  },
  {
    name: "the lines and request lines beside gone visitors' and deploy resets' rays and 500 contexts' announced resets",
    events: () => [
      ...rays("gone-", 1000).flatMap((ray) => vanishedVisitorRequest(ray)),
      ...rays("reset-", 999).flatMap((ray) =>
        deployResetRay(ray, "https://garple.com/").slice(1, 2),
      ),
      ...rays("destroyed-", 500).flatMap((objectId) =>
        announcedReset("context.destroyed", objectId, "destroyed: its project was deleted"),
      ),
      invocation({ outcome: "exception", url: "https://garple.com/chat", rayId: "other" }),
      line({ message: "boom", rayId: "gone-3" }),
      { timestamp: 42, $metadata: { type: "cf-worker", rayId: "gone-4", error: "structured" } },
    ],
    page: [
      "• errors: boom 1 · last 07:30 UTC",
      "• errors: structured 1 · last 07:30 UTC",
      "• errors: GET https://garple.com/… 1 · last 07:30 UTC",
    ],
    most: 16,
  },
  {
    name: "the other summaries beside deploy resets' rays and 500 folded summaries, jsrpc calls' and deleted facets'",
    events: () => [
      ...rays("reset-", 1999).flatMap((ray) =>
        deployResetRay(ray, "https://garple.com/").slice(1, 2),
      ),
      ...rays("deleted-", 250).flatMap((objectId) => [
        deletedSecretFacet(objectId),
        cutOffSecretCall(objectId),
      ]),
      ...rays("call-", 248).flatMap((requestId) => [
        invocation({
          hop: "RepoDurableObject",
          eventType: "jsrpc",
          outcome: "exception",
          requestId,
        }),
        line({ hop: "RepoDurableObject", requestId, message: "boom" }),
      ]),
      invocation({
        hop: "SecretDurableObject",
        eventType: "jsrpc",
        outcome: "exception",
        rayId: "reset-9",
        requestId: "reset",
      }),
      invocation({
        hop: "SecretDurableObject",
        eventType: "jsrpc",
        outcome: "exception",
        requestId: "bare",
      }),
    ],
    page: [
      "• errors: boom 248 · last 07:30 UTC",
      "• errors: SecretDurableObject.jsrpc 1 · last 07:30 UTC",
    ],
    most: 16,
  },
])("every query fits in 16 filter nodes at its most: $name", async ({ events, page, most }) => {
  const logs = queryableWorkersLogs(events());
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const result = await summary();
  const nodes = logs.fetch.mock.calls.map(([, init]) =>
    filterNodes((JSON.parse(init.body) as LogQuery).parameters.filters),
  );
  expect({ most: Math.max(...nodes), warned: warn.mock.calls, page: bullets(result) }).toEqual({
    most,
    warned: [],
    page,
  });
});

test.for([
  { name: "errors by message", groupBy: "$metadata.message", errors: true },
  { name: "5xx by URL", groupBy: "$workers.event.request.url", errors: false },
])("the split queries count exactly what the one query counted: $name", ({ groupBy, errors }) => {
  const answers: Exclusion[] = [
    {
      name: "offline",
      key: "$metadata.rayId",
      values: [...rays("o-", 1200), "s"],
      keep: [
        { key: "$workers.event.response.status", operation: "neq", value: 502, type: "number" },
      ],
    },
    {
      name: "answered",
      key: "$metadata.rayId",
      values: ["d-0", "d-1", "s"],
      keep: [
        { key: "$workers.event.response.status", operation: "neq", value: 503, type: "number" },
      ],
    },
    { name: "cause", key: "$metadata.rayId", values: ["c-0", "s"], keep: null },
  ];
  const exclusions: Exclusion[] = errors
    ? [
        ...answers,
        {
          name: "gone",
          key: "$metadata.rayId",
          values: ["g-0", "g-1"],
          keep: [
            {
              key: "$metadata.message",
              operation: "neq",
              value: "Network connection lost.",
              type: "string",
            },
          ],
        },
        {
          name: "folded",
          key: "$metadata.requestId",
          values: ["first"],
          keep: [
            {
              key: "$metadata.message",
              operation: "not_includes",
              value: ".jsrpc",
              type: "string",
            },
          ],
        },
      ]
    : answers;
  const row = (
    rayId: string | undefined,
    message: string,
    status?: number,
    requestId?: string,
  ) => ({
    $metadata: { service: "os-prd", level: "error", rayId, requestId, message },
    $workers: { event: { request: { url: `https://${message}.test/` }, response: { status } } },
  });
  const events = [
    ...["o-0", "o-1100"].flatMap((ray) => [
      row(ray, "GET 502", 502),
      row(ray, "GET 500", 500),
      row(ray, "boom"),
    ]),
    row("d-0", "POST 503", 503),
    row("d-0", "POST 502", 502),
    row("c-0", "GET 500", 500),
    row("c-0", "boom"),
    row("g-0", "Network connection lost."),
    row("g-0", "other"),
    row("s", "GET 502", 502),
    row("s", "boom"),
    row(undefined, "GET 502", 502),
    row(undefined, "IterateContextDurableObject.jsrpc", undefined, "first"),
    row(undefined, "boom", undefined, "first"),
    row("x", "GET 502", 502),
  ];
  const base: LogFilter[] = [
    { key: "$metadata.level", operation: "eq", value: "error", type: "string" },
  ];
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
  expect(counted(parts.map(({ filters }) => filters))).toEqual(
    counted([oneQuery(base, exclusions)]),
  );
  expect(Object.values(counted([base])).reduce((sum, n) => sum + n)).toBeGreaterThan(
    Object.values(counted([oneQuery(base, exclusions)])).reduce((sum, n) => sum + n),
  );
});

// ── pinned workarounds ──

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
    state = { readUntil: at(days).to.toISOString(), pages: [], pins: outcome.pins };
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
        `✅ Cloudflare seems to have fixed held Durable Object alarms: delete the overdue watch in core/os/src/alarm-coordinator.ts. prd has logged no \`iterate-context.platform-failure-alarm-*\` since 2026-09-23 (28 days) ${mentions}`,
        `✅ Cloudflare seems to have fixed the Worker Loader defect at facet start: delete the restart in core/os/src/context/facet-host.ts (\`isFacetStartPlatformFailure\`). prd has logged no \`facet.platform-failure-*\` since 2026-09-23 (28 days) ${mentions}`,
        `✅ Cloudflare seems to have fixed the Worker Loader clone-version defect in workers.get: delete its retire and replay in core/os/src/context/built-ins.ts. prd has logged no \`workers.platform-failure-*\` since 2026-09-23 (28 days) ${mentions}`,
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
    pinnedWorkarounds([], window, { readUntil: now.toISOString(), pages: [], pins: {} }),
  ).toMatchObject({ posts: [] });
});

test("the held-alarm pin reads prd's heals by event and posts its one message in today's dashboard thread; the next run posts nothing", async () => {
  const slack = fakeSlack({ now: now.getTime() });
  // Another workaround's heal, by event: not the pinned one's.
  const anotherHeal = (groupBy: string | undefined, filters: LogFilter[]) =>
    groupBy === "event"
      ? calculations([[["context.platform-failure-other"], 3]])
      : serverErrorsOnly(0)(groupBy, filters);
  const lastSeen = new Date(Date.parse("2026-09-23T07:28:00Z") - PIN_QUIET_DAYS * day);
  const run1 = await runAt("07:30", pinState(lastSeen), slack, anotherHeal);
  const run2 = await runAt("07:45", run1.next, slack, anotherHeal);
  expect({
    replies: errorPulse(slack).map((dashboard) =>
      dashboard.replies.map((reply) => reply.slice(0, 32)),
    ),
    pin: run2.next.pins[heldAlarm!.event],
  }).toEqual({
    replies: [["✅ Cloudflare seems to have fixed"]],
    pin: { lastSeen: lastSeen.toISOString(), told: true },
  });
});

/** How many queries a quiet run sends: the outcomes', causes', jsrpc summaries' and announced
 *  outcomes' evidence, then the 5xx by URL and in all, the heals by name and event, the error counts
 *  (each of PINNED_LINES where it pages, and a socket close's reset, among them) and the pagers. */
const QUIET_RUN_QUERIES = 20;

/** The page, posted or held, a run without state opens for `reading` (quiet elsewhere) in the half
 *  hour to `now`. */
function pageFor(reading: Partial<FaultReading>) {
  return triageIncidents({ ...quiet, ...reading }, window, null, false).pages[0]?.text || null;
}

/** A reading of `count` visitor 5xx from os.iterate.com, a first-party host: its page is posted. */
function reading5xx(count: number): FaultReading {
  return { ...quiet, serverErrors: [["https://os.iterate.com/", count]] };
}

/** One run's triage at `hhmm` on `day` after `state`, and the state it leaves once the pages it
 *  posts are posted as "N.0", N counting up from the highest ts in the state. */
function triageAt(
  hhmm: string,
  reading: FaultReading,
  state: AlarmState | null,
  day = "2026-09-23",
) {
  const window = logWindow(new Date(`${day}T${hhmm}:00Z`), state);
  const triage = triageIncidents(reading, window, state, false);
  const highest = Math.max(0, ...triage.pages.map((page) => Number(page.ts)));
  for (const [index, { page }] of triage.posts.entries()) page.ts = `${highest + index + 1}.0`;
  const next: AlarmState = { readUntil: window.to.toISOString(), pages: triage.pages, pins: {} };
  return { triage, next };
}

/** `minutes` after midnight as HH:MM. */
function clock(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The bullets of a summary's page: its incidents. */
function bullets(summary: string) {
  return summary.split("\n").filter((text) => text.startsWith("• "));
}

/** What one run without state over the half hour to `now` posts (or would post). */
async function summary(slack: (() => WebClient) | null = null) {
  return (await alarm({ window, state: null, cloudflare: credentials, slack, testRun: false }))
    .summary;
}

/** The clock a query Cloudflare fails is asked again on: CI_HTTP's waits on a fake clock that moves
 *  on whenever nothing else is left to run, each at its longest (`Math.random` at 1). */
function cloudflareClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.setTimerTickMode("nextTimerAsync");
  onTestFinished(() => void vi.useRealTimers());
  vi.spyOn(Math, "random").mockReturnValue(1);
}

/** Cloudflare's HTML error page, longer than the 200 bytes a failure's message quotes. */
const errorPage = `<!DOCTYPE html>\n<html lang="en-US"><head><title>api.cloudflare.com | 502: Bad gateway</title></head><body>${'<div class="cf-error-details"></div>'.repeat(20)}</body></html>`;
function cloudflareErrorPage(status: number) {
  return new Response(errorPage, {
    status,
    headers: { "content-type": "text/html; charset=UTF-8" },
  });
}

/** A calculations answer of `aggregates`, each its group values and count. */
function calculations(aggregates: [string[], number][]) {
  return {
    success: true,
    result: {
      calculations: [
        {
          aggregates: aggregates.map(([values, count]) => ({
            groups: values.map((value) => ({ key: "", value })),
            groupKey: values.join(" ⬤ "),
            count,
          })),
        },
      ],
    },
  };
}

/** A Workers Logs API that answers each query with `answer(the field it groups by, its filters)`. */
function workersLogs(answer: (groupBy: string | undefined, filters: LogFilter[]) => unknown) {
  cloudflareClock();
  const fetch = vi.fn(async (_url: string, init: { body: string }) => {
    const query = JSON.parse(init.body) as LogQuery;
    return new Response(
      JSON.stringify(answer(query.parameters.groupBys?.[0]?.value, query.parameters.filters)),
    );
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch };
}

/** A prd whose only signal is `count` visitor 5xx at `url` (lispwoso.com, a project's own host,
 *  unless given), `unlogged` more without a URL: the 5xx total is the query without a group that
 *  reads the status. */
function serverErrorsOnly(count: number, { url = "https://lispwoso.com/", unlogged = 0 } = {}) {
  return (groupBy: string | undefined, filters: LogFilter[]) =>
    calculations(
      !groupBy
        ? [[[], JSON.stringify(filters).includes("response.status") ? count + unlogged : 0]]
        : groupBy === "$workers.event.request.url" && count
          ? [[[url], count]]
          : [],
    );
}

/** The alarm's posts to Slack, in order. */
function posts(slack: ReturnType<typeof fakeSlack>) {
  return slack.calls.filter((call) => call.method === "chat.postMessage");
}

/** #error-pulse as a reader sees it: each dashboard's lines, and the first line of each reply in
 *  its thread (the pages and the news about them). */
function errorPulse(slack: ReturnType<typeof fakeSlack>) {
  return slack.channel("#error-pulse").map((dashboard) => ({
    dashboard: dashboard.text.split("\n"),
    replies: dashboard.replies.map((reply) => reply.text.split("\n")[0]),
  }));
}

/** One run at `hhmm` on `day` after `state`, Workers Logs answering with `answer`, the fake Slack's
 *  clock at that time. */
async function runAt(
  hhmm: string,
  state: AlarmState | null,
  slack: ReturnType<typeof fakeSlack>,
  answer = serverErrorsOnly(0),
  day = "2026-09-23",
) {
  workersLogs(answer);
  slack.clock.now = Date.parse(`${day}T${hhmm}:00Z`);
  return await alarm({
    window: logWindow(new Date(`${day}T${hhmm}:00Z`), state),
    state,
    cloudflare: credentials,
    slack: () => slack.client,
    testRun: false,
  });
}

// The Workers Logs wire contract used here: filters select events before grouping, a row missing a
// grouped field drops out, and a query past 16 filter nodes is refused as Cloudflare refuses it.
type LogQuery = {
  view: string;
  parameters: { filters: LogFilter[]; groupBys?: { value: string }[] };
};
function queryableWorkersLogs(
  events: Record<string, unknown>[],
  intercept?: (query: LogQuery) => Response | void,
) {
  cloudflareClock();
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
    const groupBys = (query.parameters.groupBys || []).map((groupBy) => groupBy.value);
    const counts = new Map<string, [string[], number]>();
    for (const event of selected) {
      const values = groupBys.map((groupBy) => logField(event, groupBy));
      if (!values.every((value) => typeof value === "string")) continue;
      const key = JSON.stringify(values);
      counts.set(key, [values as string[], (counts.get(key)?.[1] ?? 0) + 1]);
    }
    return Response.json(calculations([...counts.values()].sort((a, b) => b[1] - a[1])));
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
    case "lt":
      return typeof value === "number" && value < Number(filter.value);
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

/** One invocation's summary as prd logs it: the visitor's own (a stateless invocation with no
 *  entrypoint) unless `hop` names the entrypoint of a Durable Object or ItxEntrypoint. */
function invocation(options: {
  hop?: string;
  eventType?: string;
  outcome?: string;
  status?: number;
  url?: string;
  rayId?: string;
  requestId?: string;
  version?: string;
  message?: string;
  objectId?: string;
}) {
  const {
    hop,
    eventType = "fetch",
    outcome = "ok",
    url = "https://garple.com/",
    version = "502616fb-0000",
  } = options;
  const durableObject = hop?.endsWith("DurableObject");
  return {
    timestamp: 42,
    $metadata: {
      type: "cf-worker-event",
      requestId: options.requestId || `${options.rayId || "no-ray"}-${hop || "visitor"}`,
      rayId: options.rayId,
      message: options.message || (eventType === "fetch" ? `GET ${url}` : `${hop}.${eventType}`),
    },
    $workers: {
      executionModel: durableObject ? "durableObject" : "stateless",
      entrypoint: hop,
      durableObjectId: options.objectId,
      eventType,
      outcome,
      scriptVersion: { id: version },
      event:
        eventType === "fetch"
          ? { request: { url }, ...(options.status && { response: { status: options.status } }) }
          : undefined,
    },
  };
}

/** A line an invocation logged at error: an exception or a console.error. */
function line(options: {
  hop?: string;
  message: string;
  rayId?: string;
  requestId?: string;
  version?: string;
  url?: string;
  objectId?: string;
}) {
  const durableObject = options.hop?.endsWith("DurableObject");
  return {
    timestamp: 42,
    $metadata: {
      type: "cf-worker",
      requestId: options.requestId || "line",
      rayId: options.rayId,
      message: options.message,
    },
    $workers: {
      executionModel: durableObject ? "durableObject" : "stateless",
      entrypoint: options.hop,
      durableObjectId: options.objectId,
      scriptVersion: { id: options.version || "502616fb-0000" },
      event: options.url ? { request: { url: options.url } } : undefined,
    },
  };
}

/** The warn the visitor's own invocation logs when the edge answers a platform failure 503 (core/os
 *  src/worker.ts `platformFailureAnswer`). */
function platformFailureAnswered(rayId: string, url: string) {
  return {
    timestamp: 42,
    event: "worker.platform-failure-answered",
    kind: "overloaded",
    name: "worker",
    $metadata: { type: "cf-worker", level: "warn", requestId: `${rayId}-visitor`, rayId },
    $workers: { executionModel: "stateless", event: { request: { url } } },
  };
}

/** A visitor's request that met a deploy's reset, as prd logged it on 2026-09-28 09:35Z: the
 *  context DO's summary and reset line, then the visitor's 500 and the reset rethrown there. */
function deployResetRay(rayId: string, url: string, version = "502616fb-0000") {
  const reset = "Durable Object reset because its code was updated.";
  return [
    invocation({ hop: "IterateContextDurableObject", outcome: "exception", url, rayId, version }),
    line({
      hop: "IterateContextDurableObject",
      message: reset,
      rayId,
      requestId: `${rayId}-do`,
      version,
      url,
    }),
    invocation({
      outcome: "exception",
      status: 500,
      url,
      rayId,
      requestId: `${rayId}-visitor`,
      version,
    }),
    line({ message: reset, rayId, requestId: `${rayId}-visitor`, version, url }),
  ];
}

/** A project's fetch of a third party through its globalOutbound, shaped as prd logs it: the
 *  SecretDurableObject's and the context DO's summaries, with no ray. */
function thirdPartyRequest(url: string, status: number) {
  return [
    invocation({ hop: "SecretDurableObject", status, url, requestId: "egress" }),
    invocation({ hop: "IterateContextDurableObject", status, url, requestId: "context" }),
  ];
}

function failedDocsRequest() {
  return [
    invocation({
      hop: "IterateContextDurableObject",
      status: 500,
      url: "https://docs.iterate.com/_iterate/auth/refresh",
      rayId: "docs",
    }),
    invocation({
      status: 500,
      url: "https://docs.iterate.com/_iterate/auth/refresh",
      rayId: "docs",
    }),
  ];
}

/** The context DO `objectId` announcing an outcome at info with its message (core/os
 *  iterate-context-durable-object.ts `#abort`), then the error line the runtime logs for it in the
 *  same invocation and that invocation's jsrpc summary, as a preview logged its `itx.abort()` on
 *  2026-09-29 09:56. */
function announcedReset(event: string, objectId: string, message: string) {
  const requestId = `${objectId}-asked`;
  return [
    {
      timestamp: 42,
      event,
      $metadata: { type: "cf-worker", level: "info", requestId, message },
      $workers: { entrypoint: "IterateContextDurableObject", durableObjectId: objectId },
    },
    ...rejectedInFlight(objectId, requestId, message),
  ];
}

/** Another call on the context DO `objectId`, failed with `message`: its error line and its jsrpc
 *  summary. */
function rejectedInFlight(objectId: string, requestId: string, message: string) {
  return [
    line({ hop: "IterateContextDurableObject", requestId, message, objectId }),
    invocation({
      hop: "IterateContextDurableObject",
      eventType: "jsrpc",
      outcome: "exception",
      requestId,
      objectId,
    }),
  ];
}

/** The context DO `objectId` deleting its `secret` facet, as core/os context/facet-host.ts
 *  `#deleteFacet` announces it: at info, with the summary of a call session the deletion cuts off. */
function deletedSecretFacet(objectId: string) {
  return {
    timestamp: 42,
    event: "facet.deleted",
    name: "secret",
    $metadata: {
      type: "cf-worker",
      level: "info",
      requestId: `${objectId}-delete`,
      message: "SecretDurableObject.jsrpc",
    },
    $workers: { entrypoint: "IterateContextDurableObject", durableObjectId: objectId },
  };
}

/** The secret facet's `endingLends` session in `objectId`, answered and then cut off by the
 *  deletion before its caller released it: an exception summary and no line. */
function cutOffSecretCall(objectId: string) {
  return invocation({
    hop: "SecretDurableObject",
    eventType: "jsrpc",
    outcome: "exception",
    requestId: `${objectId}-ending-lends`,
    objectId,
  });
}

/** A context's hibernatable WebSocket `close` event after its object was reset, as prd logged it
 *  on 2026-09-28 14:49: the runtime's opaque reason, and the event's exception summary. */
function closeReset(requestId: string) {
  const close = {
    eventType: "hibernatableWebSocket",
    event: { webSocketType: "close", code: 1006 },
  };
  const $workers = { entrypoint: "IterateContextDurableObject", ...close };
  return [
    {
      timestamp: 42,
      $metadata: {
        type: "cf-worker",
        requestId,
        message: "internal error; reference = 3pq1nd2d1ovl2vse8jv5vgfo",
      },
      $workers,
    },
    {
      timestamp: 42,
      $metadata: { type: "cf-worker-event", requestId, message: "close" },
      $workers: { ...$workers, outcome: "exception" },
    },
  ];
}

/** An rpc-stub pager that re-dialed after its socket closed (core/os context/rpc-stub-relay.ts). */
function pagerRedialed() {
  return {
    timestamp: 42,
    event: "rpc-stub-pager-redialed",
    $metadata: { type: "cf-worker", level: "info" },
  };
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
// is null, is none of them, or the row passes the keep (never, for a keep of null).
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
          ...(keep ? [{ kind: "group", filterCombination: "and", filters: keep } as const] : []),
        ],
      })),
    ),
  ];
}

/** A visitor whose connection went away mid-response, as prd logged it (2026-09-25 14:56:17Z): the
 *  runtime's "Network connection lost." and the invocation's exception summary, one requestId, in
 *  `rayId`. */
function vanishedVisitorRequest(rayId: string) {
  const url = "https://here-public.templestein.com/clock";
  return [
    line({ message: "Network connection lost.", rayId, requestId: `${rayId}-edge`, url }),
    invocation({ outcome: "exception", url, rayId, requestId: `${rayId}-edge` }),
  ];
}

/** One request to a killed tunnel's host, as a preview logged it (2026-09-24): the offline stub's
 *  info line in the context DO, then a summary from each hop — the project host's Worker (the
 *  visitor's), the DO's fetch, the config worker's ItxEntrypoint and the DO's fetch again — each
 *  with its own requestId and all in `rayId`. `change` alters the four summaries; `answer` is
 *  another expected answer's line and status (a deploy reset's 503). */
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
      $workers: {
        executionModel: "durableObject",
        entrypoint: "IterateContextDurableObject",
        event: { request: { url } },
      },
    },
    ...[
      undefined,
      "IterateContextDurableObject",
      "ItxEntrypoint",
      "IterateContextDurableObject",
    ].map((entrypoint, hop) => ({
      timestamp: 42,
      $metadata: {
        type: change.type || "cf-worker-event",
        requestId: `${rayId}-${hop}`,
        rayId: summaryRayId,
        message: change.message || `GET ${url}`,
      },
      $workers: {
        executionModel: entrypoint?.endsWith("DurableObject") ? "durableObject" : "stateless",
        entrypoint,
        eventType: "fetch",
        outcome: "ok",
        event: {
          request: { url },
          response: "status" in change ? { status: change.status } : { status: answer.status },
        },
      },
    })),
  ];
}

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
    pages: [],
    pins: { [heldAlarm!.event]: { lastSeen: lastSeen.toISOString(), told: false } },
  };
}
