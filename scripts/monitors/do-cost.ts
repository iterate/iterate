// Hourly Durable Objects cost alarm, one check of the health job (./health.ts). Runs the
// duration probe (scripts/monitors/do-duration-probe.ts `probeAccount`) against both
// Cloudflare accounts and keeps ONE Slack thread per UTC day in #ci, a routine post.
// The headline is one sentence, rewritten every hour: "We're spending $X/day on
// durable objects at 13:00's rate · today so far $Y". The thread's one reply is a
// line per account (the hour the headline used, today so far, the complete hours
// over the ceiling, 🔴 when any was), also rewritten every hour.
// In #error-pulse it sets its "DO cost" row on the daily dashboard every hour
// (`doCostRow`): the headline's $/day, red while an account's page is open.
// Only an account at its page tier reaches a human: ONE page per incident, a reply in
// today's dashboard thread with both mentions and the top spenders (../ci/slack.ts
// `postPage`). While it lasts, each run edits the page with the rate now and the peak;
// the first run at 2× and at 5× the page tier also replies in today's dashboard thread,
// with both mentions, naming the account. $50/h on either account is as urgent as prd
// being down: the page or reply that first reaches it is sent to the channel too. Two
// complete hours under the ceiling resolve it: an edit, which mentions nobody
// (../ci/slack.ts `resolvePage`). The probe's hourly series and the page's own text are
// the whole state: the page says the peak it has shown.
// It exists because a runaway Durable Object can cost hundreds of dollars an
// hour while every request stays green, and the bill shows it only days later.
// A health test page runs it with a ceiling of 1 DO-hour, which forces a page: the
// thread and the page both go to #ci, marked 🧪 TEST RUN, keep no state and set no row.
import type { WebClient } from "@slack/web-api";
import { cloudflareAccounts } from "../../envs.ts";
import { setRow, type RowState } from "../ci/dashboard.ts";
import {
  editPage,
  findOpenPages,
  getSlackClient,
  onCallMention,
  pageChannel,
  pageText,
  postPage,
  resolveOlderPages,
  resolvePage,
  slackChannelIds,
} from "../ci/slack.ts";
import { probeAccount, type ProbeSummary } from "./do-duration-probe.ts";

/** $12.50 per million GB-seconds at 128 MB: one DO-hour is 450 GB-s. */
const USD_PER_DO_HOUR = 0.005625;
/** Long enough that every hour of the current UTC day is in the summary. */
const LOOKBACK_HOURS = 26;
/** How far back a run looks for its account's open page: an incident longer than this is paged
 *  again, and that page resolves the account's older ones (EXPIRED_PAGE_HOURS). */
const OPEN_PAGE_HOURS = 48;
/** How far back a new page looks for its account's older open pages, which it resolves as expired. */
const EXPIRED_PAGE_HOURS = 30 * 24;
/** The rate whose first crossing, by a page or a reply, is sent to the channel too: spend that fast
 *  is as urgent as prd being down. dev/preview's 5× page tier. Dollars, not a multiple: prd's page
 *  tier is $0.06/h, so its 5× is $0.28/h. */
const CHANNEL_USD_PER_HOUR = 50;
/** Multiples of the page tier whose first crossing is a reply in today's dashboard thread. */
const ESCALATIONS = [2, 5];

export const ACCOUNTS = [
  {
    label: "dev/preview",
    cloudflare: cloudflareAccounts["dev/preview"],
    // Healthy is 0–100 DO-hours/hour, measured once previews stopped outliving
    // their run (iterate/iterate#2585); one preview relit by a finished run is 2,000–4,000.
    // The incident ran 20,000–57,000. ≈ $2.80/hour.
    maxAccountDoHours: 500,
    // ≈ 1,780 DO-hours/hour, 3.6× the ceiling: above every breach between the
    // 09-01 and 09-21 incidents (the worst, 09-04, ran ~1,160 ≈ $6.50/h); the
    // 09-21 os-next preview pin runaway ran $16/h in its second hour, $87/h
    // at its peak.
    pageUsdPerHour: 10,
  },
  {
    label: "prd",
    cloudflare: cloudflareAccounts.prd,
    // The account's hourly total, 2026-08-25..09-26: p50 1.0, p95 1.1, busiest
    // hour 1.7 DO-hours. Most of it is tunnels-prd's one CaptunServerShard
    // (another repo's Worker), awake while a tunnel is open; os-prd runs
    // 0.01–1. 2× the p95; the probe reads whole DO-hours, so a breach is an
    // hour of 2.5 or more. ≈ $0.01/hour.
    maxAccountDoHours: 2,
    // 5× the ceiling, about ten Durable Objects that never go idle: an alarm
    // loop or a pinned facet pages long before it costs money. ≈ $0.06/hour.
    pageUsdPerHour: 10 * USD_PER_DO_HOUR,
  },
];

