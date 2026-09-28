// scripts/ci/specs-shards.ts — BROWSER SPECS IN SHARDS, the first shard's last step. Preview OS and
// Main OS e2e run the specs as SPECS_SHARDS jobs that start with the run, enough of them that every
// spec has a worker from the start (./specs-shards.test.ts): `specs`, Browser specs, the required
// check, is shard 1, and the legs of the matrix job `specs-shard` are the others, Browser specs 2/10
// and on. Each runs its share (playwright.config.ts `shard`) and keeps its own evidence, with a
// Playwright blob report where an unsharded run writes its HTML one.
//
// Once its own share has run, the first shard waits here for every leg to settle, asking Depot's
// GetWorkflow as the deploy wait does (./await-deploy.ts `pollWorkflow`). Then it fetches each
// leg's blob report from the test results its newest attempt uploaded
// (`<workflow>-test-artifacts-attempt-<attempt id>`, docs/depot-ci.md#artifacts-per-job-attempt),
// merges them with its own into the one HTML report the "Playwright report" status opens, and
// fails when a leg did not pass or left no blob report. So Browser specs passes only when every
// shard did.
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { testEvidencePaths } from "@iterate-com/shared/test-support/test-evidence";
import { createCli } from "trpc-cli";
import {
  pollWorkflow,
  SUITE_BOUND_MS,
  thisWorkflowRun,
  type WorkflowJobs,
} from "./await-deploy.ts";
import { depotApi, workflowArtifact, type DepotApi } from "./depot.ts";

/** The matrix job whose legs are the shards after the first (preview-os.yml, main-os-e2e.yml). */
export const SHARD_JOB = "specs-shard";

/** How long the first shard waits for the legs once its own share has run. Every shard waits for
 *  the same deploy, so the legs start their suites when it does, and each ends its suite within
 *  SUITE_BOUND_MS of that; the rest is for their evidence steps. */
export const COLLECT_BOUND_MS = SUITE_BOUND_MS + 5 * 60_000;

/** Depot's statuses for a job that has ended (https://github.com/depot/cli/blob/main/pkg/cmd/ci/logs.go). */
const SETTLED = ["finished", "failed", "cancelled", "skipped"];

/** Wait until every leg of the matrix job `job` has settled, or COLLECT_BOUND_MS has passed, then
 *  write each leg's blob reports into `out`. What it returns is what keeps the specs from passing:
 *  a leg that did not finish, or left no blob report, one line each. */
export async function collectShards(input: {
  depot: DepotApi;
  workflowId: string;
  job: string;
  out: string;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}) {
  const { depot, workflowId, job, out, log = console.log } = input;
  let reported = "";
  const { runId, legs, waitedMs } = await pollWorkflow({
    ...input,
    tag: "specs-shards",
    waitingFor: `the ${job} legs`,
    boundMs: COLLECT_BOUND_MS,
    settled: ({ runId, jobs }, waitedMs) => {
      // `<file>:<job id>:matrix-<n>`
      const legs = jobs.filter((candidate) => candidate.jobKey.split(":")[1] === job);
      if (!legs.length)
        throw new Error(`Depot lists no job ${job} in workflow ${workflowId} to collect`);
      const waiting = legs.filter((leg) => !SETTLED.includes(leg.status));
      const state = waiting.length
        ? `waiting for ${waiting.map((leg) => `${name(leg)} (${leg.status})`).join(", ")}`
        : `all ${legs.length} settled`;
      if (state !== reported) log(`[specs-shards] ${seconds(waitedMs)}: ${state}`);
      reported = state;
      return waiting.length && waitedMs < COLLECT_BOUND_MS ? undefined : { runId, legs, waitedMs };
    },
  });
  await mkdir(out, { recursive: true });
  const problems = await Promise.all(
    legs.map(async (leg) => {
      if (!SETTLED.includes(leg.status))
        return [`${name(leg)} is still ${leg.status} after ${seconds(waitedMs)}`];
      const newest = leg.attempts.toSorted((a, b) => a.attempt - b.attempt).at(-1);
      const files =
        newest &&
        (await workflowArtifact(depot, { runId, workflowId }, (artifact) =>
          artifact.endsWith(`-test-artifacts-attempt-${newest.attemptId}`),
        ));
      const blobs = Object.entries(files || {}).filter(([path]) =>
        /^playwright-blob\/[^/]+\.zip$/u.test(path),
      );
      for (const [path, bytes] of blobs) await writeFile(join(out, basename(path)), bytes);
      if (leg.status === "finished" && blobs.length) return [];
      return [
        [
          `${name(leg)} ${leg.status === "finished" ? "passed" : leg.status}`,
          ...(blobs.length ? [] : ["left no blob report"]),
        ].join(" but "),
      ];
    }),
  );
  return problems.flat();
}

function name(job: WorkflowJobs["jobs"][number]) {
  return job.jobDisplayName || job.jobKey;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** `node scripts/ci/specs-shards.ts <command>` */
export default class SpecsShards {
  /** The first shard's step after its own share (preview-os.yml `collect`): its blob report and the
   *  legs' (collectShards), merged into the HTML report its evidence keeps. It fails when a leg did
   *  not pass or the reports would not merge, after merging what there is. */
  async collect() {
    const blobs = join(process.env.RUNNER_TEMP || tmpdir(), "specs-blob-reports");
    await mkdir(blobs, { recursive: true });
    // Its own, unless its suite ended before Playwright wrote one; that suite's step fails the job.
    const own = await readdir(testEvidencePaths.playwrightBlob).catch(() => []);
    for (const file of own)
      await copyFile(join(testEvidencePaths.playwrightBlob, file), join(blobs, file));
    const problems = await collectShards({
      depot: depotApi(),
      workflowId: thisWorkflowRun(),
      job: SHARD_JOB,
      out: blobs,
    });
    const merged = spawnSync(
      "pnpm",
      ["exec", "playwright", "merge-reports", "--reporter", "html", blobs],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          PLAYWRIGHT_HTML_OUTPUT_DIR: testEvidencePaths.playwrightReport,
          PLAYWRIGHT_HTML_OPEN: "never",
        },
      },
    );
    if (merged.status !== 0)
      problems.push(
        `the blob reports would not merge: playwright merge-reports exited ${merged.status}`,
      );
    if (problems.length)
      throw new Error(
        `Not every shard of the specs passed:\n${problems.map((line) => `- ${line}`).join("\n")}`,
      );
    console.log(
      `[specs-shards] every shard passed; the HTML report is ${testEvidencePaths.playwrightReport}`,
    );
  }
}

if (isMainModule(import.meta.url)) void createCli({ ...import.meta, name: "specs-shards" }).run();
