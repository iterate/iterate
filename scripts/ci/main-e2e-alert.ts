// scripts/ci/main-e2e-alert.ts — THE PAGE FOR MAIN'S E2E RUN (.depot/workflows/main-os-e2e.yml): every
// push to main deploys a throwaway preview, runs the e2e suite and the browser specs against it, and
// deletes it. This posts to #error-pulse only when main CHANGES state: once when it goes red (naming
// the failed jobs and the failing rows), once when it is green again. A red that stays red, and every
// green, post nothing. The last page in the channel is the state: nothing long-lived is kept anywhere
// else.
//
//   pnpm tsx scripts/ci/main-e2e-alert.ts failing-rows --dir test-results/ci-telemetry/raw
//   NEEDS='${{ toJSON(needs) }}' pnpm tsx scripts/ci/main-e2e-alert.ts alert [--dry-run]
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import { getSlackClient, slackChannelIds } from "./slack.ts";

export type MainE2eState = "green" | "red";

/** A page's first words: how the next run finds the last one. */
const RED = "🔴 main e2e red";
const GREEN = "🟢 main e2e green again";

/** The run's verdict from its jobs' results: red on any failure, green when every job succeeded, and
 *  none at all when a job was cancelled (a newer push superseded the run) or nothing failed but not
 *  everything ran. Pure. */
export function mainE2eVerdict(results: Record<string, string>): MainE2eState | undefined {
  const values = Object.values(results);
  if (values.includes("cancelled")) return undefined;
  if (values.includes("failure")) return "red";
  if (values.length > 0 && values.every((result) => result === "success")) return "green";
  return undefined;
}

/** The failed rows of a run's telemetry artifacts: a test whose outcome was unexpected (Playwright),
 *  or whose final state failed or timed out (vitest), the flake summary's own rule. Pure. */
export function mainE2eFailingRows(artifacts: TestTelemetryArtifact[]): string[] {
  const rows = artifacts.flatMap((artifact) =>
    artifact.tests
      .filter((test) =>
        test.outcome
          ? test.outcome === "unexpected"
          : ["failed", "timedout"].includes(test.state.toLowerCase()),
      )
      .map((test) => `${path.basename(test.moduleId)}: ${test.leafName || test.fullName}`),
  );
  return [...new Set(rows)];
}

/** The state the channel last announced: the newest of this alert's pages, else green. Pure. */
export function previousMainE2eState(messages: { text?: string; bot_id?: string }[]): MainE2eState {
  const last = messages.find(
    (message) =>
      message.bot_id &&
      (message.text?.startsWith(`${RED} `) || message.text?.startsWith(`${GREEN} `)),
  );
  return last?.text?.startsWith(`${RED} `) ? "red" : "green";
}

/** The page for a change of state, or null. Pure. */
export function mainE2ePage(input: {
  previous: MainE2eState;
  verdict: MainE2eState | undefined;
  commitSha: string;
  commitSubject: string;
  failedJobs: string[];
  failingRows: string[];
  runUrl?: string;
}): string | null {
  if (!input.verdict || input.verdict === input.previous) return null;
  const commit = `\`${input.commitSha.slice(0, 9)}\` (${input.commitSubject})`;
  const link = input.runUrl ? `<${input.runUrl}|the run>` : "";
  if (input.verdict === "green") return [`${GREEN} at ${commit}`, link].filter(Boolean).join("\n");
  const shown = input.failingRows.slice(0, 8);
  return [
    // the mention is Jonas (./slack.ts)
    `${RED} at ${commit} <@U067G4QRFK2>`,
    `• failed: ${input.failedJobs.join(", ") || "a job"}`,
    shown.length > 0 &&
      `• failing rows: ${shown.join("; ")}${input.failingRows.length > shown.length ? `; … and ${input.failingRows.length - shown.length} more` : ""}`,
    link,
  ]
    .filter(Boolean)
    .join("\n");
}

/** `${{ toJSON(needs) }}`: each job's result, and e2e's failing rows. */
const Needs = z.record(
  z.string(),
  z.object({ result: z.string(), outputs: z.record(z.string(), z.string()).optional() }),
);

async function alert(dryRun: boolean): Promise<void> {
  const needs = Needs.parse(JSON.parse(process.env.NEEDS || "{}"));
  const results = Object.fromEntries(
    Object.entries(needs).map(([job, need]) => [job, need.result]),
  );
  const verdict = mainE2eVerdict(results);
  const failingRows = z
    .array(z.string())
    .parse(JSON.parse(needs.e2e?.outputs?.["failing-rows"] || "[]"));
  const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const commitSubject = execFileSync("git", ["log", "-1", "--format=%s"], {
    encoding: "utf8",
  }).trim();
  const slack = getSlackClient();
  const channel = slackChannelIds["#error-pulse"];
  const history = await slack.conversations.history({
    channel,
    oldest: String(Date.now() / 1000 - 7 * 86_400),
    limit: 999,
  });
  const previous = previousMainE2eState(history.messages || []);
  const page = mainE2ePage({
    previous,
    verdict,
    commitSha,
    commitSubject,
    failedJobs: Object.entries(results)
      .filter(([, result]) => result === "failure")
      .map(([job]) => job),
    failingRows,
    runUrl: process.env.DEPOT_JOB_URL,
  });
  console.log(JSON.stringify({ results, verdict, previous, failingRows }));
  if (!page) return console.log("main e2e: no change of state, nothing to post");
  console.log(page);
  if (!dryRun) await slack.chat.postMessage({ channel, text: page });
}

function failingRows(directory: string): void {
  const artifacts = existsSync(directory)
    ? readdirSync(directory)
        .filter((file) => file.endsWith(".json"))
        .flatMap((file) => {
          const parsed = TestTelemetryArtifact.safeParse(
            JSON.parse(readFileSync(path.join(directory, file), "utf8")),
          );
          return parsed.success ? [parsed.data] : [];
        })
    : [];
  const rows = mainE2eFailingRows(artifacts);
  console.log(`${rows.length} failing rows in ${artifacts.length} telemetry artifacts`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `failing-rows=${JSON.stringify(rows)}\n`);
}

if (isMainModule(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const directory = rest.includes("--dir") ? rest[rest.indexOf("--dir") + 1] : undefined;
  const done =
    command === "failing-rows" && directory
      ? Promise.resolve(failingRows(directory))
      : command === "alert"
        ? alert(rest.includes("--dry-run"))
        : Promise.reject(
            new Error("usage: main-e2e-alert.ts failing-rows --dir <dir> | alert [--dry-run]"),
          );
  done.catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
