// scripts/ci/os-slow-e2e-alert.ts — THE JUDGE FOR THE SLOW E2E ROWS (.depot/workflows/os-slow-e2e.yml):
// every 2 hours the e2e rows tagged `slow`, which a PR that changes none of their code skips
// (docs/testing.md#slow-rows), run alone against main's preview `slow-e2e`. It reads the run's test
// telemetry and pages #error-pulse on a change of state only, red once and green again once, the way
// Main OS e2e pages (main-e2e-alert.ts), under its own name: Main OS e2e runs these rows too, but
// pages only when main changes state, so a regression that lands while main is red would page nobody.
// A page leaves the run green: a scheduled run reports on main's head, where red would read as "this
// commit broke". A BROKEN PROBE (no telemetry, a runner that did not finish, or no row tagged `slow`
// that ran) fails the run and pages nothing.
//
//   pnpm tsx scripts/ci/os-slow-e2e-alert.ts --dir test-results/ci-telemetry/raw [--dry-run]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { mainE2eFailingRows, pageOnChangeOfState, type MainE2eState } from "./main-e2e-alert.ts";

/** The suite's name in its pages. */
export const SLOW_E2E_SUITE = "slow e2e rows";

/** The suite's verdict from its telemetry: green when every row tagged `slow` passed (on its retry
 *  too), red naming each failed row, or broken when the run proves nothing. Pure. */
export function slowRowsVerdict(
  artifacts: TestTelemetryArtifact[],
): { verdict: MainE2eState; failingRows: string[] } | { broken: string } {
  if (artifacts.length === 0) return { broken: "no test telemetry" };
  const unfinished = artifacts.find(
    (artifact) => !["passed", "failed"].includes(artifact.run.status),
  );
  if (unfinished) return { broken: `the vitest run ended ${unfinished.run.status}` };
  const ran = artifacts
    .flatMap((artifact) => artifact.tests)
    .filter((test) => test.tags.includes("slow") && ["passed", "failed"].includes(test.state));
  if (ran.length === 0) return { broken: "no row tagged slow ran" };
  const failingRows = mainE2eFailingRows(artifacts);
  return { verdict: failingRows.length > 0 ? "red" : "green", failingRows };
}

async function judge(directory: string, dryRun: boolean): Promise<void> {
  const artifacts = existsSync(directory)
    ? readdirSync(directory)
        .filter((file) => file.endsWith(".json"))
        .map((file) =>
          TestTelemetryArtifact.parse(JSON.parse(readFileSync(path.join(directory, file), "utf8"))),
        )
    : [];
  const outcome = slowRowsVerdict(artifacts);
  if ("broken" in outcome) throw new Error(`broken probe: ${outcome.broken}`);
  console.log(JSON.stringify(outcome));
  await pageOnChangeOfState({
    suite: SLOW_E2E_SUITE,
    verdict: outcome.verdict,
    failedJobs: ["slow e2e rows"],
    failingRows: outcome.failingRows,
    dryRun,
  });
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const directory = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : undefined;
  (directory
    ? judge(directory, args.includes("--dry-run"))
    : Promise.reject(new Error("usage: os-slow-e2e-alert.ts --dir <dir> [--dry-run]"))
  ).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