export type AccountReading = {
  label: string;
  ceilingDoHours: number;
  /** Current usage at or above this pages. */
  pageUsdPerHour: number;
  summary: ProbeSummary | null;
  /** Why the probe could not run (bad credentials, a GraphQL outage). */
  failure: string | null;
};

/** Probe both accounts and upkeep the day's thread and the pages (postDailyThread). A test run
 *  overrides BOTH accounts' active-time ceiling with 1 DO-hour an hour, which forces a page and
 *  proves the Slack hookup end to end; a dry run prints the thread and posts nothing. */
export async function checkDoCost(options: { testRun: boolean; dryRun: boolean; runUrl?: string }) {
  const override = options.testRun ? 1 : undefined;
  const runUrl = options.runUrl || null;
  const now = new Date();

  const readings: AccountReading[] = [];
  for (const account of ACCOUNTS) {
    const ceilingDoHours = override === undefined ? account.maxAccountDoHours : override;
    readings.push({
      label: account.label,
      ceilingDoHours,
      // A forced-threshold test run pages at 10× its tiny ceiling, so the
      // Slack hookup test exercises the page too.
      pageUsdPerHour:
        override === undefined ? account.pageUsdPerHour : override * 10 * USD_PER_DO_HOUR,
      // A probe that cannot run is a reading too: said so, never taken for a quiet account.
      ...(await probeAccount({
        account: account.cloudflare,
        hours: LOOKBACK_HOURS,
        maxAccountDoHours: ceilingDoHours,
      }).then(
        (summary) => ({ summary, failure: null }),
        (error: unknown) => ({
          summary: null,
          failure: String(error instanceof Error ? error.message : error).slice(0, 200),
        }),
      )),
    });
  }

  if (options.dryRun) {
    const thread = renderDailyThread({ now, readings, runUrl, testRun: options.testRun });
    return console.log(
      [
        thread.headline,
        thread.details,
        ...thread.accounts
          .filter((account) => tier(account, account.doHoursPerHour) > 0)
          .map((account) =>
            renderPage({ account, peak: account, runUrl, testRun: options.testRun }),
          ),
      ].join("\n\n"),
    );
  }
  return await postDailyThread({
    slack: getSlackClient(),
    now,
    readings,
    runUrl,
    testRun: options.testRun,
  });
}

/**
 * Upkeeps each account's page, then the day's thread, then (on a real run) the dashboard's DO cost
 * row (`doCostRow`), then ends. A page ends it quietly: the page is the alarm. A probe that could
 * not run throws once the thread and the row say so, so a broken token never passes for a quiet
 * account; so does any Slack error. The health job fails its run on either, after its other checks.
 * Returns what each account's page did.
 */
export async function postDailyThread(input: {
  slack: WebClient;
  now: Date;
  readings: AccountReading[];
  runUrl: string | null;
  testRun: boolean;
}) {
  const { slack, now, testRun } = input;
  const channel = slackChannelIds["#ci"];
  const thread = renderDailyThread(input);
  console.log(`\n${thread.headline}\n\n${thread.details}\n`);

  // Pages first: a Slack error in the thread upkeep below must not swallow one.
  const pages: Array<{ label: string; action: PageAction["kind"] }> = [];
  for (const account of thread.accounts) {
    const action = await upkeepPage({ slack, now, account, runUrl: input.runUrl, testRun });
    pages.push({ label: account.label, action });
  }
  const headlineTs = await findOrCreateHeadline({
    slack,
    channel,
    now,
    headline: thread.headline,
    testRun,
  });
  await upsertDetailsReply({ slack, channel, headlineTs, details: thread.details });
  await slack.chat.update({ channel, ts: headlineTs, text: thread.headline });
  if (!testRun)
    await setRow(slack, {
      channel: slackChannelIds["#error-pulse"],
      now,
      signal: "DO cost",
      ...doCostRow({ ...thread, readings: input.readings, pages }),
    });

  const unmeasured = input.readings.flatMap((reading) =>
    reading.summary ? [] : [`${reading.label}: ${reading.failure}`],
  );
  // A throw, because trpc-cli exits 0 on a normal return even with process.exitCode set (the
  // 2026-09-02 dispatch test, where a breach concluded "success").
  if (unmeasured.length > 0)
    throw new Error(`DO duration probe could not run: ${unmeasured.join("; ")}`);
  console.log(`DO cost pages: ${pages.map((page) => `${page.label} ${page.action}`).join(", ")}`);
  return { pages };
}

