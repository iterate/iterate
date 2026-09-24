// scripts/ci/os-real-model-alert.ts — THE JUDGE FOR THE DAILY REAL-MODEL SUITE (.depot/workflows/os-real-model.yml):
// the rows titled `REAL:` run against real models once a day, never on a PR (docs/testing.md#real-model-rows).
// It reads the suite's Vitest JSON report and pages #error-pulse on a change of state only, red once and
// green again once, the way Main OS e2e pages (main-e2e-alert.ts). A page leaves the run green: a
// scheduled run reports on main's head, where red would read as "this commit broke". A BROKEN PROBE (no
// report, no REAL: rows, or REAL: rows skipped because E2E_REAL_MODELS never reached them) fails the run
// and pages nothing.
//
//   pnpm tsx scripts/ci/os-real-model-alert.ts --report apps/os/output/real-model-report.json [--dry-run]
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { pageOnChangeOfState, type MainE2eState } from "./main-e2e-alert.ts";

/** The suite's name in its pages. */
export const REAL_MODEL_SUITE = "real-model e2e";

/** The parts of Vitest's JSON report the judge reads. */
const VitestReport = z.object({
  testResults: z.array(
    z.object({
      assertionResults: z.array(
        z.object({
          title: z.string(),
          status: z.string(),
          failureMessages: z.array(z.string()).nullish(),
        }),
      ),
    }),
  ),
});

/** The suite's verdict from its report's `REAL:` rows: green when every one passed, red naming each
 *  failed row with its error's first line, or broken when none ran. Pure. */
export function realModelVerdict(
  report: z.infer<typeof VitestReport>,
): { verdict: MainE2eState; failingRows: string[] } | { broken: string } {
  const rows = report.testResults
    .flatMap((file) => file.assertionResults)
    .filter((row) => row.title.startsWith("REAL:"));
  if (rows.length === 0) return { broken: "the report has no REAL: rows" };
  const unrun = rows.filter((row) => row.status !== "passed" && row.status !== "failed");
  if (unrun.length > 0)
    return {
      broken: `${unrun.length} REAL: row(s) did not run (${unrun[0]!.status}): is E2E_REAL_MODELS=1 set?`,
    };
  const failingRows = rows
    .filter((row) => row.status === "failed")
    .map((row) => {
      const reason = (row.failureMessages?.[0] ?? "").split("\n")[0]!.slice(0, 300);
      return reason ? `${row.title} (${reason})` : row.title;
    });
  return { verdict: failingRows.length > 0 ? "red" : "green", failingRows };
}

async function judge(reportPath: string, dryRun: boolean): Promise<void> {
  if (!existsSync(reportPath)) throw new Error(`broken probe: no report at ${reportPath}`);
  const outcome = realModelVerdict(
    VitestReport.parse(JSON.parse(readFileSync(reportPath, "utf8"))),
  );
  if ("broken" in outcome) throw new Error(`broken probe: ${outcome.broken}`);
  console.log(JSON.stringify(outcome));
  await pageOnChangeOfState({
    suite: REAL_MODEL_SUITE,
    verdict: outcome.verdict,
    failedJobs: ["real-model rows"],
    failingRows: outcome.failingRows,
    dryRun,
  });
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const reportPath = args.includes("--report") ? args[args.indexOf("--report") + 1] : undefined;
  (reportPath
    ? judge(reportPath, args.includes("--dry-run"))
    : Promise.reject(new Error("usage: os-real-model-alert.ts --report <file> [--dry-run]"))
  ).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
