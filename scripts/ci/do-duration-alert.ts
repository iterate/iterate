// Hourly Durable Objects cost alarm (do-duration-probe.yml). Runs the
// duration probe (apps/os/scripts/do-duration-probe.ts --json) against both
// Cloudflare accounts and keeps ONE Slack thread per UTC day in #error-pulse.
// The headline is one sentence, rewritten every hour: "We're spending $X/day
// on durable objects based on current usage ($A dev/preview, $B prd)". The
// thread's first reply is the per-account table (latest hour, today so far,
// hours over the ceiling, pinned invocations), also rewritten every hour;
// anything that needs a human — an hour over the ceiling, a probe that could
// not run — is a further reply. The channel itself sees one message a day.
// Exists because the 2026-09-01 preview stream-DO wake loop burned ~$300/hour
// for 28 hours before a human noticed it on the bill.
//
//   pnpm tsx scripts/ci/do-duration-alert.ts run
//   pnpm tsx scripts/ci/do-duration-alert.ts run --threshold-do-hours 1   # force an alert (Slack hookup test)
import { execFileSync } from "node:child_process";
import type { WebClient } from "@slack/web-api";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import type { ProbeSummary } from "../../apps/os/scripts/do-duration-probe.ts";
import { getRunUrl } from "./github.ts";
import { getSlackClient, slackChannelIds } from "./slack.ts";

const DOCS_URL = "https://github.com/iterate/iterate/tree/main/apps/os/tasks/do-duration-leak";
/** $12.50 per million GB-seconds at 128 MB: one DO-hour is 450 GB-s. */
const USD_PER_DO_HOUR = 0.005625;
/** The probe runs at :41 and analytics lag ~15–20 minutes, so the previous
 * hour is complete and the current one partial: a breach in either is "now".
 * Older breaches are today's history — in the headline, not re-alerted. */
const RECENT_HOURS = 2;
/** Long enough that every hour of the current UTC day is in the summary. */
const LOOKBACK_HOURS = 26;

const ACCOUNTS = [
  {
    dopplerConfig: "dev",
    label: "dev/preview",
    // Healthy is 0–100 DO-hours/hour now that preview slots are erased after
    // every run (#2585); one slot relit by a finished run is 2,000–4,000. The
    // incident ran 20,000–57,000. ≈ $2.80/hour.
    maxAccountDoHours: 500,
  },
  {
    dopplerConfig: "prd",
    label: "prd",
    // Pre-incident baseline ~100 DO-hours/hour. Since 2026-09-03 11:00 the
    // standalone project-worker/IterateContextDurableObject sits ~540 on top
    // (not this repo's; routed to its owner) — ≈ $3/hour, visible in the
    // headline every hour without a reply. ≈ $3.40/hour ceiling.
    maxAccountDoHours: 600,
  },
];

export type AccountReading = {
  label: string;
  ceilingDoHours: number;
  summary: ProbeSummary | null;
  /** Why the probe printed no summary (bad creds, GraphQL outage). */
  failure: string | null;
};

export async function run(options: {
  /** Override BOTH accounts' active-time ceiling (DO-hours/hour). Set very low
   * (e.g. 1) to force an alert and prove the Slack hookup end to end. */
  thresholdDoHours?: number;
}) {
  const override = options.thresholdDoHours;
  // Absent outside GitHub Actions (local runs of this script).
  const runUrl = process.env.GITHUB_RUN_ID ? getRunUrl() : null;
  const now = new Date();

  const readings: AccountReading[] = [];
  for (const account of ACCOUNTS) {
    const ceilingDoHours = override === undefined ? account.maxAccountDoHours : override;
    readings.push({
      label: account.label,
      ceilingDoHours,
      ...probe(account.dopplerConfig, ceilingDoHours),
    });
  }

  const thread = renderDailyThread({ now, readings, runUrl, testRun: override !== undefined });
  console.log(`\n${thread.headline}\n\n${thread.details}\n`);
  for (const reply of thread.replies) console.log(`\n${reply}\n`);

  const slack = getSlackClient();
  const channel = slackChannelIds["#error-pulse"];
  const headlineTs = await findOrCreateHeadline({
    slack,
    channel,
    now,
    headline: thread.headline,
    testRun: override !== undefined,
  });
  await upsertDetailsReply({ slack, channel, headlineTs, details: thread.details });
  for (const text of thread.replies) {
    await slack.chat.postMessage({ channel, thread_ts: headlineTs, text });
  }
  await slack.chat.update({ channel, ts: headlineTs, text: thread.headline });

  if (thread.replies.length === 0) {
    console.log("✅ both accounts under their ceilings; headline updated");
    return { breached: false };
  }
  // Throw (after the Slack posts) so the workflow run goes red: trpc-cli
  // exits 0 on a normal return even with process.exitCode set — verified on
  // the 2026-09-02 dispatch test, where a breach concluded "success".
  throw new Error(
    `DO duration alarm: ${thread.replies.length} alert(s) posted to the daily thread`,
  );
}