/** One measured account as this run judged it. */
export type AccountNow = {
  label: string;
  ceilingDoHours: number;
  pageUsdPerHour: number;
  /** Current usage, whole DO-hours an hour: the last complete hour, or this partial hour projected
   *  to a full one if that is higher. */
  doHoursPerHour: number;
  /** The hour that rate is from ("13:00"), and whether it is this partial hour projected; null when
   *  neither hour has a row, which means nothing ran. */
  basis: { hour: string; projected: boolean } | null;
  todayDoHours: number;
  /** Today's complete hours, and how many of them were over the ceiling. */
  completeHoursToday: number;
  overToday: number;
  /** The two complete hours before this one and the rate now are all under the ceiling. */
  underCeilingSince: string | null;
  topNamespaces: Array<{ namespace: string; doHours: number }>;
  /** Today's invocations pinned longer than the probe's --threshold-hours. */
  pinnedToday: string[];
};

/**
 * The day's Slack thread as text: the one-sentence headline, the reply with a line per account,
 * each measured account as this run judged it, for its page, and the $/day the headline and the
 * dashboard's row share. Pure, so the wording is testable.
 */
export function renderDailyThread(input: {
  now: Date;
  readings: AccountReading[];
  runUrl: string | null;
  testRun: boolean;
}) {
  const date = input.now.toISOString().slice(0, 10);
  const testPrefix = input.testRun ? "🧪 TEST RUN — " : "";

  const accounts: AccountNow[] = [];
  const perAccount: string[] = [];
  const lines: string[] = [];
  for (const reading of input.readings) {
    if (!reading.summary) {
      perAccount.push(`${reading.label}: probe failed`);
      lines.push(`⚠️ ${reading.label}: probe failed: ${reading.failure}`);
      continue;
    }
    const account = judge(reading, reading.summary, input.now);
    accounts.push(account);
    perAccount.push(`${money(usdPerDay(account.doHoursPerHour))} ${reading.label}`);
    lines.push(accountLine(account));
  }

  const usdNowPerDay = accounts.reduce(
    (total, account) => total + usdPerDay(account.doHoursPerHour),
    0,
  );
  const todayUsd =
    accounts.reduce((total, account) => total + account.todayDoHours, 0) * USD_PER_DO_HOUR;
  const bases = new Set(accounts.flatMap((account) => (account.basis ? [account.basis.hour] : [])));
  const basis =
    bases.size > 1
      ? "the latest hour's rate"
      : `${[...bases][0] || hourOf(new Date(input.now.getTime() - 3600_000))}'s rate`;
  const perDay = `${money(usdNowPerDay)}/day`;
  const headline = `${testPrefix}We're spending ${perDay} on durable objects at ${basis} · today so far ${money(todayUsd)} (${perAccount.join(", ")})`;
  const details = [`${DETAILS_TITLE}, ${date} UTC`, ...lines, links(input.runUrl)].join("\n");
  return { date, headline, details, accounts, perDay };
}

/** The dashboard's DO cost row: the headline's $/day, red while an account's page is open (this
 *  run posted or edited it), grey when an account's probe could not run, amber when an account had
 *  a complete hour over its ceiling today, green otherwise. Pure. */
function doCostRow(input: {
  perDay: string;
  readings: AccountReading[];
  accounts: AccountNow[];
  pages: Array<{ label: string; action: PageAction["kind"] }>;
}): { state: RowState; text: string } {
  const paged = input.pages.filter((page) => page.action === "post" || page.action === "edit");
  if (paged.length > 0)
    return {
      state: "red",
      text: `${input.perDay} · paged: ${paged.map((page) => page.label).join(", ")}`,
    };
  const failed = input.readings.filter((reading) => !reading.summary);
  if (failed.length > 0)
    return {
      state: "grey",
      text: `${input.perDay} · probe failed: ${failed.map((reading) => reading.label).join(", ")}`,
    };
  const over = input.accounts.filter((account) => account.overToday > 0);
  if (over.length > 0)
    return {
      state: "amber",
      text: `${input.perDay} · over its ceiling today: ${over.map((account) => `${account.label} ${account.overToday} h`).join(", ")}`,
    };
  return { state: "green", text: input.perDay };
}

