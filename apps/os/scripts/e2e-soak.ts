// scripts/e2e-soak.ts — THE FLAKE HUNT: run the e2e suite N times against one deployed worker and
// tally every row that did not pass every time. A row that fails once in a hundred is a flake; a row
// that fails every time is a bug; both are named by title, with the counts.
//
//   WORKER_BASE_URL=… pnpm e2e:soak --runs 100 [--filter <vitest filter>]
//
// The credentials are the deployment's: under `doppler run` its APP_CONFIG is in the environment and
// e2e/support/global-setup.ts reads them out of it.
//
// Each run invokes Vitest directly with its JSON reporter written to output/soak/run-<n>.json, then
// the perf project (the latency and throughput budgets, perf/**) to output/soak/perf-<n>.json — after
// the suite, never beside it, since beside it a budget measures the suite's contention. The tally is
// output/soak/summary.json plus the table below, both projects' rows together. Runs are sequential —
// the point is to see the suite as CI sees it, not to load the worker a hundredfold.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "output/soak");

function parseArgs(argv: string[]) {
  let runs = 100;
  let filter: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runs") runs = Number(argv[++i]);
    else if (argv[i] === "--filter") filter = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  return { runs, filter };
}

const { runs, filter } = parseArgs(process.argv.slice(2));
if (!process.env.WORKER_BASE_URL)
  throw new Error("WORKER_BASE_URL is required: the soak runs against a deployment");
mkdirSync(OUT, { recursive: true });

const tally = new Map<
  string,
  { file: string; passed: number; failed: number; skipped: number; ms: number[] }
>();
type VitestJson = {
  testResults: {
    name: string;
    assertionResults: {
      fullName: string;
      status: "passed" | "failed" | "skipped" | "todo" | "pending";
      duration?: number;
      failureMessages?: string[];
    }[];
  }[];
};
/** One Vitest run of `project` with its JSON report at `file`, every row folded into the tally;
 *  how many rows failed, or undefined when Vitest wrote no report. --retry=0: the e2e project retries
 *  once in CI, which is right for a gate and wrong for a soak — a row that failed its first attempt
 *  and passed its second is exactly what the soak exists to count (soak qx2jhwrrlk, 2026-09-22: the
 *  tally said 1/100 for a row that had failed 3 first attempts). Otherwise the `e2e:run` and
 *  `perf:run` scripts' argv, minus the reporters: vitest adds repeated `--reporter` flags together,
 *  and the retry-telemetry one would record flakes on every run. */
function soakRun(project: "e2e" | "perf", file: string): number | undefined {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--configLoader",
      "runner",
      "--project",
      project,
      ...(project === "e2e" ? ["--sequence.concurrent"] : []),
      "--reporter=json",
      `--outputFile=${file}`,
      "--retry=0",
      // a filter that names only e2e files leaves the perf project nothing to run
      ...(filter ? [filter, "--passWithNoTests"] : []),
    ],
    { cwd: ROOT, env: process.env, stdio: ["ignore", "ignore", "inherit"] },
  );
  if (!existsSync(file)) {
    console.error(`${path.basename(file)}: vitest wrote no report (exit ${result.status})`);
    return undefined;
  }
  const report = JSON.parse(readFileSync(file, "utf8")) as VitestJson;
  for (const suite of report.testResults) {
    for (const row of suite.assertionResults) {
      const entry = tally.get(row.fullName) || {
        file: path.relative(ROOT, suite.name),
        passed: 0,
        failed: 0,
        skipped: 0,
        ms: [],
      };
      // a passed row carrying failure messages passed on a retry — counted as a failure, the way a
      // soak must count it (belt and braces beside --retry=0)
      if (row.status === "passed" && (row.failureMessages?.length ?? 0) > 0) entry.failed++;
      else if (row.status === "passed") entry.passed++;
      else if (row.status === "failed") entry.failed++;
      else entry.skipped++;
      if (row.duration) entry.ms.push(row.duration);
      tally.set(row.fullName, entry);
    }
  }
  return report.testResults
    .flatMap((s) => s.assertionResults)
    .filter((r) => r.status === "failed" || (r.failureMessages?.length ?? 0) > 0).length;
}

const wall: number[] = [];
for (let n = 1; n <= runs; n++) {
  const started = Date.now();
  const failedNow = soakRun("e2e", path.join(OUT, `run-${n}.json`));
  wall.push(Date.now() - started);
  const perfFailed = soakRun("perf", path.join(OUT, `perf-${n}.json`));
  console.log(
    `run ${n}/${runs}: ${(wall.at(-1)! / 1000).toFixed(0)} s, ${failedNow ?? "?"} failed, ` +
      `perf ${perfFailed ?? "?"} failed`,
  );
}

const rows = [...tally.entries()].map(([title, e]) => ({
  title,
  file: e.file,
  passed: e.passed,
  failed: e.failed,
  skipped: e.skipped,
  p50Ms: e.ms.length ? e.ms.sort((a, b) => a - b)[Math.floor(e.ms.length / 2)] : null,
  maxMs: e.ms.length ? Math.max(...e.ms) : null,
}));
writeFileSync(
  path.join(OUT, "summary.json"),
  JSON.stringify({ runs, wallMs: wall, rows }, null, 2),
);
const flaky = rows.filter((r) => r.failed > 0).sort((a, b) => b.failed - a.failed);
console.log(
  `\n${runs} run(s); wall p50 ${(wall.sort((a, b) => a - b)[Math.floor(wall.length / 2)]! / 1000).toFixed(0)} s`,
);
console.log(
  flaky.length ? `${flaky.length} row(s) failed at least once:` : "every row passed every time",
);
for (const r of flaky)
  console.log(`  ${r.failed}/${r.failed + r.passed}  ${r.file}  ${r.title.slice(0, 110)}`);
const slow = rows
  .filter((r) => r.maxMs)
  .sort((a, b) => b.maxMs! - a.maxMs!)
  .slice(0, 5);
console.log("slowest rows (max ms):");
for (const r of slow) console.log(`  ${r.maxMs}  ${r.file}  ${r.title.slice(0, 100)}`);