function probe(dopplerConfig: string, ceilingDoHours: number) {
  let stdout = "";
  let stderr = "";
  try {
    stdout = execFileSync(
      "doppler",
      // prettier-ignore
      [
        "run", "--project", "os", "--config", dopplerConfig, "--",
        "pnpm", "tsx", "apps/os/scripts/do-duration-probe.ts",
        "--hours", String(LOOKBACK_HOURS), "--max-account-do-hours", String(ceilingDoHours), "--json",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error: any) {
    // The probe exits non-zero on a breach AND on a crash; the summary line
    // below tells them apart.
    stdout = error.stdout || "";
    stderr = error.stderr || "";
  }
  if (stderr) console.error(stderr);
  const lastLine = stdout.trim().split("\n").at(-1) || "";
  try {
    // The probe's --json contract: its LAST stdout line is one ProbeSummary
    // (apps/os/scripts/do-duration-probe.ts prints it after the human report
    // moves to stderr). Anything else — a crash before the summary, a stray
    // line — fails JSON.parse and is reported as a probe failure, so a wrong
    // shape cannot masquerade as a clean account.
    return { summary: JSON.parse(lastLine) as ProbeSummary, failure: null };
  } catch {
    const reason = stderr.trim().split("\n").filter(Boolean).at(-1) || "printed no summary";
    return { summary: null, failure: reason.slice(0, 200) };
  }
}

/**
 * The day's Slack thread as text: the one-sentence headline, the per-account
 * details table that lives in the thread's first reply, and the alert replies
 * this run has to add (only what a human should look at now). Pure, so the
 * wording is testable.
 */
export function renderDailyThread(input: {
  now: Date;
  readings: AccountReading[];
  runUrl: string | null;
  testRun: boolean;
}) {
  const date = input.now.toISOString().slice(0, 10);
  // The probe runs at :41 and analytics lag ~15–20 minutes, so the current
  // hour is always partial: "current usage" is the last complete hour.
  const lastCompleteHour = new Date(input.now.getTime() - 3600_000).toISOString().slice(0, 13);
  const recentSince = new Date(input.now.getTime() - RECENT_HOURS * 3600_000).toISOString();
  const testPrefix = input.testRun ? "🧪 TEST RUN — " : "";
  const hourOf = (row: { hour: string; doHours: number }) =>
    `${row.hour.slice(11, 16)} → ${row.doHours.toLocaleString("en-US")} (~${usd(row.doHours)}/h)`;

  let usdPerDay = 0;
  const perAccount: string[] = [];
  const tableRows: string[][] = [];
  const replies: string[] = [];
  for (const reading of input.readings) {
    if (reading.summary === null) {
      perAccount.push(`${reading.label}: probe failed`);
      tableRows.push([reading.label, `probe failed: ${reading.failure}`]);
      replies.push(
        `${testPrefix}⚠️ DO duration probe FAILED to run. account: ${reading.label}.\n${reading.failure}\n${links(input.runUrl)}`,
      );
      continue;
    }
    const { activeTime, pinnedInvocations } = reading.summary;
    // Rows exist only for hours with activity: no row for the last complete
    // hour means nothing ran in it (dev/preview overnight, slots erased).
    const current = activeTime.hours.find((row) => row.hour.startsWith(lastCompleteHour));
    const accountUsdPerDay = (current ? current.doHours : 0) * 24 * USD_PER_DO_HOUR;
    usdPerDay += accountUsdPerDay;
    perAccount.push(`${money(accountUsdPerDay)} ${reading.label}`);

    const today = activeTime.hours.filter((row) => row.hour.startsWith(date));
    const todayTotal = today.reduce((total, row) => total + row.doHours, 0);
    const breachedToday = activeTime.breachedHours.filter((row) => row.hour.startsWith(date));
    const recent = activeTime.breachedHours.filter((row) => row.hour >= recentSince);
    const latest = activeTime.hours.at(-1);
    const pinned = pinnedInvocations.rows[0];
    tableRows.push([
      reading.label,
      latest ? hourOf(latest) : "no activity in the lookback",
      `${todayTotal.toLocaleString("en-US")} ≈ ${usd(todayTotal)}`,
      `${breachedToday.length}/${today.length} over ${reading.ceilingDoHours}`,
      pinned ? `${pinned.script} P99=${pinned.wallTimeP99Hours}h` : "—",
    ]);

    const worst = recent.at(-1);
    if (worst) {
      replies.push(
        [
          `${testPrefix}🚨 Durable Objects hours over ${reading.ceilingDoHours}. account: ${reading.label}.`,
          `Latest: ${hourOf(worst)}`,
          pinned ? `Also pinned: ${pinned.script}  wallTimeP99=${pinned.wallTimeP99Hours}h` : null,
          links(input.runUrl),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  const headline = `${testPrefix}We're spending ${money(usdPerDay)}/day on durable objects based on current usage (${perAccount.join(", ")})`;
  const details = [
    "```",
    ...table([DETAILS_HEADER, ...tableRows]),
    "```",
    links(input.runUrl),
  ].join("\n");
  return { date, headline, details, replies };
}

/** The details table's header row. */
const DETAILS_HEADER = [
  "account",
  "latest hour",
  "today (DO-hours)",
  "hours over ceiling",
  "pinned invocations",
];

/**
 * How the details reply is recognised among the bot's replies in the thread:
 * by two of its header words. Not by the header row itself, because `table`
 * pads each column to its widest cell, so the spacing changes with the data.
 */
export function isDetailsReply(text: string) {
  return text.includes("today (DO-hours)") && text.includes("hours over ceiling");
}

/** Rows padded into aligned columns for a Slack code block. */
function table(rows: string[][]) {
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] || "").length)),
  );
  return rows.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join("  ")
      .trimEnd(),
  );
}