/** The details reply's first words; also how the reply is recognised in the thread. */
const DETAILS_TITLE = "DO cost by account";

function judge(reading: AccountReading, summary: ProbeSummary, now: Date): AccountNow {
  const { activeTime, pinnedInvocations } = summary;
  const date = now.toISOString().slice(0, 10);
  const hourAgo = (hours: number) =>
    new Date(now.getTime() - hours * 3600_000).toISOString().slice(0, 13);
  const doHoursAt = (hour: string) =>
    activeTime.hours.find((row) => row.hour.startsWith(hour))?.doHours || 0;
  // Rows exist only for hours with activity: no row means nothing ran in that hour. The projection
  // divides by at least 30 minutes, so a dispatch early in the hour cannot turn a few minutes'
  // burst into a page; analytics lag only makes it low.
  const lastComplete = doHoursAt(hourAgo(1));
  const projected = Math.floor((doHoursAt(hourAgo(0)) * 60) / Math.max(now.getUTCMinutes(), 30));
  const doHoursPerHour = Math.max(lastComplete, projected);
  const basis =
    doHoursPerHour === 0
      ? null
      : projected > lastComplete
        ? { hour: hourOf(now), projected: true }
        : { hour: hourOf(new Date(now.getTime() - 3600_000)), projected: false };
  const currentHour = hourAgo(0);
  const completeToday = activeTime.hours.filter(
    (row) => row.hour.startsWith(date) && row.hour < currentHour,
  );
  const under = (doHours: number) => doHours <= reading.ceilingDoHours;
  return {
    label: reading.label,
    ceilingDoHours: reading.ceilingDoHours,
    pageUsdPerHour: reading.pageUsdPerHour,
    doHoursPerHour,
    basis,
    todayDoHours: activeTime.hours
      .filter((row) => row.hour.startsWith(date))
      .reduce((total, row) => total + row.doHours, 0),
    completeHoursToday: now.getUTCHours(),
    overToday: completeToday.filter((row) => !under(row.doHours)).length,
    underCeilingSince:
      under(doHoursAt(hourAgo(2))) && under(lastComplete) && under(doHoursPerHour)
        ? hourOf(new Date(now.getTime() - 2 * 3600_000))
        : null,
    topNamespaces: activeTime.topNamespaces,
    pinnedToday: pinnedInvocations.rows
      .filter((row) => row.date === date)
      .map(
        (row) =>
          `${row.script} P99 ${row.wallTimeP99Hours} h > ${pinnedInvocations.thresholdHours} h`,
      ),
  };
}

/** One account's line in the details reply, short enough for a phone. */
function accountLine(account: AccountNow) {
  const rate = account.basis
    ? `${account.basis.hour}${account.basis.projected ? " (projected)" : ""} → ${account.doHoursPerHour.toLocaleString("en-US")} DO-hours (~${money(usd(account.doHoursPerHour))}/h)`
    : "idle";
  return [
    `${account.overToday > 0 ? "🔴 " : ""}${account.label}: ${rate}`,
    `today ${account.todayDoHours.toLocaleString("en-US")} ≈ ${money(usd(account.todayDoHours))}`,
    `${account.overToday} of ${account.completeHoursToday} h over ${account.ceilingDoHours}`,
    ...account.pinnedToday.map((pinned) => `pinned: ${pinned}`),
  ].join(" · ");
}

/** What one run does to an account's page. A post and an escalation are sent to the channel too
 *  when `broadcast`. */
export type PageAction =
  | { kind: "none" }
  | { kind: "post"; text: string; broadcast: boolean }
  | {
      kind: "edit";
      ts: string;
      text: string;
      escalation: { text: string; broadcast: boolean } | null;
    }
  | { kind: "resolve"; ts: string; text: string; why: string };

/**
 * One incident per account: none open and at the page tier posts a page; open and under the ceiling
 * for two complete hours resolves it; open otherwise edits it with the rate now and the peak it has
 * shown, and the first run past 2× or 5× the page tier also replies. The page or reply that first
 * reaches CHANNEL_USD_PER_HOUR is sent to the channel too (a reply of its own when no tier is
 * crossed with it). `open` is the page as Slack's history
 * returns it. Pure.
 */
