// The page primitives over a fake Slack. The token lookup and the WebClient itself are out of scope.
import type { WebClient } from "@slack/web-api";
import { expect, test } from "vitest";
import {
  escalationText,
  findOpenPage,
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

test("a test run's page goes to #ci, a real one to #error-pulse", () => {
  expect({ test: pageChannel(true), real: pageChannel(false) }).toEqual({
    test: slackChannelIds["#ci"],
    real: slackChannelIds["#error-pulse"],
  });
});

const at = Date.parse("2026-09-22T12:00:00Z") / 1000;
test.for([
  {
    name: "the newest open page wins",
    history: [
      { ts: at - 60, bot_id: "B1", text: ":rotating_light: DO cost page for prd: new" },
      { ts: at - 120, bot_id: "B1", text: ":rotating_light: DO cost page for prd: old" },
    ],
    expected: { ts: String(at - 60), text: ":rotating_light: DO cost page for prd: new" },
  },
  {
    name: "a resolved page, another bot's and a 🧪 page are skipped",
    history: [
      { ts: at - 10, bot_id: "B1", text: ":white_check_mark: resolved: DO cost page for prd: a" },
      { ts: at - 20, bot_id: "B2", text: ":rotating_light: DO cost page for prd: b" },
      {
        ts: at - 30,
        bot_id: "B1",
        text: ":test_tube: TEST RUN — :rotating_light: DO cost page for prd: c",
      },
      { ts: at - 40, bot_id: "B1", text: ":rotating_light: DO cost page for prd: d" },
    ],
    expected: { ts: String(at - 40), text: ":rotating_light: DO cost page for prd: d" },
  },
  {
    name: "a later line that says resolved: does not close a page",
    history: [
      {
        ts: at - 10,
        bot_id: "B1",
        text: ":rotating_light: DO cost page for prd: a\nImpact: resolved: x",
      },
    ],
    expected: {
      ts: String(at - 10),
      text: ":rotating_light: DO cost page for prd: a\nImpact: resolved: x",
    },
  },
  {
    name: "a page behind 250 newer messages is found on the next history page",
    history: [
      ...Array.from({ length: 250 }, (_, index) => ({
        ts: at - 100 + index * 0.1,
        bot_id: "B1",
        text: "PR opened",
      })),
      { ts: at - 3600, bot_id: "B1", text: ":rotating_light: DO cost page for prd: e" },
    ],
    expected: { ts: String(at - 3600), text: ":rotating_light: DO cost page for prd: e" },
  },
  {
    name: "a page older than the window is not open",
    history: [
      { ts: at - 49 * 3600, bot_id: "B1", text: ":rotating_light: DO cost page for prd: f" },
    ],
    expected: undefined,
  },
])("findOpenPage: $name", async ({ history, expected }) => {
  const slack = fakeSlack(history.map((message) => ({ ...message, ts: String(message.ts) })));
  await expect(
    findOpenPage(slack.client, {
      channel: "C1",
      marker: "DO cost page for prd:",
      sinceHours: 48,
      now: new Date(at * 1000),
    }),
  ).resolves.toEqual(expected);
});

test.for([
  {
    name: "the page is edited first, then the thread gets the reply",
    updateFails: false,
    outcome: "resolved",
    writes: [
      ["chat.update", { channel: "C1", ts: "1.0", text: `✅ resolved: page ${MENTIONS}` }],
      [
        "chat.postMessage",
        { channel: "C1", thread_ts: "1.0", text: `✅ resolved: back under 2 ${MENTIONS}` },
      ],
    ],
  },
  {
    name: "a failed edit posts no reply, so the next run resolves it once",
    updateFails: true,
    outcome: "an_error",
    writes: [["chat.update", { channel: "C1", ts: "1.0", text: `✅ resolved: page ${MENTIONS}` }]],
  },
])("resolvePage: $name", async ({ updateFails, outcome, writes }) => {
  const slack = fakeSlack([], updateFails);
  await expect(
    resolvePage(slack.client, {
      channel: "C1",
      ts: "1.0",
      text: `:rotating_light: page ${MENTIONS}`,
      why: "back under 2",
    }).then(
      () => "resolved",
      (error: Error) => error.message,
    ),
  ).resolves.toBe(outcome);
  // oxlint-disable-next-line iterate/prefer-object-property-match -- exact: an extra Slack write must fail
  expect(slack.writes).toEqual(writes);
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
  const slack = fakeSlack([]);
  const night = (ids: string[]) =>
    keepPage(slack.client, {
      marker: "preview sweep: Cloudflare will not delete",
      sinceHours: 720,
      now: new Date(at * 1000),
      text: ids.length
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
  expect({ steps, writes: slack.writes.map(([call]) => call) }).toEqual({
    steps: ["post", "edit", "edit", "resolve", "none"],
    writes: ["chat.postMessage", "chat.update", "chat.update", "chat.update", "chat.postMessage"],
  });
  expect(slack.writes.slice(-2)).toEqual([
    [
      "chat.update",
      {
        channel: "C09K1CTN4M7",
        ts: String(at),
        text: `✅ resolved: preview sweep: Cloudflare will not delete 2 Artifacts namespace(s) ${MENTIONS}\nImpact: each counts toward the account's limit\nDo: escalate to Cloudflare with these ids\n• a\n• b`,
      },
    ],
    [
      "chat.postMessage",
      {
        channel: "C09K1CTN4M7",
        thread_ts: String(at),
        text: `✅ resolved: Cloudflare deleted them ${MENTIONS}`,
      },
    ],
  ]);
});

/** A WebClient stand-in: `messages` is the channel's history, served newest first a page of
 * `limit` at a time from `oldest`; every write is recorded, and a top-level post or an edit lands
 * in the history. */
function fakeSlack(
  messages: Array<{ ts: string; bot_id: string; text: string }>,
  updateFails = false,
) {
  const writes: Array<[string, unknown]> = [];
  const client = {
    auth: { test: async () => ({ ok: true, bot_id: "B1" }) },
    conversations: {
      history: async (args: { oldest: string; limit: number; cursor?: string }) => {
        const since = messages
          .filter((message) => Number(message.ts) >= Number(args.oldest))
          .sort((a, b) => Number(b.ts) - Number(a.ts));
        const start = Number(args.cursor || 0);
        const end = start + args.limit;
        return {
          messages: since.slice(start, end),
          response_metadata: { next_cursor: end < since.length ? String(end) : "" },
        };
      },
    },
    chat: {
      postMessage: async (args: { text: string; thread_ts?: string }) => {
        writes.push(["chat.postMessage", args]);
        const ts = String(at + messages.length);
        if (!args.thread_ts) messages.push({ ts, bot_id: "B1", text: args.text });
        return { ok: true, ts };
      },
      update: async (args: { ts: string; text: string }) => {
        writes.push(["chat.update", args]);
        if (updateFails) throw new Error("an_error");
        const message = messages.find(({ ts }) => ts === args.ts);
        if (message) message.text = args.text;
        return { ok: true };
      },
    },
  } as unknown as WebClient; // only the calls slack.ts makes
  return { client, writes };
}
