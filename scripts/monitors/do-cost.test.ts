// The DO cost alarm's decisions and wording, over a fake Slack. The probe itself (a Cloudflare
// GraphQL call) is out of scope: readings are built by `reading` below.
import { expect, test, vi } from "vitest";
import { fakeSlack } from "../ci/fake-slack.ts";
import {
  ACCOUNTS,
  type AccountReading,
  decidePage,
  postDailyThread,
  renderDailyThread,
  upsertDetailsReply,
} from "./do-cost.ts";

const CI = "C0B3QJSU32A";
const PULSE = "C09K1CTN4M7";
const MENTIONS = "<@U067G4QRFK2> <@U099JH9TAF2>";
const now = new Date("2026-09-04T05:41:00Z");
const runUrl = "https://depot.dev/orgs/0p91s0lz49/workflows/w?job=j&attempt=a";
const links =
  "<https://github.com/iterate/iterate/blob/main/docs/depot-ci.md#health|how this alarm works> <https://depot.dev/orgs/0p91s0lz49/workflows/w?job=j&attempt=a|run> ($12.50/M GB-s, 1000 DO-hours ≈ $5.60)";

test("the headline states its basis and today so far; the reply is one short line per account", () => {
  const thread = renderDailyThread({
    now,
    runUrl,
    testRun: false,
    readings: [
      // No preview in use: nothing ran overnight, and the last activity was yesterday.
      reading("dev/preview", [{ hour: "2026-09-03T23:00:00Z", doHours: 1 }]),
      reading(
        "prd",
        [
          { hour: "2026-09-03T23:00:00Z", doHours: 1 },
          { hour: "2026-09-04T00:00:00Z", doHours: 1 },
          { hour: "2026-09-04T01:00:00Z", doHours: 1 },
          { hour: "2026-09-04T02:00:00Z", doHours: 3 },
          { hour: "2026-09-04T03:00:00Z", doHours: 1 },
          { hour: "2026-09-04T04:00:00Z", doHours: 4 },
          { hour: "2026-09-04T05:00:00Z", doHours: 1 },
        ],
        [],
        [
          { date: "2026-09-04", script: "os-prd", wallTimeP99Hours: 1.94, requests: 1200 },
          { date: "2026-09-03", script: "tunnels-prd", wallTimeP99Hours: 3, requests: 4 },
        ],
      ),
    ],
  });

  // At 05:41 prd's rate is 04:00's (4 DO-hours × 24 × $0.005625 = $0.54/day), above 05:00
  // projected (1 × 60/41 → 1). dev/preview has no row for either hour: idle. Today so far is prd's
  // 10 DO-hours. Of prd's five complete hours today, 02:00 and 04:00 were over its ceiling of 2.
  expect(thread).toMatchObject({
    headline:
      "We're spending $0.54/day on durable objects at 04:00's rate · today so far $0.06 ($0 dev/preview, $0.54 prd)",
    details: [
      "DO cost by account, 2026-09-04 UTC",
      "dev/preview: idle · today 0 ≈ $0 · 0 of 5 h over 500",
      "🔴 prd: 04:00 → 4 DO-hours (~$0.02/h) · today 11 ≈ $0.06 · 2 of 5 h over 2 · pinned: os-prd P99 1.94 h > 1 h",
      links,
    ].join("\n"),
  });
});

test("a probe that could not run is said so in the headline and the reply, never as $0", () => {
  const thread = renderDailyThread({
    now,
    runUrl: null,
    testRun: true,
    readings: [
      {
        label: "dev/preview",
        ceilingDoHours: 1,
        pageUsdPerHour: 0.05625,
        failure: "Cloudflare GraphQL errors: authentication error",
        summary: null,
      },
    ],
  });

  expect(thread).toMatchObject({
    headline:
      "🧪 TEST RUN — We're spending $0/day on durable objects at 04:00's rate · today so far $0 (dev/preview: probe failed)",
    details: [
      "DO cost by account, 2026-09-04 UTC",
      "⚠️ dev/preview: probe failed: Cloudflare GraphQL errors: authentication error",
      "<https://github.com/iterate/iterate/blob/main/docs/depot-ci.md#health|how this alarm works> ($12.50/M GB-s, 1000 DO-hours ≈ $5.60)",
    ].join("\n"),
    accounts: [],
  });
});