export function decidePage(input: {
  account: AccountNow;
  open: { ts: string; text: string } | undefined;
  runUrl: string | null;
}): PageAction {
  const { account, open, runUrl } = input;
  if (!open) {
    const reached = tier(account, account.doHoursPerHour);
    if (reached === 0) return { kind: "none" };
    return {
      kind: "post",
      text: renderPage({ account, peak: account, runUrl, testRun: false }),
      broadcast: loud(account.doHoursPerHour),
    };
  }
  if (account.underCeilingSince)
    return {
      kind: "resolve",
      ts: open.ts,
      text: open.text,
      why: `back under ${account.ceilingDoHours} DO-hours/h since ${account.underCeilingSince}`,
    };
  const shown = Number(/peak ([\d,]+) DO-hours\/h/.exec(open.text)?.[1]?.replaceAll(",", "") || 0);
  const peak = Math.max(shown, account.doHoursPerHour);
  const crossed = tier(account, account.doHoursPerHour);
  const louder = loud(account.doHoursPerHour) && !loud(shown);
  return {
    kind: "edit",
    ts: open.ts,
    text: renderPage({ account, peak: { doHoursPerHour: peak }, runUrl, testRun: false }),
    escalation:
      (crossed > 1 && crossed > tier(account, shown)) || louder
        ? {
            text: `🚨 DO cost for ${account.label} passed ${crossed}× its page tier: ~${money(usd(account.doHoursPerHour))}/h (≈ ${money(usdPerDay(account.doHoursPerHour))}/day) ${onCallMention}`,
            broadcast: louder,
          }
        : null,
  };
}

/** Whether `doHours` an hour costs CHANNEL_USD_PER_HOUR or more, with tier's float tolerance. */
function loud(doHours: number) {
  return usd(doHours) >= CHANNEL_USD_PER_HOUR * (1 - 1e-9);
}

/** The highest of 1 (the page tier) and ESCALATIONS that `doHours` an hour reaches; 0 under it. */
function tier(account: AccountNow, doHours: number) {
  // The page tier is a product of the same float constant, so an exact multiple can land one ulp
  // under it.
  return (
    [1, ...ESCALATIONS].findLast(
      (multiple) => usd(doHours) >= multiple * account.pageUsdPerHour * (1 - 1e-9),
    ) || 0
  );
}

/** The account's page as it reads now. `peak` is the highest rate the page has shown: the page
 *  keeps it in its text, which is how the next run knows which escalations it has sent. */
