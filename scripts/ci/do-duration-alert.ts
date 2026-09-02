// Hourly Durable Objects cost alarm (do-duration-probe.yml). Runs the
// duration probe (apps/os/scripts/do-duration-probe.ts) against both
// Cloudflare accounts and posts a Slack alert when either check trips:
// a pinned multi-hour invocation, or account-wide active time above the
// per-account ceiling. Exists because the 2026-09-01 preview stream-DO wake
// loop burned ~$300/hour for 28 hours before a human noticed it on the bill.
//
//   pnpm tsx scripts/ci/do-duration-alert.ts run
//   pnpm tsx scripts/ci/do-duration-alert.ts run --threshold-do-hours 1   # force an alert (Slack hookup test)
import { execFileSync } from "node:child_process";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
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

export async function run(options: {
  /** Override BOTH accounts' active-time ceiling (DO-hours/hour). Set very low
   * (e.g. 1) to force an alert and prove the Slack hookup end to end. */
  thresholdDoHours?: number;
}) {
  const override = options.thresholdDoHours;
  const failures: { label: string; output: string }[] = [];
  for (const account of ACCOUNTS) {
    const ceiling = override === undefined ? account.maxAccountDoHours : override;
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
          String(ceiling),
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

  if (failures.length === 0) return { breached: false };

  const slack = getSlackClient();
  // Absent outside GitHub Actions (local runs of this script).
  const runUrl = process.env.GITHUB_RUN_ID ? getRunUrl() : null;
  const testPrefix =
    override === undefined ? "" : `🧪 TEST RUN (threshold override ${override} DO-hours) — `;
  await slack.chat.postMessage({
    channel: slackChannelIds["#error-pulse"],
    text: [
      `${testPrefix}🚨 Durable Objects duration alarm: ${failures.map((f) => f.label).join(", ")}`,
      ...failures.map((f) => "```" + f.output.trim().slice(0, 2500) + "```"),
      runUrl ? `<${runUrl}|workflow run>` : null,
      "Runbook: apps/os/tasks/do-duration-leak/ — contain with `pnpm cli ice on --env <name>` (reversible freeze, PR #2579) or `pnpm erase-data --env preview_N` (previews only).",
    ]
      .filter(Boolean)
      .join("\n"),
  });
  // Throw (after the Slack post) so the workflow run goes red: trpc-cli exits
  // 0 on a normal return even with process.exitCode set — verified on the
  // 2026-09-02 dispatch test, where a breach concluded "success".
  throw new Error(
    `DO duration alarm breached (${failures.map((f) => f.label).join(", ")}); Slack alert posted`,
  );
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
