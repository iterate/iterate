// scripts/e2e-soak.ts — THE FLAKE HUNT: run the e2e suite N times against one deployed worker and
// tally every row that did not pass every time. A row that fails once in a hundred is a flake; a row
// that fails every time is a bug; both are named by title, with the counts.
//
//   WORKER_BASE_URL=… ADMIN_API_SECRET=… LOGIN_PASSWORD=… pnpm e2e:soak --runs 100 [--filter <vitest filter>]
//
// Each run is `pnpm e2e` with vitest's JSON reporter written to output/soak/run-<n>.json; the tally is
// output/soak/summary.json plus the table below. Runs are sequential — the point is to see the suite
// as CI sees it, not to load the worker a hundredfold.
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

type Outcome = "passed" | "failed" | "skipped" | "todo" | "pending";
type VitestJson = {
  testResults: {
    name: string;
    assertionResults: { fullName: string; status: Outcome; duration?: number }[];
  }[];
};

const { runs, filter } = parseArgs(process.argv.slice(2));
if (!process.env.WORKER_BASE_URL)
  throw new Error("WORKER_BASE_URL is required: the soak runs against a deployment");
mkdirSync(OUT, { recursive: true });

const tally = new Map<
  string,
  { file: string; passed: number; failed: number; skipped: number; ms: number[] }
>();
const wall: number[] = [];
for (let n = 1; n <= runs; n++) {
  const file = path.join(OUT, `run-${n}.json`);
  const started = Date.now();
  const result = spawnSync(
    "pnpm",
    ["e2e", "--reporter=json", `--outputFile=${file}`, ...(filter ? [filter] : [])],
    { cwd: ROOT, env: process.env, stdio: ["ignore", "ignore", "inherit"] },
  );
  wall.push(Date.now() - started);
  if (!existsSync(file)) {
    console.error(`run ${n}: vitest wrote no report (exit ${result.status})`);
    continue;
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
      if (row.status === "passed") entry.passed++;
      else if (row.status === "failed") entry.failed++;
      else entry.skipped++;
      if (row.duration) entry.ms.push(row.duration);
      tally.set(row.fullName, entry);
    }
  }
  const failedNow = report.testResults
    .flatMap((s) => s.assertionResults)
    .filter((r) => r.status === "failed").length;
  console.log(`run ${n}/${runs}: ${(wall.at(-1)! / 1000).toFixed(0)} s, ${failedNow} failed`);
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
