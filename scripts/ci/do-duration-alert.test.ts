import type { WebClient } from "@slack/web-api";
import { expect, test } from "vitest";
import {
  ACCOUNTS,
  type AccountReading,
  postDailyThread,
  postPageUnlessRecent,
  renderDailyThread,
  upsertDetailsReply,
} from "./do-duration-alert.ts";

const now = new Date("2026-09-04T05:41:00Z");
const runUrl = "https://github.com/iterate/iterate/actions/runs/1";
const links =
  "<https://github.com/iterate/iterate/tree/6a9a48e2a/apps/os/tasks/do-duration-leak|incident docs> <https://github.com/iterate/iterate/actions/runs/1|workflow run> ($12.50/M GB-s, 1000 DO-hours ≈ $5.60)";

test("the headline is one sentence about $/day; the table and the breach are replies", () => {
  const thread = renderDailyThread({
    now,
    runUrl,
    testRun: false,
    readings: [
      {
        label: "dev/preview",
        ceilingDoHours: 500,
        pageUsdPerHour: 10,
        failure: null,
        summary: {
          // No preview in use: nothing ran overnight, and the last activity was yesterday.
          activeTime: {
            ceilingDoHours: 500,
            hours: [{ hour: "2026-09-03T23:00:00Z", doHours: 1 }],
            breachedHours: [],
            topNamespaces: [],
          },
          pinnedInvocations: { thresholdHours: 1, rows: [] },
        },
      },
      {
        label: "prd",
        ceilingDoHours: 600,
        pageUsdPerHour: 12,
        failure: null,
        summary: {
          activeTime: {
            ceilingDoHours: 600,
            hours: [
              { hour: "2026-09-03T23:00:00Z", doHours: 542 },
              { hour: "2026-09-04T00:00:00Z", doHours: 539 },
              { hour: "2026-09-04T01:00:00Z", doHours: 536 },
              { hour: "2026-09-04T02:00:00Z", doHours: 537 },
              { hour: "2026-09-04T03:00:00Z", doHours: 542 },
              { hour: "2026-09-04T04:00:00Z", doHours: 812 },
              { hour: "2026-09-04T05:00:00Z", doHours: 401 },
            ],
            breachedHours: [{ hour: "2026-09-04T04:00:00Z", doHours: 812 }],
            topNamespaces: [],
          },
          pinnedInvocations: {
            thresholdHours: 1,
            rows: [
              { date: "2026-09-04", script: "os-prd", wallTimeP99Hours: 1.94, requests: 1200 },
            ],
          },
        },
      },
    ],
  });

  // Current usage is the last complete hour (04:00 at 05:41): 812 DO-hours × 24 × $0.005625,
  // above 05:00 projected to a full hour (401 × 60/41 = 587). dev/preview had no row for
  // either hour, so it is $0. $4.57/h is under this reading's $12/h page tier.
  expect(thread).toMatchObject({
    headline:
      "We're spending $110/day on durable objects based on current usage ($0 dev/preview, $110 prd)",
    details: [
      "```",
      "account      latest hour             today (DO-hours)  hours over ceiling  pinned invocations",
      "dev/preview  23:00 → 1 (~$0.01/h)    0 ≈ $0.00         0/0 over 500        —",
      "prd          05:00 → 401 (~$2.26/h)  3,367 ≈ $19       1/6 over 600        os-prd P99=1.94h",
      "```",
      links,
    ].join("\n"),
    replies: [
      [
        "🚨 Durable Objects hours over 600. account: prd. Now 1.4× the ceiling (~$4.57/h).",
        "Latest: 04:00 → 812 (~$4.57/h)",
        "Also pinned: os-prd  wallTimeP99=1.94h",
        links,
      ].join("\n"),
    ],
    pages: [],
  });
});

