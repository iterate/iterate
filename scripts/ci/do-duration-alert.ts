// Hourly Durable Objects cost alarm (do-duration-probe.yml). Runs the
// duration probe (apps/os/scripts/do-duration-probe.ts --json) against both
// Cloudflare accounts and keeps ONE Slack thread per UTC day in #error-pulse:
// the headline is rewritten every hour with each account's picture (latest
// hour, today's total, hours over the ceiling), and anything that needs a
// human — an hour over the ceiling, a probe that could not run — is a reply
// in that thread. The channel itself sees one message a day.
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
  console.log(`\n${thread.headline}\n`);
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
 * The day's Slack thread as text: a headline that is the whole picture at a
 * glance, and the replies this run has to add (only what a human should look
 * at now). Pure, so the wording is testable.
 */
export function renderDailyThread(input: {
  now: Date;
  readings: AccountReading[];
  runUrl: string | null;
  testRun: boolean;
}) {
  const date = input.now.toISOString().slice(0, 10);
  const time = input.now.toISOString().slice(11, 16);
  const recentSince = new Date(input.now.getTime() - RECENT_HOURS * 3600_000).toISOString();
  const testPrefix = input.testRun ? "🧪 TEST RUN — " : "";
  const usd = (doHours: number) =>
    `$${(doHours * USD_PER_DO_HOUR).toFixed(doHours * USD_PER_DO_HOUR < 10 ? 2 : 0)}`;
  const hourOf = (row: { hour: string; doHours: number }) =>
    `${row.hour.slice(11, 16)} → ${row.doHours.toLocaleString("en-US")} DO-hours (~${usd(row.doHours)}/h)`;

  const lines = [`${testPrefix}📒 Durable Objects — ${date} (UTC) · updated ${time}`];
  const replies: string[] = [];
  for (const reading of input.readings) {
    if (reading.summary === null) {
      lines.push(`${reading.label}: ⚠️ probe failed this run — ${reading.failure}`);
      replies.push(
        `${testPrefix}⚠️ DO duration probe FAILED to run. account: ${reading.label}.\n${reading.failure}\n${links(input.runUrl)}`,
      );
      continue;
    }
    const { activeTime, pinnedInvocations } = reading.summary;
    const today = activeTime.hours.filter((row) => row.hour.startsWith(date));
    const todayTotal = today.reduce((total, row) => total + row.doHours, 0);
    const breachedToday = activeTime.breachedHours.filter((row) => row.hour.startsWith(date));
    const recent = activeTime.breachedHours.filter((row) => row.hour >= recentSince);
    const latest = activeTime.hours.at(-1);
    const status = recent.length > 0 ? "🚨" : "✅";
    const parts = [
      `${reading.label}: ${status} ${latest ? hourOf(latest) : "no DO activity in the lookback"}`,
      `today ${todayTotal.toLocaleString("en-US")} DO-hours ≈ ${usd(todayTotal)}`,
      `${breachedToday.length}/${today.length} h over ${reading.ceilingDoHours}`,
    ];
    const pinned = pinnedInvocations.rows[0];
    if (pinned) parts.push(`pinned: ${pinned.script} P99=${pinned.wallTimeP99Hours}h`);
    lines.push(parts.join(" · "));

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
  lines.push(links(input.runUrl));
  return { date, headline: lines.join("\n"), replies };
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
 * the bot's own messages since 00:00 UTC whose text carries the day stamp
 * (Slack rewrites emoji as :shortcodes: in history, so the stamp is matched
 * without it). A forced-threshold test run keeps its own thread: it must
 * never rewrite the real day's headline with test text.
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
  const stamp = `Durable Objects — ${date}`;
  const existing = (history.messages || []).find(
    (message) =>
      message.bot_id &&
      message.ts &&
      message.text?.includes(stamp) &&
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
