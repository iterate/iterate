// the default import is the package's CommonJS exports: Node's ESM named-export detection cannot see
// `retryPolicies`, which the index re-exports through a getter
import slackWebApi, { WebAPIPlatformError, WebClient } from "@slack/web-api";
import { z } from "zod";
import { dopplerSecret } from "../lib/env-context.ts";

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

/** What every message to #error-pulse mentions: Jonas and Misha, on call for prd and main, by Slack
 *  user id. Routine posts (deploys that succeeded, pull request events, the dashboards) go to #ci and
 *  mention nobody. */
export const onCallMention = ["jonas", "misha"]
  .map((handle) => `<@${slackUsers.find((user) => user.handle === handle)!.id}>`)
  .join(" ");

/** Slack as the CI bot, whose token is Doppler _shared/prd's, with Slack's own bounded retry policy:
 *  its default asks again for about 30 minutes, which would hold a job to its timeout through a
 *  Slack outage. A 429 waits its `Retry-After`. */
export function getSlackClient() {
  return new WebClient(dopplerSecret("_shared", "prd", "SLACK_CI_BOT_TOKEN"), {
    retryConfig: slackWebApi.retryPolicies.fiveRetriesInFiveMinutes,
  });
}

/** Escapes the three characters Slack's mrkdwn treats as control characters. */
export function slackEscape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** `value` cut to `length` characters and "…" when longer, on whole graphemes, so an emoji or an
 *  accented letter is never split. Cut before slackEscape, which would otherwise be split too. Pure. */
export function cutText(value: string, length: number) {
  const graphemes = Array.from(new Intl.Segmenter().segment(value), ({ segment }) => segment);
  return graphemes.length > length ? `${graphemes.slice(0, length).join("")}…` : value;
}

/** The channel a page goes to: #error-pulse, or #ci for a 🧪 test run, which pages nobody. */
export function pageChannel(testRun: boolean) {
  return testRun ? slackChannelIds["#ci"] : slackChannelIds["#error-pulse"];
}

/** One incident's top-level message: what broke with both mentions, who or what it affects, the
 *  first thing to do, any lines that action needs (the ids to escalate), and the one link. A test
 *  run's is marked 🧪 and mentions nobody. */
