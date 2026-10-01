// The page primitives over a fake Slack. The token lookup and the WebClient itself are out of scope.
import { expect, test, vi } from "vitest";
import { DASHBOARD_EVENT, PAGE_CLOSED_EVENT } from "./dashboard.ts";
import { fakeSlack } from "./fake-slack.ts";
import {
  cutText,
  escalationText,
  findOpenPages,
  keepPage,
  markResolved,
  pageChannel,
  pageStep,
  PAGE_GONE_ERRORS,
  pageText,
  resolvedText,
  resolvePage,
  slackChannelIds,
} from "./slack.ts";

const MENTIONS = "<@U067G4QRFK2> <@U099JH9TAF2>";

test.for([
  {
    name: "a page is four lines: what with both mentions, impact, what to do, one link",
    testRun: false,
    link: "https://depot.dev/run",
    expected: `🚨 prd deploy failed ${MENTIONS}\nImpact: prd serves the previous OS\nDo: open the run\n<https://depot.dev/run|run>`,
  },
  {
    name: "a test run's is marked 🧪 and mentions nobody",
    testRun: true,
    link: "https://depot.dev/run",
    expected: `🧪 TEST RUN — 🚨 prd deploy failed\nImpact: prd serves the previous OS\nDo: open the run\n<https://depot.dev/run|run>`,
  },
  {
    name: "the ids an action needs go between what to do and the link",
    testRun: false,
    link: "https://depot.dev/run",
    details: ["• os-pr3159-repos", "• os-pr3271-repos"],
    expected: `🚨 prd deploy failed ${MENTIONS}\nImpact: prd serves the previous OS\nDo: open the run\n• os-pr3159-repos\n• os-pr3271-repos\n<https://depot.dev/run|run>`,
  },
  {
    name: "a run with no link has no link line",
    testRun: false,
    link: null,
    expected: `🚨 prd deploy failed ${MENTIONS}\nImpact: prd serves the previous OS\nDo: open the run`,
  },
])("pageText: $name", ({ testRun, link, details, expected }) => {
  expect(
    pageText({
      what: "prd deploy failed",
      impact: "prd serves the previous OS",
      action: "open the run",
      details,
      link,
      testRun,
    }),
  ).toBe(expected);
});

test.for([
  { name: "as posted", text: `🚨 DO cost page for prd: ~$1/h ${MENTIONS}\nImpact: …` },
  {
    name: "as Slack's history spells it",
    text: `:rotating_light: DO cost page for prd: ~$1/h ${MENTIONS}\nImpact: …`,
  },
])("markResolved keeps the first line's words and mentions: $name", ({ text }) => {
  expect(markResolved(text)).toBe(
    `✅ resolved: DO cost page for prd: ~$1/h ${MENTIONS}\nImpact: …`,
  );
});

test.for([
  {
    name: "a resolution mentions nobody: good news is not a page",
    text: resolvedText("main e2e green again", false),
    expected: "✅ resolved: main e2e green again",
  },
  {
    name: "a test run's resolution is marked and mentions nobody",
    text: resolvedText("main e2e green again", true),
    expected: "🧪 TEST RUN — ✅ resolved: main e2e green again",
  },
  {
    name: "an escalation mentions both",
    text: escalationText("main e2e has new failures", false),
    expected: `🚨 main e2e has new failures ${MENTIONS}`,
  },
  {
    name: "a test run's escalation is marked and mentions nobody",
    text: escalationText("main e2e has new failures", true),
    expected: "🧪 TEST RUN — 🚨 main e2e has new failures",
  },
])("thread replies: $name", ({ text, expected }) => {
  expect(text).toBe(expected);
});

test("a title is cut on whole characters", () => {
  expect(cutText("short", 80)).toBe("short");
  expect(cutText("a".repeat(81), 80)).toBe(`${"a".repeat(80)}…`);
  // a flag is two code points, a family seven: neither is split
  expect(cutText("ab🇬🇧👨‍👩‍👧‍👦cd", 3)).toBe("ab🇬🇧…");
});

test("a test run's page goes to #ci, a real one to #error-pulse", () => {
  expect({ test: pageChannel(true), real: pageChannel(false) }).toEqual({
    test: slackChannelIds["#ci"],
    real: slackChannelIds["#error-pulse"],
  });
});