// Hourly DO-hours recorded on dev/preview on 2026-09-21 (ceiling 500 DO-hours ≈ $2.81/h, page
// tier $10/h ≈ 1,778 DO-hours/hour). Current usage is the higher of the last complete hour and
// this hour projected to 60 minutes. With no page open, only the page tier pages.
test.for([
  {
    name: "a quiet hour: no page",
    now: "2026-09-21T20:41:00Z",
    hours: [
      { hour: "2026-09-21T19:00:00Z", doHours: 40 },
      { hour: "2026-09-21T20:00:00Z", doHours: 20 },
    ],
    // 40 × $0.005625 × 24
    expected: { usdPerDay: "$5.40", basis: "19:00's rate", page: "none" },
  },
  {
    name: "over the ceiling (19:00, 719 so far at :41), under the page tier: no page",
    now: "2026-09-21T19:41:00Z",
    hours: [
      { hour: "2026-09-21T18:00:00Z", doHours: 90 },
      { hour: "2026-09-21T19:00:00Z", doHours: 719 },
    ],
    // 719 × 60/41 → 1,052 DO-hours/hour ≈ $5.92/h.
    expected: { usdPerDay: "$142", basis: "19:00's rate", page: "none" },
  },
  {
    name: "a complete hour over the page tier (20:00, 2,789) pages",
    now: "2026-09-21T21:41:00Z",
    hours: [
      { hour: "2026-09-21T20:00:00Z", doHours: 2789 },
      { hour: "2026-09-21T21:00:00Z", doHours: 1000 },
    ],
    // 2,789 ≈ $15.69/h beats 21:00 projected (1,000 × 60/41 → 1,463).
    expected: { usdPerDay: "$377", basis: "20:00's rate", page: "post" },
  },
  {
    name: "a runaway that started this hour pages from the projection, not an hour later",
    now: "2026-09-21T20:41:00Z",
    hours: [
      { hour: "2026-09-21T19:00:00Z", doHours: 400 },
      { hour: "2026-09-21T20:00:00Z", doHours: 1300 },
    ],
    // 1,300 × 60/41 → 1,902 DO-hours/hour ≈ $10.70/h.
    expected: { usdPerDay: "$257", basis: "20:00's rate", page: "post" },
  },
  {
    name: "a dispatch at :05 projects over at least 30 minutes, so a short burst does not page",
    now: "2026-09-21T20:05:00Z",
    hours: [
      { hour: "2026-09-21T19:00:00Z", doHours: 100 },
      { hour: "2026-09-21T20:00:00Z", doHours: 600 },
    ],
    // 600 × 60/30 = 1,200 ≈ $6.75/h; × 60/5 would have been 7,200 ≈ $40/h.
    expected: { usdPerDay: "$162", basis: "20:00's rate", page: "none" },
  },
])("tiers: $name", ({ now, hours, expected }) => {
  const thread = renderDailyThread({
    now: new Date(now),
    runUrl,
    testRun: false,
    readings: [reading("dev/preview", hours)],
  });
  expect({
    usdPerDay: thread.headline.match(/spending (\S+)\/day/)?.[1],
    basis: thread.headline.match(/at (.+ rate)/)?.[1],
    page: decidePage({ account: thread.accounts[0]!, open: undefined, runUrl }).kind,
  }).toEqual(expected);
});

// prd's thresholds against its measured hours (ceiling 2 DO-hours ≈ $0.01/h, page tier 10 ≈ $0.06/h):
// the account total ran p95 1.1 and at most 1.7 over 2026-08-25..09-26, and os-prd's previous
// platform ~48 an hour (2026-09-15..20).
test.for([
  { name: "an hour with one tunnel shard awake", doHours: 1, expected: { over: 0, page: "none" } },
  {
    name: "the busiest hour on record, 1.7 read as 2",
    doHours: 2,
    expected: { over: 0, page: "none" },
  },
  { name: "three DO-hours: a 🔴 hour, no page", doHours: 3, expected: { over: 1, page: "none" } },
  {
    name: "ten Durable Objects that never go idle page",
    doHours: 10,
    expected: { over: 1, page: "post" },
  },
  {
    name: "the previous platform's ordinary hour (48) pages",
    doHours: 48,
    expected: { over: 1, page: "post" },
  },
])("prd tiers: $name", ({ doHours, expected }) => {
  const thread = renderDailyThread({
    now: new Date("2026-09-24T20:41:00Z"),
    runUrl,
    testRun: false,
    readings: [reading("prd", [{ hour: "2026-09-24T19:00:00Z", doHours }])],
  });
  expect({
    over: thread.accounts[0]!.overToday,
    page: decidePage({ account: thread.accounts[0]!, open: undefined, runUrl }).kind,
  }).toEqual(expected);
});