test("an hour over the ceiling earlier today is in the table without a fresh reply", () => {
  const thread = renderDailyThread({
    now,
    runUrl,
    testRun: false,
    readings: [
      {
        label: "dev/preview",
        ceilingDoHours: 500,
        pageUsdPerHour: 10,
        failure: null,
        summary: {
          activeTime: {
            ceilingDoHours: 500,
            hours: [
              { hour: "2026-09-04T01:00:00Z", doHours: 2225 },
              { hour: "2026-09-04T02:00:00Z", doHours: 40 },
              { hour: "2026-09-04T04:00:00Z", doHours: 3 },
            ],
            breachedHours: [{ hour: "2026-09-04T01:00:00Z", doHours: 2225 }],
            topNamespaces: [],
          },
          pinnedInvocations: { thresholdHours: 1, rows: [] },
        },
      },
    ],
  });

  expect(thread).toMatchObject({
    replies: [],
    headline:
      "We're spending $0.40/day on durable objects based on current usage ($0.40 dev/preview)",
  });
  expect(thread.details).toContain(
    "dev/preview  04:00 → 3 (~$0.02/h)  2,268 ≈ $13       1/3 over 500        —",
  );
});

test("a probe that could not run is said so in the sentence and as a reply, never as $0", () => {
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
      "🧪 TEST RUN — We're spending $0/day on durable objects based on current usage (dev/preview: probe failed)",
    pages: [],
  });
  expect(thread.details).toContain(
    "dev/preview  probe failed: Cloudflare GraphQL errors: authentication error",
  );
  expect(thread.replies).toHaveLength(1);
  expect(thread.replies[0]).toContain("⚠️ DO duration probe FAILED to run. account: dev/preview.");
});

// The 2026-09-21 os-next preview pin runaway, hour by hour (dev/preview: ceiling 500 DO-hours
// ≈ $2.81/h, page tier $10/h ≈ 1,778 DO-hours/hour). Current usage is the higher of the last
// complete hour and this hour projected to 60 minutes.
test.for([
  {
    name: "a quiet hour: no reply, no page",
    now: "2026-09-21T20:41:00Z",
    hours: [
      { hour: "2026-09-21T19:00:00Z", doHours: 40 },
      { hour: "2026-09-21T20:00:00Z", doHours: 20 },
    ],
    // 40 × $0.005625 × 24
    expected: { usdPerDay: "$5.40", severity: [], pagedAccounts: [] },
  },
  {
    name: "the first breach (19:00, 719 so far at :41): a reply that says how bad, no page",
    now: "2026-09-21T19:41:00Z",
    hours: [
      { hour: "2026-09-21T18:00:00Z", doHours: 90 },
      { hour: "2026-09-21T19:00:00Z", doHours: 719 },
    ],
    // 719 × 60/41 = 1,052 DO-hours/hour ≈ $5.92/h: over the ceiling, under the page tier.
    expected: {
      usdPerDay: "$142",
      severity: [
        "🚨 Durable Objects hours over 500. account: dev/preview. Now 2.1× the ceiling (~$5.92/h).",
      ],
      pagedAccounts: [],
    },
  },
  {
    name: "a complete hour over the page tier (20:00, 2,789) pages",
    now: "2026-09-21T21:41:00Z",
    hours: [
      { hour: "2026-09-21T20:00:00Z", doHours: 2789 },
      { hour: "2026-09-21T21:00:00Z", doHours: 1000 },
    ],
    // 2,789 ≈ $15.69/h beats 21:00 projected (1,000 × 60/41 = 1,463).
    expected: {
      usdPerDay: "$377",
      severity: [
        "🚨 Durable Objects hours over 500. account: dev/preview. Now 5.6× the ceiling (~$16/h).",
      ],
      pagedAccounts: ["dev/preview"],
    },
  },
  {
    name: "a runaway that started this hour pages from the projection, not an hour later",
    now: "2026-09-21T20:41:00Z",
    hours: [
      { hour: "2026-09-21T19:00:00Z", doHours: 400 },
      { hour: "2026-09-21T20:00:00Z", doHours: 1300 },
    ],
    // 1,300 × 60/41 = 1,902 DO-hours/hour ≈ $10.70/h.
    expected: {
      usdPerDay: "$257",
      severity: [
        "🚨 Durable Objects hours over 500. account: dev/preview. Now 3.8× the ceiling (~$11/h).",
      ],
      pagedAccounts: ["dev/preview"],
    },
  },
  {
    name: "a dispatch at :05 projects over at least 30 minutes, so a short burst does not page",
    now: "2026-09-21T20:05:00Z",
    hours: [
      { hour: "2026-09-21T19:00:00Z", doHours: 100 },
      { hour: "2026-09-21T20:00:00Z", doHours: 600 },
    ],
    // 600 × 60/30 = 1,200 ≈ $6.75/h; × 60/5 would have been 7,200 ≈ $40/h.
    expected: {
      usdPerDay: "$162",
      severity: [
        "🚨 Durable Objects hours over 500. account: dev/preview. Now 2.4× the ceiling (~$6.75/h).",
      ],
      pagedAccounts: [],
    },
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
    severity: thread.replies.map((reply) => reply.split("\n")[0]),
    pagedAccounts: thread.pages.map((page) => page.label),
  }).toEqual(expected);
});

