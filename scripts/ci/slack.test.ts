// The page primitives over a fake Slack. The token lookup and the WebClient itself are out of scope.
import { expect, test } from "vitest";
import { fakeSlack } from "./fake-slack.ts";
import {
  cutText,
  escalationText,
  findOpenPages,
  keepPage,
  markResolved,
  pageChannel,
  pageStep,
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
    name: "a resolution mentions both",
    text: resolvedText("main e2e green again", false),
    expected: `✅ resolved: main e2e green again ${MENTIONS}`,
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
  { name: "the page is edited first, then the thread gets the reply", failUpdates: false },
  { name: "a failed edit posts no reply, so the next run resolves it once", failUpdates: true },
])("resolvePage: $name", async ({ failUpdates }) => {
  const slack = fakeSlack({ now, failUpdates });
  const page = slack.seed("#error-pulse", `:rotating_light: page ${MENTIONS}`);
  const edit = {
    method: "chat.update",
    channel: errorPulse,
    ts: page.ts,
    text: `✅ resolved: page ${MENTIONS}`,
  };
  const reply = {
    method: "chat.postMessage",
    channel: errorPulse,
    thread_ts: page.ts,
    text: `✅ resolved: back under 2 ${MENTIONS}`,
  };
  await expect(
    resolvePage(slack.client, {
      channel: errorPulse,
      ts: page.ts,
      text: page.text,
      why: "back under 2",
    }).then(
      () => "resolved",
      (error: Error) => error.message,
    ),
  ).resolves.toBe(failUpdates ? "an_error" : "resolved");
  expect(writes(slack)).toEqual(failUpdates ? [edit] : [edit, reply]);
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
    });
  const steps = [];
  for (const ids of [["• a"], ["• a"], ["• a", "• b"], [], []]) steps.push(await night(ids));
  expect({ steps, writes: writes(slack).map((call) => call.method) }).toEqual({
    steps: ["post", "edit", "edit", "resolve", "none"],
    writes: ["chat.postMessage", "chat.update", "chat.update", "chat.update", "chat.postMessage"],
  });
  const [page] = slack.channel("#error-pulse");
  expect(writes(slack).slice(-2)).toEqual([
    {
      method: "chat.update",
      channel: errorPulse,
      ts: page!.ts,
      text: `✅ resolved: preview sweep: Cloudflare will not delete 2 Artifacts namespace(s) ${MENTIONS}\nImpact: each counts toward the account's limit\nDo: escalate to Cloudflare with these ids\n• a\n• b`,
    },
    {
      method: "chat.postMessage",
      channel: errorPulse,
      thread_ts: page!.ts,
      text: `✅ resolved: Cloudflare deleted them ${MENTIONS}`,
    },
  ]);
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
