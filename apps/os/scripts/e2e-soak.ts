// scripts/e2e-soak.ts — THE FLAKE HUNT: run the e2e suite N times against one deployed worker and
// tally every row that did not pass every time. A row that fails once in a hundred is a flake; a row
// that fails every time is a bug; both are named by title, with the counts.
//
//   WORKER_BASE_URL=… pnpm e2e:soak --runs 100 [--filter <vitest filter>]
//   pnpm e2e:soak --runs 100 --preview soak-mine     (the preview's URL; WORKER_BASE_URL wins)
//   pnpm e2e:soak --runs 10 --fresh-previews soak-fresh-<tag>
//   pnpm e2e:soak --runs 10 --redeploy soak-<tag> [--gap <seconds>]
//
// The credentials are the deployment's: under `doppler run` its APP_CONFIG is in the environment and
// e2e/support/global-setup.ts reads them out of it.
//
// THE FIRST MINUTES OF A PREVIEW (`--fresh-previews <prefix>`): each run deploys a brand-new Worker
// Preview `<prefix>-<n>` (scripts/preview.ts deploy --apps none, its readiness gate included), runs
// the e2e project against it at once, and deletes it — the shape main's e2e run had until it kept
// one preview, a `main-<sha>` per push, which a preview redeployed in place never has (2026-09-24:
// bursts of `internal error; reference = …` on brand-new previews only,
// scripts/preview-readiness.ts). A deploy that fails is counted and named, never a skipped run. No
// perf run in this mode: the budgets measure a warm worker.
//
// MAIN'S SHAPE SINCE IT KEEPS ONE PREVIEW (`--redeploy <preview>`): each run redeploys the named
// preview IN PLACE (the same deploy, gate included), runs the e2e project against it at once, and
// never deletes it — Main OS e2e's run on `main` (preview-sweep.ts CI_WORKFLOW_PREVIEWS). Deploy the
// preview once beforehand and let it age: a preview created minutes ago is still brand-new. `--gap`
// waits that long after each run before the next redeploy: on main, a run's e2e job ends about
// 90 s before the next queued run redeploys (the parent's deploy and the build come first).
//
// Each run invokes Vitest directly with its JSON reporter written to output/soak/run-<n>.json, then
// the perf project (the latency and throughput budgets, perf/**) to output/soak/perf-<n>.json — after
// the suite, never beside it, since beside it a budget measures the suite's contention. The tally is
// output/soak/summary.json plus the table below, both projects' rows together. Runs are sequential —
// the point is to see the suite as CI sees it, not to load the worker a hundredfold.
//
// A soak never pays for a model: E2E_REAL_MODELS is stripped from every run, so the real-model rows
// skip (`realModelOnly`). On 2026-09-24 back-to-back soaks spent the preview account's AI Gateway cap
// and every PR's preview e2e went red; the daily os-real-model.yml is where those rows run
// (docs/testing.md#real-model-rows).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { createCli } from "trpc-cli";
import { previewUrl, resolvePreviewName } from "./preview-config.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "output/soak");

type SoakOptions = {
  /** how many runs (default 100) */
  runs?: number;
  /** a Vitest filter, passed to every run */
  filter?: string;
  /** the preview to soak (its URL); WORKER_BASE_URL wins */
  preview?: string;
  /** each run deploys a brand-new preview `<prefix>-<n>`, runs e2e against it and deletes it */
  freshPreviews?: string;
  /** each run redeploys this preview in place, then runs e2e against it */
  redeploy?: string;
  /** seconds to wait after each --redeploy run before the next redeploy */
  gap?: number;
};

/** Run the e2e suite (then the perf budgets) N times against one deployed worker and tally every
 *  row that did not pass every time: output/soak/summary.json plus a table. */