function renderPage(input: {
  account: AccountNow;
  peak: { doHoursPerHour: number };
  runUrl: string | null;
  testRun: boolean;
}) {
  const { account } = input;
  const rate = account.doHoursPerHour;
  const peak = input.peak.doHoursPerHour;
  const spenders = account.topNamespaces
    .slice(0, 3)
    .map((row) => `${row.namespace} ~${money(usd(row.doHours))}/h`);
  return pageText({
    // "DO cost page for <label>:" is how findOpenPages finds it.
    what: `DO cost page for ${account.label}: ~${money(usd(rate))}/h (≈ ${money(usdPerDay(rate))}/day), ${(rate / account.ceilingDoHours).toFixed(1)}× the ceiling`,
    impact: [
      `peak ${peak.toLocaleString("en-US")} DO-hours/h (~${money(usd(peak))}/h)`,
      spenders.length > 0 ? `top spenders, trailing hour: ${spenders.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("; "),
    action: "stop the top spender: find its preview or pinned facet",
    link: input.runUrl,
    testRun: input.testRun,
  });
}

/**
 * Runs the account's page decision: a page and an escalation are replies in today's dashboard
 * thread (../ci/slack.ts `postPage`). A test run keeps no state: it posts the page to #ci, top-level,
 * whenever the account is at its page tier and never reads #error-pulse. An escalation is posted
 * before the edit that records its peak, so a failed post is owed again by the next run. A new page
 * first resolves the account's older open pages as expired: an incident past OPEN_PAGE_HOURS keeps
 * one open page.
 */
async function upkeepPage(input: {
  slack: WebClient;
  now: Date;
  account: AccountNow;
  runUrl: string | null;
  testRun: boolean;
}): Promise<PageAction["kind"]> {
  const { slack, account, testRun, now } = input;
  const channel = pageChannel(testRun);
  if (testRun) {
    if (tier(account, account.doHoursPerHour) === 0) return "none";
    const text = renderPage({ account, peak: account, runUrl: input.runUrl, testRun });
    await postPage(slack, { channel, text, broadcast: false, now });
    return "post";
  }
  const marker = `DO cost page for ${account.label}:`;
  const [open] = await findOpenPages(slack, { channel, marker, sinceHours: OPEN_PAGE_HOURS, now });
  const action = decidePage({ account, open, runUrl: input.runUrl });
  if (action.kind === "post") {
    const expired = await findOpenPages(slack, {
      channel,
      marker,
      sinceHours: EXPIRED_PAGE_HOURS,
      now,
    });
    await resolveOlderPages(slack, { channel, pages: expired, now });
    await postPage(slack, { channel, text: action.text, broadcast: action.broadcast, now });
  }
  if (action.kind === "resolve")
    await resolvePage(slack, { channel, ts: action.ts, text: action.text, why: action.why, now });
  if (action.kind === "edit") {
    if (action.escalation) await postPage(slack, { channel, ...action.escalation, now });
    await editPage(slack, { channel, ts: action.ts, text: action.text, now });
  }
  return action.kind;
}

/** "13:00" for the UTC hour `at` is in. */
function hourOf(at: Date) {
  return `${at.toISOString().slice(11, 13)}:00`;
}

function usd(doHours: number) {
  return doHours * USD_PER_DO_HOUR;
}

function usdPerDay(doHoursPerHour: number) {
  return usd(doHoursPerHour * 24);
}

/** Dollars: whole dollars, cents only under $10, $0 when nothing. */
function money(usdAmount: number) {
  if (usdAmount === 0) return "$0";
  if (usdAmount < 10) return `$${usdAmount.toFixed(2)}`;
  return `$${Math.round(usdAmount).toLocaleString("en-US")}`;
}

function links(runUrl: string | null) {
  return [
    `<https://github.com/iterate/iterate/blob/main/docs/depot-ci.md#health|how this alarm works>`,
    runUrl ? `<${runUrl}|run>` : null,
    "($12.50/M GB-s, 1000 DO-hours ≈ $5.60)",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Today's headline message, created on the day's first run. Found by text:
 * the bot's own messages since 00:00 UTC that read "We're spending …"
 * (Slack rewrites emoji as :shortcodes: in history, so the test-run prefix
 * is matched by its words), read page by page: #ci takes every pull request
 * event and deploy, far more than one page a day. A forced-threshold test run
 * keeps its own thread: it must never rewrite the real day's headline with
 * test text.
 */
async function findOrCreateHeadline(input: {
  slack: WebClient;
  channel: string;
  now: Date;
  headline: string;
  testRun: boolean;
}): Promise<string> {
  const date = input.now.toISOString().slice(0, 10);
  const dayStart = Date.parse(`${date}T00:00:00Z`) / 1000;
  let cursor: string | undefined;
  do {
    const history = await input.slack.conversations.history({
      channel: input.channel,
      oldest: String(dayStart),
      limit: 200,
      cursor,
    });
    const existing = (history.messages || []).find(
      (message) =>
        message.bot_id &&
        message.ts &&
        message.text?.includes("spending") &&
        message.text.includes("/day on durable objects") &&
        message.text.includes("TEST RUN") === input.testRun,
    );
    if (existing?.ts) return existing.ts;
    cursor = history.response_metadata?.next_cursor || undefined;
  } while (cursor);
  const posted = await input.slack.chat.postMessage({
    channel: input.channel,
    text: input.headline,
  });
  if (!posted.ts) throw new Error("Slack accepted the headline but returned no ts");
  return posted.ts;
}

/**
 * The thread's one reply is the line per account: posted on the day's first run, rewritten in
 * place on every run after. Recognised among the bot's replies by its first words.
 */
export async function upsertDetailsReply(input: {
  slack: WebClient;
  channel: string;
  headlineTs: string;
  details: string;
}) {
  const replies = await input.slack.conversations.replies({
    channel: input.channel,
    ts: input.headlineTs,
    limit: 200,
  });
  const existing = (replies.messages || []).find(
    (message) =>
      message.bot_id && message.ts !== input.headlineTs && message.text?.startsWith(DETAILS_TITLE),
  );
  if (existing?.ts) {
    await input.slack.chat.update({ channel: input.channel, ts: existing.ts, text: input.details });
    return;
  }
  await input.slack.chat.postMessage({
    channel: input.channel,
    thread_ts: input.headlineTs,
    text: input.details,
  });
}