const now = Date.parse("2026-09-22T12:00:00Z");
const errorPulse = slackChannelIds["#error-pulse"];

test.for([
  {
    name: "every open page, newest first",
    history: [
      { ageSeconds: 120, text: ":rotating_light: DO cost page for prd: old" },
      { ageSeconds: 60, text: ":rotating_light: DO cost page for prd: new" },
    ],
    open: [
      ":rotating_light: DO cost page for prd: new",
      ":rotating_light: DO cost page for prd: old",
    ],
  },
  {
    name: "a resolved page, another bot's and a 🧪 page are skipped",
    history: [
      { ageSeconds: 40, text: ":rotating_light: DO cost page for prd: d" },
      { ageSeconds: 30, text: ":test_tube: TEST RUN — :rotating_light: DO cost page for prd: c" },
      { ageSeconds: 20, text: ":rotating_light: DO cost page for prd: b", botId: "B2" },
      { ageSeconds: 10, text: ":white_check_mark: resolved: DO cost page for prd: a" },
    ],
    open: [":rotating_light: DO cost page for prd: d"],
  },
  {
    name: "a later line that says resolved: does not close a page",
    history: [
      { ageSeconds: 10, text: ":rotating_light: DO cost page for prd: a\nImpact: resolved: x" },
    ],
    open: [":rotating_light: DO cost page for prd: a\nImpact: resolved: x"],
  },
  {
    name: "a page behind 250 newer messages is found on the next history page",
    history: [
      { ageSeconds: 3600, text: ":rotating_light: DO cost page for prd: e" },
      ...Array.from({ length: 250 }, (_, index) => ({
        ageSeconds: 100 - index * 0.1,
        text: "PR opened",
      })),
    ],
    open: [":rotating_light: DO cost page for prd: e"],
  },
  {
    name: "newest first across history pages",
    history: [
      { ageSeconds: 3600, text: ":rotating_light: DO cost page for prd: old" },
      ...Array.from({ length: 250 }, (_, index) => ({
        ageSeconds: 100 - index * 0.1,
        text: "PR opened",
      })),
      { ageSeconds: 5, text: ":rotating_light: DO cost page for prd: new" },
    ],
    open: [
      ":rotating_light: DO cost page for prd: new",
      ":rotating_light: DO cost page for prd: old",
    ],
  },
  {
    name: "a page older than the window is not open",
    history: [{ ageSeconds: 49 * 3600, text: ":rotating_light: DO cost page for prd: f" }],
    open: [],
  },
])("findOpenPages: $name", async ({ history, open }) => {
  const slack = fakeSlack({ now });
  const seeded = history.map(
    ({ ageSeconds, text, botId }: { ageSeconds: number; text: string; botId?: string }) =>
      slack.seed("#error-pulse", text, { ageHours: ageSeconds / 3600, botId }),
  );
  await expect(
    findOpenPages(slack.client, {
      channel: errorPulse,
      marker: "DO cost page for prd:",
      sinceHours: 48,
      now: new Date(now),
    }),
  ).resolves.toEqual(
    open.map((text) => ({ ts: seeded.find((message) => message.text === text)!.ts, text })),
  );
});

test.for([
  {
    name: "the page is edited to say it is resolved and why, and nothing is posted",
    updateError: undefined,
  },
  { name: "a failed edit throws, so the next run resolves it", updateError: "fatal_error" },
])("resolvePage: $name", async ({ updateError }) => {
  const slack = fakeSlack({ now });
  const page = slack.seed("#error-pulse", `:rotating_light: page ${MENTIONS}\nImpact: …`, {
    updateError,
  });
  await expect(
    resolvePage(slack.client, {
      channel: errorPulse,
      ts: page.ts,
      text: page.text,
      why: "back under 2",
      now: new Date(now),
    }).then(
      () => "resolved",
      (error: Error) => error.message,
    ),
  ).resolves.toBe(updateError ? "An API error occurred: fatal_error" : "resolved");
  expect(writes(slack)).toEqual([
    {
      method: "chat.update",
      channel: errorPulse,
      ts: page.ts,
      text: `✅ resolved: page ${MENTIONS}\n✅ back under 2\nImpact: …`,
    },
  ]);
});

