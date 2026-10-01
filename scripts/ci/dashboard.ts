// scripts/ci/dashboard.ts — #ERROR-PULSE'S DAILY DASHBOARD: one top-level message per UTC day, one row
// per signal, edited in place by every poster that judges one (an edit notifies nobody). Pages are
// replies in its thread (./slack.ts `postPage`), so the channel's top level is one readable message a
// day. It exists because a top-level page per incident makes the channel unreadable at a glance.
//
//   📟 error-pulse · Thu 1 Oct · 15:02 UTC
//   🔴 main e2e: red at `916a48f20` (packages/ui is a shadcn registry…)
//   🟢 prd hosts: every project host answers on `7b49a601`
//
// The rows are the message's Slack metadata (DASHBOARD_EVENT, read back with
// `include_all_metadata`); its text is rendered from them, so nothing parses it. Today's message is
// this bot's top-level one since 00:00 UTC whose metadata names today. The first poster of a day
// posts it with yesterday's rows, so a signal no poster judged today still shows what it last was.
// Each poster rewrites only its own row, then reads the message back: Slack has no compare-and-set,
// and two posters' edits in the same second can drop one's row, which is written again.
//
//   node scripts/ci/dashboard.ts close-legacy-pages [--resolve]   # the 🚨 pages from before it
import type { WebClient } from "@slack/web-api";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { cutText, getSlackClient, markResolved, slackChannelIds } from "./slack.ts";

/** The metadata event type of a dashboard, and of a reply that closes a page Slack can no longer
 *  edit (./slack.ts `closeFrozenPage`), its payload naming the page's ts. */
export const DASHBOARD_EVENT = "error_pulse_dashboard";
export const PAGE_CLOSED_EVENT = "error_pulse_page_closed";

/** A row's state, as its emoji shows it: red needs someone, amber is open but quiet or slow, green
 *  is fine, grey is the probe's own trouble (a sweep Cloudflare blocks, a signal not judged). */
export const RowState = z.enum(["red", "amber", "green", "grey"]);
export type RowState = z.infer<typeof RowState>;
const EMOJI: Record<RowState, string> = { red: "🔴", amber: "🟡", green: "🟢", grey: "⚪" };

/** One signal's row. Slack's metadata holds an array of flat objects at most, hence a list. */
const Row = z.object({
  signal: z.string(),
  state: RowState,
  text: z.string(),
  at: z.iso.datetime(),
});
export const DashboardPayload = z.object({ day: z.iso.date(), rows: z.array(Row) });
export type DashboardPayload = z.infer<typeof DashboardPayload>;

/** The rows in the order the dashboard shows them, most urgent first; a signal not listed follows,
 *  by name. */