const topNamespaces = [
  {
    namespace: "os-next-preview_pr2828-control-plane-cleanup_IterateContextDurableObject",
    doHours: 5520,
  },
  {
    namespace: "os-next-preview_pr2847-investigate-li-e10d90_IterateContextDurableObject",
    doHours: 2311,
  },
  { namespace: "os-preview-7_SandboxLiteDurableObject", doHours: 16 },
  { namespace: "os-preview-9_SandboxLiteDurableObject", doHours: 2 },
];

// 8,307 DO-hours/hour × $0.005625 = $46.73/h, 16.6× the ceiling, 4.7× the page tier.
test.for([
  {
    name: "none open: a page with the rate, the multiple, both mentions, the top spenders and the run",
    open: undefined,
    expected: {
      kind: "post",
      text: [
        `🚨 DO cost page for dev/preview: ~$47/h (≈ $1,121/day), 16.6× the ceiling ${MENTIONS}`,
        "Impact: peak 8,307 DO-hours/h (~$47/h); top spenders, trailing hour: os-next-preview_pr2828-control-plane-cleanup_IterateContextDurableObject ~$31/h, os-next-preview_pr2847-investigate-li-e10d90_IterateContextDurableObject ~$13/h, os-preview-7_SandboxLiteDurableObject ~$0.09/h",
        "Do: stop the top spender: find its preview or pinned facet",
        `<${runUrl}|run>`,
      ].join("\n"),
    },
  },
  {
    name: "open at a peak under 2× the tier: an edit and the 2× reply",
    open: openPage("2,124"),
    expected: {
      kind: "edit",
      ts: "100.0",
      text: expect.stringContaining("Impact: peak 8,307 DO-hours/h (~$47/h); top spenders"),
      escalation: `🚨 DO cost for dev/preview passed 2× its page tier: ~$47/h (≈ $1,121/day) ${MENTIONS}`,
    },
  },
  {
    name: "open with 2× already shown: an edit, no reply",
    open: openPage("6,531"),
    expected: {
      kind: "edit",
      text: expect.stringContaining("Impact: peak 8,307 DO-hours/h"),
      escalation: null,
    },
  },
  {
    name: "open with a higher peak shown: the edit keeps that peak",
    open: openPage("10,610"),
    expected: {
      kind: "edit",
      text: expect.stringMatching(
        /^🚨 DO cost page for dev\/preview: ~\$47\/h .*\nImpact: peak 10,610 DO-hours\/h \(~\$60\/h\)/,
      ),
      escalation: null,
    },
  },
])("page decision: $name", ({ open, expected }) => {
  const thread = renderDailyThread({
    now: new Date("2026-09-21T22:41:00Z"),
    runUrl,
    testRun: false,
    readings: [
      reading(
        "dev/preview",
        [
          { hour: "2026-09-21T21:00:00Z", doHours: 8307 },
          { hour: "2026-09-21T22:00:00Z", doHours: 5000 },
        ],
        topNamespaces,
      ),
    ],
  });
  expect(decidePage({ account: thread.accounts[0]!, open, runUrl })).toMatchObject(expected);
});

// Fixture: the hourly DO-hours readings in #error-pulse's DO cost posts of 2026-09-21/22, keyed by
// the hour each reading covers, replayed under the current thresholds. An hour with no reading is
// quiet (40 DO-hours on dev/preview, 1 on prd).
const INCIDENT = {
  "dev/preview": {
    quiet: 40,
    byRun: {
      "2026-09-21T19": 719,
      "2026-09-21T20": 2124,
      "2026-09-21T21": 6531,
      "2026-09-21T22": 8953,
      "2026-09-21T23": 10610,
      "2026-09-22T00": 9937,
      "2026-09-22T01": 9147,
      "2026-09-22T02": 8373,
      "2026-09-22T03": 8106,
      "2026-09-22T04": 5634,
      "2026-09-22T05": 1453,
      "2026-09-22T06": 8177,
      "2026-09-22T11": 569,
      "2026-09-22T12": 638,
      "2026-09-22T13": 799,
      "2026-09-22T15": 758,
      "2026-09-22T16": 655,
      "2026-09-22T17": 819,
      "2026-09-22T18": 683,
    } as Record<string, number>,
  },
  prd: {
    quiet: 1,
    byRun: {
      "2026-09-21T22": 640,
      "2026-09-21T23": 630,
      "2026-09-22T00": 909,
      "2026-09-22T01": 821,
      "2026-09-22T02": 768,
      "2026-09-22T03": 687,
      "2026-09-22T04": 613,
      "2026-09-22T14": 668,
      "2026-09-22T15": 609,
    } as Record<string, number>,
  },
};