// prd's thresholds against its measured hours (ceiling 2 DO-hours ≈ $0.01/h, page tier 10 ≈ $0.06/h):
// the account total ran p95 1.1 and at most 1.7 over 2026-08-25..09-26, and os-prd's previous
// platform ~48 an hour (2026-09-15..20).
test.for([
  {
    name: "an hour with one tunnel shard awake: no reply, no page",
    hours: [
      { hour: "2026-09-24T19:00:00Z", doHours: 1 },
      { hour: "2026-09-24T20:00:00Z", doHours: 1 },
    ],
    expected: { severity: [], pagedAccounts: [] },
  },
  {
    name: "the busiest hour on record, 1.7 read as 2: no reply, no page",
    hours: [{ hour: "2026-09-24T19:00:00Z", doHours: 2 }],
    expected: { severity: [], pagedAccounts: [] },
  },
  {
    name: "three DO-hours: a reply that says how bad, no page",
    hours: [{ hour: "2026-09-24T19:00:00Z", doHours: 3 }],
    expected: {
      severity: ["🚨 Durable Objects hours over 2. account: prd. Now 1.5× the ceiling (~$0.02/h)."],
      pagedAccounts: [],
    },
  },
  {
    name: "ten Durable Objects that never go idle page",
    hours: [{ hour: "2026-09-24T19:00:00Z", doHours: 10 }],
    expected: {
      severity: ["🚨 Durable Objects hours over 2. account: prd. Now 5.0× the ceiling (~$0.06/h)."],
      pagedAccounts: ["prd"],
    },
  },
  {
    name: "the previous platform's ordinary hour (48) pages",
    hours: [{ hour: "2026-09-24T19:00:00Z", doHours: 48 }],
    expected: {
      severity: [
        "🚨 Durable Objects hours over 2. account: prd. Now 24.0× the ceiling (~$0.27/h).",
      ],
      pagedAccounts: ["prd"],
    },
  },
])("prd tiers: $name", ({ hours, expected }) => {
  const thread = renderDailyThread({
    now: new Date("2026-09-24T20:41:00Z"),
    runUrl,
    testRun: false,
    readings: [reading("prd", hours)],
  });
  expect({
    severity: thread.replies.map((reply) => reply.split("\n")[0]),
    pagedAccounts: thread.pages.map((page) => page.label),
  }).toEqual(expected);
});

