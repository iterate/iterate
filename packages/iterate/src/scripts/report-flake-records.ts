// Ships createFlake recorder lines (see
// packages/shared/src/test-support/flake-test.ts) from FLAKE_RECORD_DIR to
// the flake dashboard's /flakes stream on the configured iterate project, as
// one run-recorded event per run+suite. Invoked by CI post-steps:
// `pnpm tsx packages/iterate/src/scripts/report-flake-records.ts`.
//
// This is telemetry, not control: EVERY failure path — missing secrets, an
// unreachable deployment, malformed lines — logs and exits 0, and the whole
// attempt races a hard deadline. Flake reporting must never redden or slow
// CI; a broken prd only gaps the data.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { connectItx } from "../node.ts";
import {
  flakeDashboardCreationEvents,
  flakesStreamPath,
} from "../starter-apps/flake-dashboard/app-ref.ts";
import { FlakeRecord } from "../starter-apps/flake-dashboard/contract.ts";

const DEADLINE_MS = 20_000;

async function main(): Promise<void> {
  // Same rebase rule as the recorder (and TEST_TELEMETRY_ARTIFACT_DIR): a
  // relative dir resolves against GITHUB_WORKSPACE, so writer and reader
  // agree on one location regardless of each workspace's own cwd.
  const configuredDir = process.env.FLAKE_RECORD_DIR;
  const recordDir =
    configuredDir && process.env.GITHUB_WORKSPACE
      ? resolve(process.env.GITHUB_WORKSPACE, configuredDir)
      : configuredDir;
  if (!recordDir || !existsSync(recordDir)) {
    console.log(`[flake-report] no record dir at ${recordDir || "(unset)"} — nothing to report`);
    return;
  }
  const records = readdirSync(recordDir)
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) =>
      readFileSync(join(recordDir, file), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .flatMap((line) => {
          // A torn or garbage line (a crashed worker mid-append) must skip,
          // not abort the whole report — JSON.parse throws are malformed too.
          let json: unknown;
          try {
            json = JSON.parse(line);
          } catch {
            console.warn(`[flake-report] skipping malformed line in ${file}: ${line}`);
            return [];
          }
          const parsed = FlakeRecord.safeParse(json);
          if (!parsed.success) {
            console.warn(`[flake-report] skipping malformed line in ${file}: ${line}`);
            return [];
          }
          return [parsed.data];
        }),
    );
  if (records.length === 0) {
    console.log("[flake-report] no flake records this run");
    return;
  }

  const baseUrl = process.env.FLAKE_REPORT_BASE_URL;
  const projectSlug = process.env.FLAKE_REPORT_PROJECT_SLUG;
  const secret = process.env.FLAKE_REPORT_PROJECT_API_KEY;
  if (!baseUrl || !projectSlug || !secret) {
    console.log(
      `[flake-report] ${records.length} records collected but FLAKE_REPORT_BASE_URL / ` +
        "FLAKE_REPORT_PROJECT_SLUG / FLAKE_REPORT_PROJECT_API_KEY are not all set — skipping upload",
    );
    return;
  }

  // A retried GitHub job re-runs its tests, so the attempt belongs in the
  // run identity — otherwise the retry's fresh outcomes would idempotency-
  // conflict with the first attempt's and be dropped.
  const runId = `${process.env.GITHUB_RUN_ID || "local"}-${process.env.GITHUB_RUN_ATTEMPT || "1"}`;
  // iterate-lint-disable-next-line terminology/no-metaphorical-lane-door-seam -- reads the existing TEST_TELEMETRY_LANE env var; renaming that wire name is tracked in tasks/rename-lane-vocabulary.md
  const suite = process.env.TEST_TELEMETRY_LANE || "unknown";
  const [owner = "iterate", repo = "iterate"] = (process.env.GITHUB_REPOSITORY || "").split("/");

  using project = connectItx({
    baseUrl,
    auth: { type: "project-secret", projectSlug, secret },
    projectId: projectSlug,
  });
  const stream = project.streams.get(flakesStreamPath);
  // Every reporter may offer the idempotency-keyed birth certificate; only
  // the first ever lands.
  await stream.append(
    ...flakeDashboardCreationEvents({
      repository: { owner, repo },
      issueTitle: process.env.FLAKE_REPORT_ISSUE_TITLE || "Flake dashboard",
      defaultBranch: process.env.FLAKE_REPORT_DEFAULT_BRANCH || "main",
    }),
  );
  await stream.append({
    type: "events.iterate.com/flakes/run-recorded",
    idempotencyKey: `flakes/run:${runId}:${suite}`,
    payload: {
      runId,
      suite,
      branch: process.env.TEST_TELEMETRY_BRANCH || "unknown",
      commit: process.env.TEST_TELEMETRY_HEAD_SHA || "unknown",
      records,
    },
  });
  console.log(`[flake-report] shipped ${records.length} records as run ${runId} suite ${suite}`);
}

let deadline: ReturnType<typeof setTimeout> | undefined;
try {
  await Promise.race([
    main(),
    new Promise((_resolve, reject) => {
      deadline = setTimeout(
        () => reject(new Error(`deadline: still uploading after ${DEADLINE_MS}ms`)),
        DEADLINE_MS,
      );
    }),
  ]);
} catch (error) {
  console.warn("[flake-report] reporting failed (never fails CI):", error);
} finally {
  clearTimeout(deadline);
}
process.exit(0);
