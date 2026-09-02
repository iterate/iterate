// Hourly Durable Objects cost alarm (do-duration-probe.yml). Runs the
// duration probe (apps/os/scripts/do-duration-probe.ts) against both
// Cloudflare accounts and posts a Slack alert when either check trips:
// a pinned multi-hour invocation, or account-wide active time above the
// per-account ceiling. Exists because the 2026-09-01 preview stream-DO wake
// loop burned ~$300/hour for 28 hours before a human noticed it on the bill.
import { execFileSync } from "node:child_process";
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import { getRunUrl } from "./github.ts";
import { getSlackClient, slackChannelIds } from "./slack.ts";

const ACCOUNTS = [
  {
    dopplerConfig: "dev",
    label: "dev/preview account",
    // Healthy baseline is <10 DO-hours/hour (previews idle between spec runs);
    // the incident ran 20,000-57,000. Plenty of headroom for legit spikes.
    maxAccountDoHours: 1000,
  },
  {
    dopplerConfig: "prd",
    label: "prd account",
    // Baseline ~120 DO-hours/hour as of 2026-09-02 (chronic; see
    // apps/os/tasks/do-duration-leak/). Alert on ~3x that.
    maxAccountDoHours: 400,
  },
];

export async function runDoDurationAlert() {
  const failures: { label: string; output: string }[] = [];
  for (const account of ACCOUNTS) {
    let output: string;
    let failed = false;
    try {
      output = execFileSync(
        "doppler",
        [
          "run",
          "--project",
          "os",
          "--config",
          account.dopplerConfig,
          "--",
          "pnpm",
          "tsx",
          "apps/os/scripts/do-duration-probe.ts",
          "--hours",
          "3",
          "--max-account-do-hours",
          String(account.maxAccountDoHours),
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error: any) {
      failed = true;
      output = [error.stdout, error.stderr].filter(Boolean).join("\n") || String(error);
    }
    console.log(`=== ${account.label} (${failed ? "BREACH" : "clean"}) ===\n${output}`);
    if (failed) failures.push({ label: account.label, output });
  }

  if (failures.length === 0) return;

  const slack = getSlackClient();
  // Absent outside GitHub Actions (local runs of this script).
  const runUrl = process.env.GITHUB_RUN_ID ? getRunUrl() : null;
  await slack.chat.postMessage({
    channel: slackChannelIds["#error-pulse"],
    text: [
      `🚨 Durable Objects duration alarm: ${failures.map((f) => f.label).join(", ")}`,
      ...failures.map((f) => "```" + f.output.trim().slice(0, 2500) + "```"),
      runUrl ? `<${runUrl}|workflow run>` : null,
      "Runbook: apps/os/tasks/do-duration-leak/ — contain with `pnpm erase-data --env preview_N` for runaway preview slots.",
    ]
      .filter(Boolean)
      .join("\n"),
  });
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  await runDoDurationAlert();
}