export function pageText(input: {
  what: string;
  impact: string;
  action: string;
  details?: string[];
  link: string | null;
  testRun: boolean;
}) {
  return [
    input.testRun ? `🧪 TEST RUN — 🚨 ${input.what}` : `🚨 ${input.what} ${onCallMention}`,
    `Impact: ${input.impact}`,
    `Do: ${input.action}`,
    ...(input.details || []),
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
 * The pages this bot posted in the last `sinceHours` whose text has `marker` and whose first line
 * is not resolved, newest first, read page by page through the channel's history. A 🧪 test page is
 * never an incident.
 */
export async function findOpenPages(
  slack: WebClient,
  input: { channel: string; marker: string; sinceHours: number; now: Date },
): Promise<Array<{ ts: string; text: string }>> {
  const { bot_id: botId } = await slack.auth.test();
  const since = input.now.getTime() / 1000 - input.sinceHours * 3600;
  const open: Array<{ ts: string; text: string }> = [];
  let cursor: string | undefined;
  do {
    // no `oldest`: with it and no `latest`, Slack pages from the window's oldest end
    const history = await slack.conversations.history({
      channel: input.channel,
      limit: 200,
      cursor,
    });
    const messages = (history.messages || []).filter((message) => Number(message.ts) >= since);
    for (const message of messages) {
      const text = message.text || "";
      if (
        message.ts &&
        message.bot_id === botId &&
        text.includes(input.marker) &&
        !text.includes("TEST RUN") &&
        !isResolved(text)
      )
        open.push({ ts: message.ts, text });
    }
    const pastWindow = messages.length < (history.messages || []).length;
    cursor = pastWindow ? undefined : history.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return open;
}

/** Slack's answers to an edit of a page it can no longer edit: someone deleted it, or it is past
 *  the workspace's edit window. The page is gone: what would have edited it goes top-level. */
export const PAGE_GONE_ERRORS = new Set([
  "message_not_found",
  "edit_window_closed",
  "cant_update_message",
]);

/** Edits the message at `ts` to `text`: "edited", or "gone" when Slack can no longer edit it
 *  (PAGE_GONE_ERRORS), which is logged. Any other error throws. */
export async function updatePage(
  slack: WebClient,
  page: { channel: string; ts: string; text: string },
): Promise<"edited" | "gone"> {
  try {
    await slack.chat.update(page);
    return "edited";
  } catch (error) {
    if (!(error instanceof WebAPIPlatformError && PAGE_GONE_ERRORS.has(error.data.error)))
      throw error;
    console.warn(
      JSON.stringify({
        event: "slack.page-gone",
        channel: page.channel,
        ts: page.ts,
        reason: error.data.error,
      }),
    );
    return "gone";
  }
}

/** Edits the page at `ts` to `text`, resolving to the page's ts: a new top-level page's when the
 *  page is gone (updatePage), so its thread moves there. */
export async function editPage(
  slack: WebClient,
  page: { channel: string; ts: string; text: string },
) {
  if ((await updatePage(slack, page)) === "edited") return page.ts;
  const posted = await slack.chat.postMessage({ channel: page.channel, text: page.text });
  return z.string().parse(posted.ts);
}

/**
 * Closes an incident: its page's first line is edited to `✅ resolved:`, then the thread gets the
 * reply that says why, with both mentions. The edit comes first, so a failed edit leaves the page
 * open for the next run to resolve and never repeats the reply. A page that is gone (updatePage)
 * gets its reply top-level instead.
 */
export async function resolvePage(
  slack: WebClient,
  input: { channel: string; ts: string; text: string; why: string },
) {
  const { channel } = input;
  const edited = await updatePage(slack, { channel, ts: input.ts, text: markResolved(input.text) });
  await slack.chat.postMessage({
    channel,
    thread_ts: edited === "edited" ? input.ts : undefined,
    // a 🧪 test page is never open (findOpenPages), so this resolves a real one
    text: resolvedText(input.why, false),
  });
}

/** Resolves `pages` by an edit alone, which notifies nobody: the older open pages of an incident
 *  that has a newer page. One that is gone (updatePage) is already closed. */
export async function resolveOlderPages(
  slack: WebClient,
  channel: string,
  pages: Array<{ ts: string; text: string }>,
) {
  for (const page of pages)
    await updatePage(slack, { channel, ts: page.ts, text: markResolved(page.text) });
}

/** What a run does with one incident's page, given its open page (if any) and this run's page text
 *  (none when the incident is gone): post, edit, resolve, or nothing. Pure. */
export function pageStep(
  open: { ts: string; text: string } | undefined,
  text: string | undefined,
):
  | { step: "post"; text: string }
  | { step: "edit"; ts: string; text: string }
  | { step: "resolve"; ts: string; text: string }
  | { step: "none" } {
  if (!text) return open ? { step: "resolve", ...open } : { step: "none" };
  return open ? { step: "edit", ts: open.ts, text } : { step: "post", text };
}

/**
 * Keeps one incident's #error-pulse page for a poster with no state but the channel: posts it,
 * edits it while the incident lasts (an edit notifies nobody), or resolves it with `why` once this
 * run finds the incident gone (pageStep). `render` is this run's page text, given the open page's
 * (a poster that cannot see the whole incident in one run carries forward what the page names), or
 * undefined when the incident is gone. Older open pages of the same incident (a page per night from
 * before one was kept) are resolved by an edit alone (resolveOlderPages). A gone page's edit posts
 * the page again and its resolution goes top-level (updatePage). Returns the step taken. A 🧪 test
 * run posts its page to #ci itself and never calls this.
 */
export async function keepPage(
  slack: WebClient,
  input: {
    marker: string;
    sinceHours: number;
    now: Date;
    render: (openText: string | undefined) => Promise<string | undefined>;
    why: string;
  },
) {
  const channel = pageChannel(false);
  const { marker, sinceHours, now } = input;
  const [open, ...older] = await findOpenPages(slack, { channel, marker, sinceHours, now });
  await resolveOlderPages(slack, channel, older);
  const step = pageStep(open, await input.render(open?.text));
  if (step.step === "post") await slack.chat.postMessage({ channel, text: step.text });
  if (step.step === "edit") await editPage(slack, { channel, ts: step.ts, text: step.text });
  if (step.step === "resolve")
    await resolvePage(slack, { channel, ts: step.ts, text: step.text, why: input.why });
  return step.step;
}