/** Dollars for a headline: whole dollars, cents only under $10, $0 when nothing. */
function money(usdAmount: number) {
  if (usdAmount === 0) return "$0";
  if (usdAmount < 10) return `$${usdAmount.toFixed(2)}`;
  return `$${Math.round(usdAmount).toLocaleString("en-US")}`;
}

/** Dollars for a DO-hours figure inside the table. */
function usd(doHours: number) {
  const usdAmount = doHours * USD_PER_DO_HOUR;
  return `$${usdAmount.toFixed(usdAmount < 10 ? 2 : 0)}`;
}

function links(runUrl: string | null) {
  return [
    `<${DOCS_URL}|incident docs>`,
    runUrl ? `<${runUrl}|workflow run>` : null,
    "($12.50/M GB-s, 1000 DO-hours ≈ $5.60)",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Today's headline message, created on the day's first run. Found by text:
 * the bot's own messages since 00:00 UTC that read "We're spending …"
 * (Slack rewrites emoji as :shortcodes: in history, so the test-run prefix
 * is matched by its words). A forced-threshold test run keeps its own thread:
 * it must never rewrite the real day's headline with test text.
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
  const history = await input.slack.conversations.history({
    channel: input.channel,
    oldest: String(dayStart),
    limit: 200,
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
  const posted = await input.slack.chat.postMessage({
    channel: input.channel,
    text: input.headline,
  });
  if (!posted.ts) throw new Error("Slack accepted the headline but returned no ts");
  return posted.ts;
}

/**
 * The thread's first reply is the per-account table: posted on the day's
 * first run, rewritten in place on every run after.
 */
async function upsertDetailsReply(input: {
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
      message.bot_id &&
      message.ts !== input.headlineTs &&
      message.text !== undefined &&
      isDetailsReply(message.text),
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

if (isMainModule(import.meta.url)) {
  void createCli({
    ...import.meta,
    name: "do-duration-alert",
    jsonInput: "auto",
  }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