test("the 09-21/22 incident: three pages, edited hourly, two escalations, each resolved once", async () => {
  const slack = fakeSlack({ now: 0 });
  const runs = Array.from(
    { length: 24 },
    (_, index) => new Date(Date.parse("2026-09-21T19:41:00Z") + index * 3600_000),
  );
  const actions: string[] = [];
  for (const at of runs) {
    slack.clock.now = at.getTime();
    const { pages } = await postDailyThread({
      slack: slack.client,
      now: at,
      readings: [incidentReading("dev/preview", at), incidentReading("prd", at)],
      runUrl,
      testRun: false,
    });
    for (const page of pages)
      if (page.action !== "none")
        actions.push(`${at.toISOString().slice(5, 16)} ${page.label} ${page.action}`);
  }

  // A page, an edit every run while it lasts, and the resolution after two complete quiet hours.
  expect(actions).toEqual([
    "09-21T20:41 dev/preview post",
    "09-21T21:41 dev/preview edit",
    "09-21T22:41 dev/preview edit",
    "09-21T22:41 prd post",
    "09-21T23:41 dev/preview edit",
    "09-21T23:41 prd edit",
    "09-22T00:41 dev/preview edit",
    "09-22T00:41 prd edit",
    "09-22T01:41 dev/preview edit",
    "09-22T01:41 prd edit",
    "09-22T02:41 dev/preview edit",
    "09-22T02:41 prd edit",
    "09-22T03:41 dev/preview edit",
    "09-22T03:41 prd edit",
    "09-22T04:41 dev/preview edit",
    "09-22T04:41 prd edit",
    "09-22T05:41 dev/preview edit",
    "09-22T05:41 prd edit",
    "09-22T06:41 dev/preview edit",
    "09-22T06:41 prd resolve",
    "09-22T07:41 dev/preview edit",
    "09-22T08:41 dev/preview resolve",
    "09-22T14:41 prd post",
    "09-22T15:41 prd edit",
    "09-22T16:41 prd edit",
    "09-22T17:41 prd resolve",
  ]);

  // #error-pulse: 3 pages and 2 escalations in the first one's thread, with both mentions, and
  // nothing else: each resolution edited its page, whose first line now starts "✅ resolved:" and
  // whose second says why.
  const pulse = slack.timeline("#error-pulse");
  expect(pulse.map((message) => message.text.split("\n").slice(0, 2))).toEqual([
    [
      `✅ resolved: DO cost page for dev/preview: ~$0.22/h (≈ $5.40/day), 0.1× the ceiling ${MENTIONS}`,
      "✅ back under 500 DO-hours/h since 06:00",
    ],
    [`🚨 DO cost for dev/preview passed 2× its page tier: ~$37/h (≈ $882/day) ${MENTIONS}`],
    [`🚨 DO cost for dev/preview passed 5× its page tier: ~$50/h (≈ $1,209/day) ${MENTIONS}`],
    [
      `✅ resolved: DO cost page for prd: ~$0.01/h (≈ $0.14/day), 0.5× the ceiling ${MENTIONS}`,
      "✅ back under 2 DO-hours/h since 04:00",
    ],
    [
      `✅ resolved: DO cost page for prd: ~$0.01/h (≈ $0.14/day), 0.5× the ceiling ${MENTIONS}`,
      "✅ back under 2 DO-hours/h since 15:00",
    ],
  ]);
  // Where each sits: a top-level page (null) or a reply in page N's thread, and sent to the channel
  // or not.
  expect(
    pulse.map((message) => ({
      thread: message.thread_ts ? pulse.findIndex((page) => page.ts === message.thread_ts) : null,
      broadcast: Boolean(message.reply_broadcast),
    })),
  ).toEqual([
    { thread: null, broadcast: false },
    { thread: 0, broadcast: false },
    { thread: 0, broadcast: false },
    { thread: null, broadcast: false },
    { thread: null, broadcast: false },
  ]);
  // Each page keeps the peak it showed.
  expect([pulse[0], pulse[3], pulse[4]].map((page) => page!.text.split("\n")[2])).toEqual([
    "Impact: peak 10,610 DO-hours/h (~$60/h)",
    "Impact: peak 909 DO-hours/h (~$5.11/h)",
    "Impact: peak 668 DO-hours/h (~$3.76/h)",
  ]);

  // #ci: each UTC day's headline and its one reply, rewritten in place, and nothing else.
  const ci = slack.timeline("#ci");
  expect(ci.map((message) => [!message.thread_ts, message.text.split("\n")[1]])).toEqual([
    [true, undefined],
    [
      false,
      "🔴 dev/preview: 22:00 → 10,610 DO-hours (~$60/h) · today 29,657 ≈ $167 · 5 of 23 h over 500",
    ],
    [true, undefined],
    [
      false,
      "🔴 dev/preview: 17:00 → 683 DO-hours (~$3.84/h) · today 46,011 ≈ $259 · 13 of 18 h over 500",
    ],
  ]);
});

