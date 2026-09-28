import { execSync } from "node:child_process";

import { WebClient } from "@slack/web-api";

export const slackChannelIds = {
  "#error-pulse": "C09K1CTN4M7",
  "#ci": "C0B3QJSU32A",
};

export const slackUsers = [
  {
    id: "U092YE019D5",
    handle: "nickblow",
    github: "nickblow",
  },
  {
    id: "U08V1A83Y2W",
    handle: "Rahul",
    github: "BlankParticle",
  },
  {
    id: "U099JH9TAF2",
    handle: "misha",
    github: "mmkal",
  },
  {
    id: "U067G4QRFK2",
    handle: "jonas",
    github: "jonastemplestein",
  },
];

function getSlackBotToken() {
  if (process.env.SLACK_CI_BOT_TOKEN) {
    return process.env.SLACK_CI_BOT_TOKEN;
  }
  if (process.env.DOPPLER_TOKEN) {
    return execSync("doppler secrets --project _shared --config prd get --plain SLACK_CI_BOT_TOKEN")
      .toString()
      .trim();
  }
  throw new Error(
    "Can't get Slack bot token: neither SLACK_CI_BOT_TOKEN nor DOPPLER_TOKEN is available",
  );
}

/** What every message to #error-pulse mentions: Jonas and Misha, on call for prd and main, by Slack
 *  user id. Routine posts (deploys that succeeded, pull request events, the dashboards) go to #ci and
 *  mention nobody. */
export const onCallMention = ["jonas", "misha"]
  .map((handle) => `<@${slackUsers.find((user) => user.handle === handle)!.id}>`)
  .join(" ");

export function getSlackClient() {
  return new WebClient(getSlackBotToken());
}

/** Escapes the three characters Slack's mrkdwn treats as control characters. */
export function slackEscape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The channel a page goes to: #error-pulse, or #ci for a 🧪 test run, which pages nobody. */
export function pageChannel(testRun: boolean) {
  return testRun ? slackChannelIds["#ci"] : slackChannelIds["#error-pulse"];
}

/** One incident's top-level message: what broke with both mentions, who or what it affects, the
 *  first thing to do, and the one link. A test run's is marked 🧪 and mentions nobody. */
export function pageText(input: {
  what: string;
  impact: string;
  action: string;
  link: string | null;
  testRun: boolean;
}) {
  return [
    input.testRun ? `🧪 TEST RUN — 🚨 ${input.what}` : `🚨 ${input.what} ${onCallMention}`,
    `Impact: ${input.impact}`,
    `Do: ${input.action}`,
    input.link && `<${input.link}|run>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The thread reply that closes an incident, with both mentions. A test run's is marked 🧪 and
 *  mentions nobody. */
export function resolvedText(why: string, testRun: boolean) {
  return testRun ? `🧪 TEST RUN — ✅ resolved: ${why}` : `✅ resolved: ${why} ${onCallMention}`;
}

/** The thread reply for an incident that got worse: what is new, with both mentions. A test run's is
 *  marked 🧪 and mentions nobody. */
export function escalationText(news: string, testRun: boolean) {
  return testRun ? `🧪 TEST RUN — 🚨 ${news}` : `🚨 ${news} ${onCallMention}`;
}

/** A page's text with its first line starting `✅ resolved:`, mentions kept. It takes the text as
 *  Slack's history returns it too, where 🚨 reads `:rotating_light:`. */
export function markResolved(text: string) {
  const [first = "", ...rest] = text.split("\n");
  return [`✅ resolved: ${first.replace(/^(🚨|:rotating_light:)\s*/, "")}`, ...rest].join("\n");
}

/** Whether a page's first line says it is resolved. Words, not the emoji: Slack's history spells ✅
 *  as `:white_check_mark:`. */
function isResolved(text: string) {
  return /^(✅|:white_check_mark:)\s*resolved:/.test(text);
}

/**
 * The newest page this bot posted in the last `sinceHours` whose text has `marker` and whose first
 * line is not resolved, read page by page through the channel's history. A 🧪 test page is never an
 * incident.
 */
export async function findOpenPage(
  slack: WebClient,
  input: { channel: string; marker: string; sinceHours: number; now: Date },
): Promise<{ ts: string; text: string } | undefined> {
  const { bot_id: botId } = await slack.auth.test();
  let cursor: string | undefined;
  do {
    const history = await slack.conversations.history({
      channel: input.channel,
      oldest: String(input.now.getTime() / 1000 - input.sinceHours * 3600),
      limit: 200,
      cursor,
    });
    for (const message of history.messages || []) {
      const text = message.text || "";
      if (
        message.ts &&
        message.bot_id === botId &&
        text.includes(input.marker) &&
        !text.includes("TEST RUN") &&
        !isResolved(text)
      )
        return { ts: message.ts, text };
    }
    cursor = history.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return undefined;
}

/**
 * Closes an incident: its page's first line is edited to `✅ resolved:`, then the thread gets the
 * reply that says why, with both mentions. The edit comes first, so a failed edit leaves the page
 * open for the next run to resolve and never repeats the reply.
 */
export async function resolvePage(
  slack: WebClient,
  input: { channel: string; ts: string; text: string; why: string },
) {
  await slack.chat.update({ channel: input.channel, ts: input.ts, text: markResolved(input.text) });
  await slack.chat.postMessage({
    channel: input.channel,
    thread_ts: input.ts,
    // a 🧪 test page is never open (findOpenPage), so this resolves a real one
    text: resolvedText(input.why, false),
  });
}