test("a page names the rate, the multiple, Jonas and the top spenders; a test run mentions nobody", () => {
  const hours = [
    { hour: "2026-09-21T21:00:00Z", doHours: 8307 },
    { hour: "2026-09-21T22:00:00Z", doHours: 5000 },
  ];
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
  ];
  const input = {
    now: new Date("2026-09-21T22:41:00Z"),
    runUrl,
    readings: [reading("dev/preview", hours, topNamespaces)],
  };

  // 8,307 DO-hours/hour × $0.005625 = $46.73/h; 5,520 → $31.05/h; 2,311 → $13.00/h; 16 → $0.09/h.
  expect(renderDailyThread({ ...input, testRun: false })).toMatchObject({
    pages: [
      {
        label: "dev/preview",
        text: [
          "🚨 DO cost page for dev/preview: ~$47/h (≈ $1,121/day), 16.6× the ceiling. <@U067G4QRFK2>",
          "Top spenders, trailing hour:",
          "• os-next-preview_pr2828-control-plane-cleanup_IterateContextDurableObject  ~$31/h",
          "• os-next-preview_pr2847-investigate-li-e10d90_IterateContextDurableObject  ~$13/h",
          "• os-preview-7_SandboxLiteDurableObject  ~$0.09/h",
          `Pages again in 3h while it lasts; hourly readings are in today's "We're spending" thread.`,
          links,
        ].join("\n"),
      },
    ],
  });
  expect(renderDailyThread({ ...input, testRun: true }).pages[0]?.text.split("\n")[0]).toBe(
    "🧪 TEST RUN — 🚨 DO cost page for dev/preview: ~$47/h (≈ $1,121/day), 16.6× the ceiling.",
  );
});

test.for([
  {
    name: "the table posted earlier is rewritten in place, padded header and all",
    thread: [
      { ts: "100.0", bot_id: "B1", text: "We're spending $142/day on durable objects …" },
      { ts: "101.0", bot_id: "B1", text: "TABLE" },
      { ts: "102.0", bot_id: "B1", text: ":rotating_light: Durable Objects hours over 500. …" },
    ],
    expected: [["chat.update", { channel: "C1", ts: "101.0", text: "new table" }]],
  },
  {
    name: "the day's first run posts the table as a reply",
    thread: [{ ts: "100.0", bot_id: "B1", text: "We're spending $142/day on durable objects …" }],
    expected: [["chat.postMessage", { channel: "C1", thread_ts: "100.0", text: "new table" }]],
  },
])("details reply: $name", async ({ thread, expected }) => {
  // TABLE stands for a real rendered table, whose header is padded into columns.
  const table = renderDailyThread({
    now,
    runUrl,
    testRun: false,
    readings: [reading("dev/preview", [{ hour: "2026-09-04T04:00:00Z", doHours: 3 }])],
  }).details;
  const slack = fakeSlack(
    thread.map((message) => ({ ...message, text: message.text.replace("TABLE", table) })),
  );
  await upsertDetailsReply({
    slack: slack.client,
    channel: "C1",
    headlineTs: "100.0",
    details: "new table",
  });
  // oxlint-disable-next-line iterate/prefer-object-property-match -- exact: an extra Slack write or field must fail
  expect(slack.writes).toEqual(expected);
});