export const SIGNALS = [
  "prd hosts",
  "prd deploys",
  "prd faults",
  "main e2e",
  "DO cost",
  "context sweep",
  "Kit Firmware",
  "OS crash hunt",
  "real-model e2e",
  "slow e2e rows",
  "latency",
  "PR time to green",
  "preview sweep",
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A row's text is cut to this many characters: detail lives in the signal's page and run. */
const ROW_LENGTH = 110;

/** The dashboard's text for `payload` at `now`. Pure. */
export function renderDashboard(payload: DashboardPayload, now: Date) {
  // by hand: Intl's short month varies by ICU version (Sep, Sept)
  const date = new Date(`${payload.day}T00:00:00Z`);
  const day = `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  const order = (signal: string) => {
    const index = SIGNALS.indexOf(signal);
    return index === -1 ? SIGNALS.length : index;
  };
  const rows = payload.rows
    .toSorted((a, b) => order(a.signal) - order(b.signal) || a.signal.localeCompare(b.signal))
    .map((row) => `${EMOJI[row.state]} ${row.signal}: ${cutText(row.text, ROW_LENGTH)}`);
  return [`📟 error-pulse · ${day} · ${now.toISOString().slice(11, 16)} UTC`, ...rows].join("\n");
}

/** A dashboard as Slack holds it: its message's ts and its rows. */
export type Dashboard = { ts: string; payload: DashboardPayload };

/** This bot's dashboards posted at or after `oldest` (seconds), newest first, read page by page. */
export async function findDashboards(
  slack: WebClient,
  input: { channel: string; oldest: number },
): Promise<Dashboard[]> {
  const { bot_id: botId } = await slack.auth.test();
  const found: Dashboard[] = [];
  let cursor: string | undefined;
  do {
    const history = await slack.conversations.history({
      channel: input.channel,
      oldest: String(input.oldest),
      limit: 200,
      include_all_metadata: true,
      cursor,
    });
    for (const message of history.messages || []) {
      if (message.bot_id !== botId || message.metadata?.event_type !== DASHBOARD_EVENT) continue;
      const payload = DashboardPayload.safeParse(message.metadata.event_payload);
      if (message.ts && payload.success) found.push({ ts: message.ts, payload: payload.data });
    }
    cursor = history.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return found.sort((a, b) => Number(b.ts) - Number(a.ts));
}

/** Today's dashboard: found, or posted with the rows of the newest one before it (two days back at
 *  most). Two posters posting today's at once keep the older and delete the younger. */
export async function todaysDashboard(
  slack: WebClient,
  input: { channel: string; now: Date },
): Promise<Dashboard> {
  const day = input.now.toISOString().slice(0, 10);
  const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000;
  const recent = await findDashboards(slack, {
    channel: input.channel,
    oldest: dayStart - 2 * 86_400,
  });
  const today = recent.filter((dashboard) => dashboard.payload.day === day);
  if (today.length) return today.at(-1)!;
  const payload: DashboardPayload = { day, rows: recent[0]?.payload.rows || [] };
  const posted = await slack.chat.postMessage({
    channel: input.channel,
    text: renderDashboard(payload, input.now),
    metadata: { event_type: DASHBOARD_EVENT, event_payload: payload },
  });
  const ts = z.string().parse(posted.ts);
  const [first] = (await findDashboards(slack, { channel: input.channel, oldest: dayStart }))
    .filter((dashboard) => dashboard.payload.day === day)
    .reverse();
  if (first && first.ts !== ts) {
    await slack.chat.delete({ channel: input.channel, ts });
    return first;
  }
  return { ts, payload };
}

/** How often setRow writes a row another poster's edit dropped before it gives up. */
const ROW_WRITES = 3;

/**
 * Sets `signal`'s row on today's dashboard (todaysDashboard) to `state` and `text`, unless it
 * already says that. It reads the message back after its edit and writes again when the row is
 * missing or back to what it said before: another poster wrote the whole message from a copy read
 * before this edit. A different row for the same signal is a newer write of it (two deploys
 * finishing at once), which stands. After ROW_WRITES it throws. Returns the dashboard's ts, whose
 * thread holds today's pages.
 */
export async function setRow(
  slack: WebClient,
  input: { channel: string; now: Date; signal: string; state: RowState; text: string },
): Promise<string> {
  const { channel, now, signal } = input;
  const wanted = `${input.state} ${input.text}`;
  const said = (dashboard: Dashboard) => {
    const row = dashboard.payload.rows.find((existing) => existing.signal === signal);
    return row && `${row.state} ${row.text}`;
  };
  let dashboard = await todaysDashboard(slack, { channel, now });
  const before = said(dashboard);
  if (before === wanted) return dashboard.ts;
  for (let write = 0; write < ROW_WRITES; write++) {
    const payload: DashboardPayload = {
      ...dashboard.payload,
      rows: [
        ...dashboard.payload.rows.filter((existing) => existing.signal !== signal),
        { signal, state: input.state, text: input.text, at: now.toISOString() },
      ],
    };
    await slack.chat.update({
      channel,
      ts: dashboard.ts,
      text: renderDashboard(payload, now),
      metadata: { event_type: DASHBOARD_EVENT, event_payload: payload },
    });
    dashboard = await readDashboard(slack, { channel, ts: dashboard.ts });
    const after = said(dashboard);
    // this write, or a newer one of the same row by another poster: either stands
    if (after === wanted || (after && after !== before)) return dashboard.ts;
  }
  throw new Error(`the dashboard's ${signal} row did not hold after ${ROW_WRITES} writes`);
}

/** The dashboard at `ts`, read back with its metadata. */
async function readDashboard(
  slack: WebClient,
  input: { channel: string; ts: string },
): Promise<Dashboard> {
  const replies = await slack.conversations.replies({
    channel: input.channel,
    ts: input.ts,
    limit: 1,
    include_all_metadata: true,
  });
  const message = replies.messages?.find((reply) => reply.ts === input.ts);
  return { ts: input.ts, payload: DashboardPayload.parse(message?.metadata?.event_payload) };
}

/** The CLI command: the legacy pages of the last `sinceDays` (legacyPages), each line its ts and
 *  first line, edited resolved with `resolve`. */
export async function closeLegacyPages(options: { resolve?: boolean; sinceDays?: number }) {
  const pages = await legacyPages(getSlackClient(), {
    channel: slackChannelIds["#error-pulse"],
    sinceDays: options.sinceDays || 30,
    now: new Date(),
    resolve: Boolean(options.resolve),
  });
  return pages.join("\n") || "no legacy pages";
}

/**
 * The top-level pages this bot posted before the dashboard that still say 🚨 or 🔴, oldest first:
 * a page no poster's state or marker still names (an older format's, a lost state's) never
 * resolves on its own. With `resolve`, each is edited to say it is resolved, which notifies nobody.
 */
export async function legacyPages(
  slack: WebClient,
  input: { channel: string; sinceDays: number; now: Date; resolve: boolean },
) {
  const { bot_id: botId } = await slack.auth.test();
  const oldest = input.now.getTime() / 1000 - input.sinceDays * 86_400;
  const open: Array<{ ts: string; text: string }> = [];
  let cursor: string | undefined;
  do {
    const history = await slack.conversations.history({
      channel: input.channel,
      oldest: String(oldest),
      limit: 200,
      cursor,
    });
    for (const message of history.messages || []) {
      const reply = message.thread_ts && message.thread_ts !== message.ts;
      if (message.bot_id !== botId || reply || !message.ts) continue;
      if (/^(🚨|:rotating_light:|🔴|:red_circle:)/u.test(message.text || ""))
        open.push({ ts: message.ts, text: message.text || "" });
    }
    cursor = history.response_metadata?.next_cursor || undefined;
  } while (cursor);
  open.sort((a, b) => Number(a.ts) - Number(b.ts));
  if (input.resolve)
    for (const page of open)
      await slack.chat.update({
        channel: input.channel,
        ts: page.ts,
        text: markResolved(page.text.replace(/^(🔴|:red_circle:)\s*/u, "🚨 ")),
      });
  return open.map((page) => `${page.ts} ${page.text.split("\n")[0]}`);
}

void createCli(import.meta).run();