// A page Slack can no longer edit (PAGE_GONE_ERRORS): deleted, or past the workspace's edit window
// and still in the channel ("frozen"). A frozen page is closed by a reply in its thread sent to the
// channel too, which findOpenPages reads; a deleted one is not in the history at all.
const FROZEN_ERRORS = [...PAGE_GONE_ERRORS].filter((error) => error !== "message_not_found");
const goneRows = [...PAGE_GONE_ERRORS].map((error) => ({
  error,
  frozen: error !== "message_not_found",
}));

test.for(goneRows)(
  "resolvePage: a page Slack answers $error to is closed by a reply in today's dashboard thread naming no one when it is still there, and left alone when deleted",
  async ({ error, frozen }) => {
    const slack = fakeSlack({ now });
    const page = slack.seed("#error-pulse", `:rotating_light: page ${MENTIONS}`, {
      updateError: error,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await resolvePage(slack.client, {
      channel: errorPulse,
      ts: page.ts,
      text: page.text,
      why: "back under 2",
      now: new Date(now),
    });
    expect(shape(slack)).toEqual(
      frozen
        ? [
            `:rotating_light: page ${MENTIONS}`,
            "📟 error-pulse · Tue 22 Sep · 12:00 UTC",
            `  ↳ ✅ resolved: back under 2 (closes ${page.ts})`,
          ]
        : [`:rotating_light: page ${MENTIONS}`],
    );
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({ event: "slack.page-gone", channel: errorPulse, ts: page.ts, reason: error }),
    );
  },
);

test("resolvePage: a deleted page gets nothing in its place", async () => {
  const slack = fakeSlack({ now });
  const page = slack.seed("#error-pulse", `:rotating_light: page ${MENTIONS}`);
  await slack.client.chat.delete({ channel: errorPulse, ts: page.ts });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await resolvePage(slack.client, {
    channel: errorPulse,
    ts: page.ts,
    text: page.text,
    why: "back under 2",
    now: new Date(now),
  });
  expect(slack.channel("#error-pulse")).toEqual([]);
});

test.for(goneRows)(
  "keepPage: an open page Slack answers $error to is posted again in today's dashboard thread, and closed naming no one when it is still there",
  async ({ error, frozen }) => {
    const slack = fakeSlack({ now });
    const page = slack.seed("#error-pulse", `:rotating_light: sweep: stuck n=1 ${MENTIONS}`, {
      updateError: error,
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      keepPage(slack.client, {
        marker: "sweep: stuck",
        sinceHours: 720,
        now: new Date(now),
        render: async () => `🚨 sweep: stuck n=2 ${MENTIONS}`,
        why: "gone",
        broadcast: false,
      }),
    ).resolves.toBe("edit");
    expect(shape(slack)).toEqual([
      `:rotating_light: sweep: stuck n=1 ${MENTIONS}`,
      "📟 error-pulse · Tue 22 Sep · 12:00 UTC",
      `  ↳ 🚨 sweep: stuck n=2 ${MENTIONS}`,
      ...(frozen
        ? [
            `  ↳ ✅ resolved: this page moved to a new message, which Slack lets this bot edit (closes ${page.ts})`,
          ]
        : []),
    ]);
  },
);

test.for(goneRows)(
  "keepPage: an older page Slack answers $error to is closed naming no one when it is still there, and the newest is kept",
  async ({ error, frozen }) => {
    const slack = fakeSlack({ now });
    const older = slack.seed("#error-pulse", `:rotating_light: sweep: stuck n=1 ${MENTIONS}`, {
      ageHours: 2,
      updateError: error,
    });
    const newer = slack.seed("#error-pulse", `:rotating_light: sweep: stuck n=2 ${MENTIONS}`, {
      ageHours: 1,
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      keepPage(slack.client, {
        marker: "sweep: stuck",
        sinceHours: 720,
        now: new Date(now),
        render: async () => undefined,
        why: "the sweep succeeded",
        broadcast: false,
      }),
    ).resolves.toBe("resolve");
    expect(writes(slack).filter((call) => !isDashboardPost(call))).toEqual([
      {
        method: "chat.update",
        channel: errorPulse,
        ts: older.ts,
        text: `✅ resolved: sweep: stuck n=1 ${MENTIONS}`,
      },
      ...(frozen
        ? [
            expect.objectContaining({
              method: "chat.postMessage",
              text: "✅ resolved: a newer page follows this incident",
              metadata: { event_type: "error_pulse_page_closed", event_payload: { ts: older.ts } },
            }),
          ]
        : []),
      {
        method: "chat.update",
        channel: errorPulse,
        ts: newer.ts,
        text: `✅ resolved: sweep: stuck n=2 ${MENTIONS}\n✅ the sweep succeeded`,
      },
    ]);
  },
);

// Over several runs, a page Slack can no longer edit is resolved exactly once: a frozen one stays in
// the channel's history, which is these posters' only state, so each run reads it again.
test.for([
  ...FROZEN_ERRORS.flatMap((error) => [
    {
      name: `${error}, the incident still there, then gone`,
      error,
      renders: [true, false, false, false],
      steps: ["edit", "resolve"],
    },
    {
      name: `${error}, the incident gone`,
      error,
      renders: [false, false, false, false],
      steps: ["resolve"],
    },
  ]),
  {
    name: "deleted, the incident still there, then gone",
    error: "deleted",
    renders: [true, false, false, false],
    steps: ["post", "resolve"],
  },
])(
  "keepPage over four runs: a page Slack cannot edit is resolved once ($name)",
  async ({ error, renders, steps: expected }) => {
    const slack = fakeSlack({ now });
    const page = slack.seed("#error-pulse", `:rotating_light: sweep: stuck n=1 ${MENTIONS}`, {
      ageHours: 1,
      updateError: error === "deleted" ? undefined : error,
    });
    if (error === "deleted") await slack.client.chat.delete({ channel: errorPulse, ts: page.ts });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = {
      marker: "sweep: stuck",
      sinceHours: 720,
      now: new Date(now),
      why: "the sweep succeeded",
      broadcast: false,
    };
    const steps = [];
    for (const present of renders)
      steps.push(
        await keepPage(slack.client, {
          ...input,
          render: async () => (present ? `🚨 sweep: stuck n=2 ${MENTIONS}` : undefined),
        }),
      );
    expect({
      steps: steps.filter((step) => step !== "none"),
      resolutions: slack
        .timeline("#error-pulse")
        .filter((message) => message.text.includes("the sweep succeeded")).length,
      open: await findOpenPages(slack.client, { ...input, channel: errorPulse }),
    }).toEqual({
      steps: expected,
      resolutions: 1,
      open: [],
    });
  },
);

test("keepPage: any other error from Slack's edit throws", async () => {
  const slack = fakeSlack({ now });
  slack.seed("#error-pulse", `:rotating_light: sweep: stuck n=1 ${MENTIONS}`, {
    updateError: "fatal_error",
  });
  await expect(
    keepPage(slack.client, {
      marker: "sweep: stuck",
      sinceHours: 720,
      now: new Date(now),
      render: async () => `🚨 sweep: stuck n=2 ${MENTIONS}`,
      why: "gone",
      broadcast: false,
    }),
  ).rejects.toThrow("An API error occurred: fatal_error");
  expect(writes(slack).map((call) => call.method)).toEqual(["chat.update"]);
});

test.for([
  { name: "none open, the incident there: post", open: false, text: "🚨 n=1", step: "post" },
  { name: "open, the incident still there: edit", open: true, text: "🚨 n=2", step: "edit" },
  { name: "open, the incident gone: resolve", open: true, text: undefined, step: "resolve" },
  { name: "none open, nothing there: nothing", open: false, text: undefined, step: "none" },
])("pageStep: $name", ({ open, text, step }) => {
  const page = open ? { ts: "1.0", text: ":rotating_light: n=1" } : undefined;
  expect(pageStep(page, text)).toMatchObject({ step });
});

test("keepPage: one incident over five nights is posted, edited twice, resolved once, then left alone", async () => {
  const slack = fakeSlack({ now });
  const night = (ids: string[]) =>
    keepPage(slack.client, {
      marker: "preview sweep: Cloudflare will not delete",
      sinceHours: 720,
      now: new Date(now),
      render: async () =>
        ids.length
          ? pageText({
              what: `preview sweep: Cloudflare will not delete ${ids.length} Artifacts namespace(s)`,
              impact: "each counts toward the account's limit",
              action: "escalate to Cloudflare with these ids",
              details: ids,
              link: null,
              testRun: false,
            })
          : undefined,
      why: "Cloudflare deleted them",
      broadcast: false,
    });
  const steps = [];
  for (const ids of [["• a"], ["• a"], ["• a", "• b"], [], []]) steps.push(await night(ids));
  expect({ steps, writes: writes(slack).map((call) => call.method) }).toEqual({
    // the dashboard, then the page in its thread
    steps: ["post", "edit", "edit", "resolve", "none"],
    writes: ["chat.postMessage", "chat.postMessage", "chat.update", "chat.update", "chat.update"],
  });
  const [page] = slack.channel("#error-pulse")[0]!.replies;
  expect(writes(slack).at(-1)).toEqual({
    method: "chat.update",
    channel: errorPulse,
    ts: page!.ts,
    text: `✅ resolved: preview sweep: Cloudflare will not delete 2 Artifacts namespace(s) ${MENTIONS}\n✅ Cloudflare deleted them\nImpact: each counts toward the account's limit\nDo: escalate to Cloudflare with these ids\n• a\n• b`,
  });
});

test("keepPage: older open pages of the incident are resolved by an edit alone, and the newest is kept", async () => {
  const slack = fakeSlack({ now });
  const older = slack.seed("#error-pulse", `:rotating_light: sweep: stuck n=1 ${MENTIONS}`, {
    ageHours: 120 / 3600,
  });
  const newer = slack.seed("#error-pulse", `:rotating_light: sweep: stuck n=2 ${MENTIONS}`, {
    ageHours: 60 / 3600,
  });
  await expect(
    keepPage(slack.client, {
      marker: "sweep: stuck",
      sinceHours: 720,
      now: new Date(now),
      render: async () => `🚨 sweep: stuck n=3 ${MENTIONS}`,
      why: "gone",
      broadcast: false,
    }),
  ).resolves.toBe("edit");
  expect(writes(slack)).toEqual([
    {
      method: "chat.update",
      channel: errorPulse,
      ts: older.ts,
      text: `✅ resolved: sweep: stuck n=1 ${MENTIONS}`,
    },
    {
      method: "chat.update",
      channel: errorPulse,
      ts: newer.ts,
      text: `🚨 sweep: stuck n=3 ${MENTIONS}`,
    },
  ]);
});

test("keepPage renders from the open page's text: what it named and this run did not see is carried, not dropped", async () => {
  const slack = fakeSlack({ now });
  const page = slack.seed("#error-pulse", `:rotating_light: sweep: stuck\n• a ${MENTIONS}`, {
    ageHours: 60 / 3600,
  });
  const seen: Array<string | undefined> = [];
  await expect(
    keepPage(slack.client, {
      marker: "sweep: stuck",
      sinceHours: 720,
      now: new Date(now),
      render: async (openText) => {
        seen.push(openText);
        return `🚨 sweep: stuck\n• a\n• b ${MENTIONS}`;
      },
      why: "gone",
      broadcast: false,
    }),
  ).resolves.toBe("edit");
  expect({ seen, writes: writes(slack) }).toEqual({
    seen: [`:rotating_light: sweep: stuck\n• a ${MENTIONS}`],
    writes: [
      {
        method: "chat.update",
        channel: errorPulse,
        ts: page.ts,
        text: `🚨 sweep: stuck\n• a\n• b ${MENTIONS}`,
      },
    ],
  });
});

/** The Slack writes a run made: every call but the reads. */
function writes(slack: ReturnType<typeof fakeSlack>) {
  return slack.calls.filter((call) => call.method.startsWith("chat."));
}

/** Whether a call posted a dashboard (./dashboard.ts), which the first page of a day brings. */
function isDashboardPost(call: { method: string; metadata?: { event_type: string } }) {
  return call.method === "chat.postMessage" && call.metadata?.event_type === DASHBOARD_EVENT;
}

/** #error-pulse as a reader sees it: each message's first line, a reply indented under its thread,
 *  and a reply that closes a page by its metadata naming the page's ts. */
function shape(slack: ReturnType<typeof fakeSlack>) {
  return slack
    .channel("#error-pulse")
    .flatMap((message) => [
      message.text.split("\n")[0],
      ...message.replies.map(
        (reply) =>
          `  ↳ ${reply.text.split("\n")[0]}${reply.metadata?.event_type === PAGE_CLOSED_EVENT ? ` (closes ${String(reply.metadata.event_payload.ts)})` : ""}`,
      ),
    ]);
}