export default async function e2eSoak(options: SoakOptions = {}) {
  const { runs = 100, filter, preview, freshPreviews, redeploy, gap: gapSeconds = 0 } = options;
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  if ((freshPreviews || redeploy) && (preview || process.env.WORKER_BASE_URL))
    throw new Error(
      "--fresh-previews and --redeploy deploy their own worker: no --preview or WORKER_BASE_URL",
    );
  if (freshPreviews && redeploy) throw new Error("--fresh-previews or --redeploy, not both");
  if (!(Number.isFinite(gapSeconds) && gapSeconds >= 0) || (gapSeconds && !redeploy))
    throw new Error("--gap takes a number of seconds, and only with --redeploy");
  if (!freshPreviews && !redeploy) {
    // An explicit WORKER_BASE_URL wins; otherwise the named preview (os-e2e-soak.yml deploys it first).
    process.env.WORKER_BASE_URL ||= preview
      ? previewUrl(resolvePreviewName({ name: preview }))
      : "";
    if (!process.env.WORKER_BASE_URL)
      throw new Error(
        "WORKER_BASE_URL, --preview or --fresh-previews is required: the soak runs against a deployment",
      );
    console.log(`soaking ${process.env.WORKER_BASE_URL}`);
  }
  mkdirSync(OUT, { recursive: true });
  const { E2E_REAL_MODELS: _stripped, ...runEnv } = process.env;

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
   *  and passed its second is exactly what the soak exists to count (with the retry, a row that failed
   *  3 first attempts in 100 tallied 1/100, 2026-09-22). Otherwise the `e2e:run` and
   *  `perf:run` scripts' argv, minus the reporters: vitest adds repeated `--reporter` flags together,
   *  and the retry-telemetry one would record flakes on every run. */
  function soakRun(
    project: "e2e" | "perf",
    file: string,
    workerBaseUrl = process.env.WORKER_BASE_URL,
  ): number | undefined {
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
      {
        cwd: ROOT,
        env: { ...runEnv, WORKER_BASE_URL: workerBaseUrl },
        stdio: ["ignore", "ignore", "inherit"],
      },
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
    const failed = report.testResults.flatMap((suite) =>
      suite.assertionResults
        .filter((r) => r.status === "failed" || (r.failureMessages?.length ?? 0) > 0)
        .map((r) => ({ file: path.relative(ROOT, suite.name), row: r })),
    );
    // EACH FAILURE IN THE LOG AS IT HAPPENS: file, title and the message's first line — a soak's log
    // must say WHAT failed while it runs, not only how many (the reports arrive with the artifact).
    for (const { file: failedFile, row } of failed)
      console.log(
        `  ✗ ${failedFile} › ${row.fullName.slice(0, 120)}\n      ${firstLine(row.failureMessages?.[0] ?? "")}`,
      );
    return failed.length;
  }

  // Each suite's wall time on its own: `wall` stays the e2e suite's, comparable with a CI e2e job's.
  const wall: number[] = [];
  const perfWall: number[] = [];
  const deployFailures: { run: number; preview: string; status: number | null }[] = [];
  for (let n = 1; n <= runs; n++) {
    // the name scripts/preview.ts will give it, so the URL below is the one it deploys
    if (freshPreviews) {
      deployedRun(n, resolvePreviewName({ name: `${freshPreviews}-${n}` }), { remove: true });
      continue;
    }
    if (redeploy) {
      if (n > 1 && gapSeconds) spawnSync("sleep", [String(gapSeconds)]);
      deployedRun(n, resolvePreviewName({ name: redeploy }), { remove: false });
      continue;
    }
    let started = Date.now();
    const failedNow = soakRun("e2e", path.join(OUT, `run-${n}.json`));
    wall.push(Date.now() - started);
    started = Date.now();
    const perfFailed = soakRun("perf", path.join(OUT, `perf-${n}.json`));
    perfWall.push(Date.now() - started);
    console.log(
      `run ${n}/${runs}: e2e ${(wall.at(-1)! / 1000).toFixed(0)} s, ${failedNow ?? "?"} failed; ` +
        `perf ${(perfWall.at(-1)! / 1000).toFixed(0)} s, ${perfFailed ?? "?"} failed`,
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
    JSON.stringify({ runs, wallMs: wall, perfWallMs: perfWall, deployFailures, rows }, null, 2),
  );
  if (freshPreviews || redeploy)
    console.log(
      `\n${runs} ${freshPreviews ? "brand-new preview(s)" : "in-place redeploy(s)"}; ${deployFailures.length} deploy(s) failed${deployFailures.map((failure) => `\n  run ${failure.run}: ${failure.preview} (exit ${failure.status})`).join("")}`,
    );
  const flaky = rows.filter((r) => r.failed > 0).sort((a, b) => b.failed - a.failed);
  console.log(
    `\n${runs} run(s); e2e wall p50 ${p50Seconds(wall)}, perf wall p50 ${p50Seconds(perfWall)}`,
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

  /** One `--fresh-previews` or `--redeploy` run: the preview deployed (brand-new, or again in place),
   *  the e2e project against it at once, then — a fresh preview only — the preview deleted whatever
   *  happened. The deploy's and the delete's output stream through. */
  function deployedRun(n: number, preview: string, { remove }: { remove: boolean }) {
    const pnpmPreview = (command: string, ...args: string[]) =>
      spawnSync("pnpm", ["preview", command, "--name", preview, ...args], {
        cwd: ROOT,
        env: process.env,
        stdio: ["ignore", "inherit", "inherit"],
      }).status;
    try {
      const deployed = pnpmPreview("deploy", "--apps", "none");
      if (deployed !== 0) {
        deployFailures.push({ run: n, preview, status: deployed });
        console.log(`run ${n}/${runs}: ${preview} did not deploy (exit ${deployed})`);
        return;
      }
      const started = Date.now();
      const failedNow = soakRun("e2e", path.join(OUT, `run-${n}.json`), previewUrl(preview));
      wall.push(Date.now() - started);
      console.log(
        `run ${n}/${runs}: ${preview} e2e ${(wall.at(-1)! / 1000).toFixed(0)} s, ${failedNow ?? "?"} failed`,
      );
    } finally {
      if (remove) {
        const deleted = pnpmPreview("delete");
        if (deleted !== 0) console.warn(`run ${n}/${runs}: deleting ${preview} exited ${deleted}`);
      }
    }
  }
}

function p50Seconds(ms: number[]) {
  if (ms.length === 0) return "n/a";
  return `${(ms.toSorted((a, b) => a - b)[Math.floor(ms.length / 2)]! / 1000).toFixed(0)} s`;
}

/** A failure message's first line. Vitest's own test timeout reports a stack whose first line is
 *  `Error: STACK_TRACE_ERROR` (@vitest/runner makeTimeoutError copies the registration's stack and
 *  its replace leaves that line — 4.1.10), so that line is said as what it means. */
function firstLine(message: string): string {
  const line = message.split("\n")[0]!.slice(0, 400);
  return line === "Error: STACK_TRACE_ERROR"
    ? "the test hit its own timeout (vitest reports that as Error: STACK_TRACE_ERROR)"
    : line;
}

if (isMainModule(import.meta.url)) void createCli({ ...import.meta, name: "e2e-soak" }).run();
