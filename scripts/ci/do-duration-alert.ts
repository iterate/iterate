// Hourly Durable Objects cost alarm (do-duration-probe.yml). Runs the
// duration probe (apps/os/scripts/do-duration-probe.ts --json) against both
// Cloudflare accounts and posts one concise Slack message PER BREACHED
// ACCOUNT — the account is the routing information an operator needs first.
// Exists because the 2026-09-01 preview stream-DO wake loop burned ~$300/hour
// for 28 hours before a human noticed it on the bill.
//
//   pnpm tsx scripts/ci/do-duration-alert.ts run
//   pnpm tsx scripts/ci/do-duration-alert.ts run --threshold-do-hours 1   # force an alert (Slack hookup test)
import { execFileSync } from "node:child_process";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import type { ProbeSummary } from "../../apps/os/scripts/do-duration-probe.ts";
import { getRunUrl } from "./github.ts";
import { getSlackClient, slackChannelIds } from "./slack.ts";

const DOCS_URL = "https://github.com/iterate/iterate/tree/main/apps/os/tasks/do-duration-leak";

const ACCOUNTS = [
  {
    dopplerConfig: "dev",
    label: "dev/preview",
    // Healthy baseline is <10 DO-hours/hour (previews idle between spec runs);
    // the incident ran 20,000-57,000. Plenty of headroom for legit spikes.
    maxAccountDoHours: 1000,
  },
  {
    dopplerConfig: "prd",
    label: "prd",
    // Baseline ~120 DO-hours/hour as of 2026-09-02 (chronic; see
    // apps/os/tasks/do-duration-leak/). Alert on ~3x that.
    maxAccountDoHours: 400,
  },
];

export async function run(options: {
  /** Override BOTH accounts' active-time ceiling (DO-hours/hour). Set very low
   * (e.g. 1) to force an alert and prove the Slack hookup end to end. */
  thresholdDoHours?: number;
}) {
  const override = options.thresholdDoHours;
  // Absent outside GitHub Actions (local runs of this script).
  const runUrl = process.env.GITHUB_RUN_ID ? getRunUrl() : null;
  const testPrefix = override === undefined ? "" : `🧪 TEST RUN — `;

  const alerts: string[] = [];
  for (const account of ACCOUNTS) {
    const ceiling = override === undefined ? account.maxAccountDoHours : override;
    let stdout = "";
    let breached = false;
    try {
      stdout = execFileSync(
        "doppler",
        // prettier-ignore
        [
          "run", "--project", "os", "--config", account.dopplerConfig, "--",
          "pnpm", "tsx", "apps/os/scripts/do-duration-probe.ts",
          "--hours", "3", "--max-account-do-hours", String(ceiling), "--json",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      );
    } catch (error: any) {
      breached = true;
      stdout = error.stdout || "";
    }
    const summary = parseSummary(stdout);
    if (summary === undefined) {
      // The probe crashed before printing its summary (bad creds, GraphQL
      // outage). Say so rather than silently skipping the account.
      alerts.push(
        `${testPrefix}🚨 DO duration probe FAILED to run. account: ${account.label}.\n` +
          `${links(runUrl)}`,
      );
      continue;
    }
    if (!breached) continue;
    alerts.push(formatAlert({ label: account.label, summary, testPrefix, runUrl }));
  }

  for (const text of alerts) console.log(`\n${text}\n`);
  if (alerts.length === 0) {
    console.log("✅ both accounts clean");
    return { breached: false };
  }

  const slack = getSlackClient();
  for (const text of alerts) {
    await slack.chat.postMessage({ channel: slackChannelIds["#error-pulse"], text });
  }
  // Throw (after the Slack posts) so the workflow run goes red: trpc-cli
  // exits 0 on a normal return even with process.exitCode set — verified on
  // the 2026-09-02 dispatch test, where a breach concluded "success".
  throw new Error(`DO duration alarm breached (${alerts.length} alert(s)); Slack alerts posted`);
}

function formatAlert(input: {
  label: string;
  summary: ProbeSummary;
  testPrefix: string;
  runUrl: string | null;
}) {
  const { activeTime, pinnedInvocations } = input.summary;
  const lines: string[] = [];
  const latestHour = activeTime.breachedHours.at(-1);
  if (latestHour) {
    lines.push(
      `${input.testPrefix}🚨 Durable Objects hours exceed threshold of ${activeTime.ceilingDoHours}. account: ${input.label}.`,
      `Latest: ${latestHour.hour}  ${latestHour.doHours} DO-hours (~$${Math.round(latestHour.doHours * 0.005625)}/h)`,
    );
  } else {
    // Only the pinned-invocation signature tripped (leaked RPC session).
    const worst = pinnedInvocations.rows[0]!;
    lines.push(
      `${input.testPrefix}🚨 Durable Object invocation pinned over ${pinnedInvocations.thresholdHours}h (leaked RPC session). account: ${input.label}.`,
      `Worst: ${worst.script}  wallTimeP99=${worst.wallTimeP99Hours}h  reqs=${worst.requests}`,
    );
  }
  if (latestHour && pinnedInvocations.rows.length > 0) {
    const worst = pinnedInvocations.rows[0]!;
    lines.push(`Also pinned: ${worst.script}  wallTimeP99=${worst.wallTimeP99Hours}h`);
  }
  lines.push(links(input.runUrl));
  return lines.join("\n");
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

function parseSummary(stdout: string) {
  const lastLine = stdout.trim().split("\n").at(-1) || "";
  try {
    // The probe's --json contract: its LAST stdout line is one ProbeSummary
    // (apps/os/scripts/do-duration-probe.ts prints it after the human report
    // moves to stderr). Anything else — a crash before the summary, a stray
    // line — fails JSON.parse and is reported as "probe FAILED to run" by the
    // caller, so a wrong shape cannot masquerade as a clean account.
    return JSON.parse(lastLine) as ProbeSummary;
  } catch {
    return undefined;
  }
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