test("a test run posts its thread and its page to #ci, 🧪 and with no mention, and reads no page", async () => {
  const at = new Date("2026-09-28T11:53:00Z");
  const slack = fakeSlack({ now: at.getTime() });
  const test = (label: "dev/preview" | "prd") => ({
    ...reading(label, [{ hour: "2026-09-28T10:00:00Z", doHours: 31 }]),
    ceilingDoHours: 1,
    pageUsdPerHour: 10 * 0.005625,
  });
  await postDailyThread({
    slack: slack.client,
    now: at,
    readings: [test("dev/preview"), test("prd")],
    runUrl,
    testRun: true,
  });
  expect(slack.timeline("#ci")).toMatchObject([
    { text: expect.stringMatching(/^🧪 TEST RUN — 🚨 DO cost page for dev\/preview: ~\$0.17\/h/) },
    { text: expect.stringMatching(/^🧪 TEST RUN — 🚨 DO cost page for prd:/) },
    { text: expect.stringMatching(/^🧪 TEST RUN — We're spending/) },
    { text: expect.stringContaining("DO cost by account") },
  ]);
  expect(slack.timeline("#error-pulse")).toEqual([]);
  expect(
    slack
      .timeline("#ci")
      .map((message) => message.text)
      .join("\n"),
  ).not.toContain("<@");
  expect(reads(slack)).not.toContain(PULSE);
});

test("an old 🧪 page in #error-pulse is no incident: the real run posts its own page", async () => {
  const at = new Date("2026-09-28T12:41:00Z");
  const slack = fakeSlack({ now: at.getTime() });
  slack.seed(
    "#error-pulse",
    "🧪 TEST RUN — 🚨 DO cost page for dev/preview: ~$0.35/h …",
    // posted at 10:46:07
    { ageHours: (at.getTime() - Date.parse("2026-09-28T10:46:07Z")) / 3600_000 },
  );
  const { pages } = await postDailyThread({
    slack: slack.client,
    now: at,
    readings: [reading("dev/preview", [{ hour: "2026-09-28T11:00:00Z", doHours: 2000 }])],
    runUrl,
    testRun: false,
  });
  expect(pages).toEqual([{ label: "dev/preview", action: "post" }]);
});

// A page is open for OPEN_PAGE_HOURS (48): past that, an incident is paged again, and the new page
// resolves the older one naming no one: by an edit, or, when Slack can no longer edit it, by a reply
// in its thread sent to the channel too, which closes it for every later run.
test.for([
  { name: "is resolved by an edit alone", updateError: undefined },
  { name: "that Slack can no longer edit is closed by a reply", updateError: "edit_window_closed" },
])(
  "an incident past 48 hours is paged again, and its older page $name",
  async ({ updateError }) => {
    const at = new Date("2026-09-28T12:41:00Z");
    const slack = fakeSlack({ now: at.getTime() });
    const older = slack.seed("#error-pulse", openPage("2,124").text, { ageHours: 49, updateError });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pages } = await postDailyThread({
      slack: slack.client,
      now: at,
      readings: [reading("dev/preview", [{ hour: "2026-09-28T11:00:00Z", doHours: 2000 }])],
      runUrl,
      testRun: false,
    });
    expect(pages).toEqual([{ label: "dev/preview", action: "post" }]);
    expect(writes(slack).filter((call) => call.channel === PULSE)).toEqual([
      {
        method: "chat.update",
        channel: PULSE,
        ts: older.ts,
        text: expect.stringMatching(/^✅ resolved: DO cost page for dev\/preview: ~\$12\/h/),
      },
      ...(updateError
        ? [
            {
              method: "chat.postMessage",
              channel: PULSE,
              thread_ts: older.ts,
              reply_broadcast: true,
              text: "✅ resolved: a newer page follows this incident",
            },
          ]
        : []),
      {
        method: "chat.postMessage",
        channel: PULSE,
        text: expect.stringMatching(/^🚨 DO cost page for dev\/preview: ~\$11\/h/),
      },
    ]);
  },
);

// do-cost runs hourly and keeps no state but #error-pulse, so a page Slack can no longer edit is
// read again every run: it must be resolved once, not once an hour. `hours` are dev/preview's
// DO-hours an hour, from three hours before the first run; each run reads the three before it.
test.for(
  ["edit_window_closed", "cant_update_message"].flatMap((updateError) => [
    {
      name: `${updateError}, the incident still there, then gone`,
      updateError,
      hours: [2000, 2000, 2000, 40, 40, 40, 40, 40],
      actions: ["edit", "edit", "resolve"],
    },
    {
      name: `${updateError}, the incident gone`,
      updateError,
      hours: [2000, 40, 40, 40, 40, 40, 40, 40],
      actions: ["resolve"],
    },
  ]),
)(
  "hourly runs resolve a page Slack cannot edit once ($name)",
  async ({ updateError, hours, actions }) => {
    const first = Date.parse("2026-09-28T12:41:00Z");
    const slack = fakeSlack({ now: first });
    slack.seed("#error-pulse", openPage("2,124").text, { ageHours: 2, updateError });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const taken: string[] = [];
    for (let run = 0; run < hours.length - 3; run++) {
      const at = new Date(first + run * 3600_000);
      slack.clock.now = at.getTime();
      const startOfHour = Date.parse(at.toISOString().slice(0, 13) + ":00:00Z");
      const { pages } = await postDailyThread({
        slack: slack.client,
        now: at,
        readings: [
          reading(
            "dev/preview",
            hours.slice(run, run + 3).map((doHours, index) => ({
              hour: new Date(startOfHour - (3 - index) * 3600_000)
                .toISOString()
                .replace(".000", ""),
              doHours,
            })),
          ),
        ],
        runUrl,
        testRun: false,
      });
      for (const page of pages) if (page.action !== "none") taken.push(page.action);
    }
    // a page that moved to a new message is resolved by an edit of it; one still frozen, by a reply
    const resolutions = slack
      .timeline("#error-pulse")
      .filter((message) => message.text.includes("back under"));
    expect({ actions: taken, resolutions: resolutions.length }).toEqual({
      actions,
      resolutions: 1,
    });
  },
);

test.for([
  { name: "the reply posted earlier is rewritten in place", replied: true },
  { name: "the day's first run posts the reply", replied: false },
])("details reply: $name", async ({ replied }) => {
  const slack = fakeSlack({ now: now.getTime() });
  const headline = slack.seed("#ci", "We're spending $142/day on durable objects …");
  const reply =
    replied && slack.seed("#ci", "DO cost by account, 2026-09-04 UTC\n…", { thread: headline });
  await upsertDetailsReply({
    slack: slack.client,
    channel: CI,
    headlineTs: headline.ts,
    details: "new lines",
  });
  expect(writes(slack)).toEqual([
    reply
      ? { method: "chat.update", channel: CI, ts: reply.ts, text: "new lines" }
      : { method: "chat.postMessage", channel: CI, thread_ts: headline.ts, text: "new lines" },
  ]);
});

test("the day's headline is found behind a busy #ci's first page, and rewritten, not posted again", async () => {
  const at = new Date("2026-09-21T21:41:00Z");
  const slack = fakeSlack({ now: at.getTime() });
  // Slack pages a day's history from its oldest end: 250 messages at 01:41–01:45 fill the first
  // page, and the headline is on the second.
  for (let index = 0; index < 250; index++)
    slack.seed("#ci", ":large_green_circle: PR opened: …", { ageHours: 20 - index / 3600 });
  const headline = slack.seed("#ci", "We're spending $1/day on durable objects …", {
    ageHours: 2,
  });
  await postDailyThread({
    slack: slack.client,
    now: new Date("2026-09-21T21:41:00Z"),
    readings: [reading("dev/preview", [{ hour: "2026-09-21T20:00:00Z", doHours: 20 }])],
    runUrl,
    testRun: false,
  });
  expect(writes(slack)).toMatchObject([
    { method: "chat.postMessage", channel: CI, thread_ts: headline.ts },
    {
      method: "chat.update",
      channel: CI,
      ts: headline.ts,
      text: expect.stringContaining("We're spending"),
    },
  ]);
});

test("a probe that could not run fails the run once the thread says so", async () => {
  const slack = fakeSlack({ now: now.getTime() });
  await expect(
    postDailyThread({
      slack: slack.client,
      now,
      readings: [
        {
          label: "prd",
          ceilingDoHours: 2,
          pageUsdPerHour: 0.05625,
          failure: "Cloudflare GraphQL errors: authentication error",
          summary: null,
        },
      ],
      runUrl,
      testRun: false,
    }),
  ).rejects.toThrow(
    "DO duration probe could not run: prd: Cloudflare GraphQL errors: authentication error",
  );
  expect(slack.timeline("#ci")).toMatchObject([
    { text: expect.stringContaining("prd: probe failed") },
    { text: expect.stringContaining("⚠️ prd: probe failed: Cloudflare GraphQL errors") },
  ]);
});

/** An account's reading as the hourly run builds it: the ceiling and page tier are the account's own
 * in `ACCOUNTS`, and the probe lists the hours over the ceiling. */
function reading(
  label: "dev/preview" | "prd",
  hours: Array<{ hour: string; doHours: number }>,
  topNamespaces: Array<{ namespace: string; doHours: number }> = [],
  pinned: Array<{ date: string; script: string; wallTimeP99Hours: number; requests: number }> = [],
): AccountReading {
  const account = ACCOUNTS.find((candidate) => candidate.label === label)!;
  return {
    label,
    ceilingDoHours: account.maxAccountDoHours,
    pageUsdPerHour: account.pageUsdPerHour,
    failure: null,
    summary: {
      activeTime: {
        ceilingDoHours: account.maxAccountDoHours,
        hours,
        breachedHours: hours.filter((row) => row.doHours > account.maxAccountDoHours),
        topNamespaces,
      },
      pinnedInvocations: { thresholdHours: 1, rows: pinned },
    },
  };
}

/** The probe's 26 complete hours before `at` from `INCIDENT`: the run at HH:41 reads hour HH-1 as
 * the reading posted at HH:42. */
function incidentReading(label: "dev/preview" | "prd", at: Date) {
  const { quiet, byRun } = INCIDENT[label];
  const hours = Array.from({ length: 26 }, (_, index) => {
    const hour = new Date(
      Date.parse(at.toISOString().slice(0, 13) + ":00:00Z") - (26 - index) * 3600_000,
    );
    const runHour = new Date(hour.getTime() + 3600_000).toISOString().slice(0, 13);
    return { hour: hour.toISOString().replace(".000", ""), doHours: byRun[runHour] || quiet };
  });
  return reading(label, hours);
}

/** The Slack writes a run made: every call but the reads. */
function writes(slack: ReturnType<typeof fakeSlack>) {
  return slack.calls.filter((call) => call.method.startsWith("chat."));
}

/** The channels a run read. */
function reads(slack: ReturnType<typeof fakeSlack>) {
  return slack.calls
    .filter((call) => call.method.startsWith("conversations."))
    .map((call) => call.channel);
}

/** dev/preview's page as Slack's history returns it, showing `peak` DO-hours an hour. */
function openPage(peak: string) {
  return {
    ts: "100.0",
    text: `:rotating_light: DO cost page for dev/preview: ~$12/h (≈ $287/day), 4.2× the ceiling ${MENTIONS}\nImpact: peak ${peak} DO-hours/h (~$12/h)\nDo: stop the top spender: find its preview or pinned facet\n<${runUrl}|run>`,
  };
}