// Slack history renders emoji as :shortcodes:, so pages are recognised by their words.
test.for([
  { name: "no page yet: pages", history: [], posted: true },
  {
    name: "paged two runs ago: stays quiet",
    history: [
      { at: "2026-09-21T21:41:05Z", text: ":rotating_light: DO cost page for dev/preview: …" },
    ],
    posted: false,
  },
  {
    name: "paged three runs ago: pages again",
    history: [
      { at: "2026-09-21T20:41:05Z", text: ":rotating_light: DO cost page for dev/preview: …" },
    ],
    posted: true,
  },
  {
    name: "only prd was paged: pages dev/preview",
    history: [{ at: "2026-09-21T22:41:05Z", text: ":rotating_light: DO cost page for prd: …" }],
    posted: true,
  },
  {
    name: "only a test run paged: the real page still goes out",
    history: [
      {
        at: "2026-09-21T22:41:05Z",
        text: ":test_tube: TEST RUN — :rotating_light: DO cost page for dev/preview: …",
      },
    ],
    posted: true,
  },
])("page repeat: $name", async ({ history, posted }) => {
  const slack = fakeSlack(
    history.map((message) => ({
      ts: String(Date.parse(message.at) / 1000),
      bot_id: "B1",
      text: message.text,
    })),
  );
  const page = { label: "dev/preview", text: "🚨 DO cost page for dev/preview: ~$47/h …" };
  await expect(
    postPageUnlessRecent({
      slack: slack.client,
      channel: "C1",
      now: new Date("2026-09-21T23:41:00Z"),
      page,
      testRun: false,
    }),
  ).resolves.toBe(posted);
  // A page is top-level: no thread_ts.
  // oxlint-disable-next-line iterate/prefer-object-property-match -- exact: a thread_ts on the page must fail
  expect(slack.writes).toEqual(
    posted ? [["chat.postMessage", { channel: "C1", text: page.text }]] : [],
  );
});

// A breach ends the run green once it is paged; only a probe that could not measure fails it.
test.for([
  {
    name: "a quiet hour",
    hours: [{ hour: "2026-09-21T20:00:00Z", doHours: 20 }],
    expected: { breached: false, pagesPosted: 0 },
  },
  {
    name: "an hour over the page tier, paged",
    hours: [{ hour: "2026-09-21T20:00:00Z", doHours: 2789 }],
    expected: { breached: true, pagesPosted: 1 },
  },
])("the run resolves: $name", async ({ hours, expected }) => {
  const slack = fakeSlack([]);
  await expect(
    postDailyThread({
      slack: slack.client,
      channel: "C1",
      now: new Date("2026-09-21T21:41:00Z"),
      readings: [reading("dev/preview", hours)],
      runUrl,
      testRun: false,
    }),
  ).resolves.toEqual(expected);
});

test("a probe that could not run fails the run once its reply is posted", async () => {
  const slack = fakeSlack([]);
  await expect(
    postDailyThread({
      slack: slack.client,
      channel: "C1",
      now,
      readings: [
        {
          label: "prd",
          ceilingDoHours: 600,
          pageUsdPerHour: 12,
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
  expect(slack.writes).toContainEqual([
    "chat.postMessage",
    expect.objectContaining({
      thread_ts: "999.0",
      text: expect.stringContaining("⚠️ DO duration probe FAILED to run. account: prd."),
    }),
  ]);
});

/** An account's reading as the hourly run builds it: the ceiling and page tier are the account's own
 * in `ACCOUNTS`, and the probe lists the hours over the ceiling. */
function reading(
  label: "dev/preview" | "prd",
  hours: Array<{ hour: string; doHours: number }>,
  topNamespaces: Array<{ namespace: string; doHours: number }> = [],
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
      pinnedInvocations: { thresholdHours: 1, rows: [] },
    },
  };
}

/** A WebClient stand-in: serves `messages` as the channel history (honouring `oldest`, as Slack
 * does) and as the thread's replies, and records every write. */
function fakeSlack(messages: Array<{ ts: string; bot_id: string; text: string }>) {
  const writes: Array<[string, unknown]> = [];
  const client = {
    conversations: {
      history: async (args: { oldest: string }) => ({
        messages: messages.filter((message) => Number(message.ts) >= Number(args.oldest)),
      }),
      replies: async () => ({ messages }),
    },
    chat: {
      postMessage: async (args: unknown) => {
        writes.push(["chat.postMessage", args]);
        return { ok: true, ts: "999.0" };
      },
      update: async (args: unknown) => {
        writes.push(["chat.update", args]);
        return { ok: true };
      },
    },
  } as unknown as WebClient;
  return { client, writes };
}
