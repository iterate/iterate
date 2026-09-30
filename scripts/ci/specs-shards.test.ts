// Browser specs in shards (./specs-shards.ts): how many shards the workflows run, and Browser
// specs' collection of their blob reports, against the monitors' fake Depot on a fake clock.
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, mkdtempDisposableSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { fakeDepot } from "../monitors/fake-depot.ts";
import { COLLECT_BOUND_MS, collectShards, SHARD_JOB } from "./specs-shards.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

// THE MATHS: with Playwright's full parallelism, a shard starts every test it holds at once when it
// has a worker for each. Playwright 1.63 deals `floor(tests / shards)` tests to each shard and one
// more to each of the first `tests mod shards` (`filterForShard`), a test at a time since no spec
// runs in serial mode, so the fullest shard holds `ceil(tests / shards)`. The fewest shards that
// start every spec at once are `ceil(tests / workers)`: more only cost runners that wait for the
// deploy, fewer queue specs behind others.
test.for(["preview-os.yml", "main-os-e2e.yml"])(
  "%s runs the fewest shards that give every spec a worker from the start",
  (file) => {
    const listed = JSON.parse(
      execFileSync(
        resolve(repoRoot, "node_modules/.bin/playwright"),
        ["test", "--config", "test/playwright.config.ts", "--list", "--reporter=json"],
        // CI's workers, and the whole suite rather than one shard of it
        { cwd: repoRoot, env: { ...process.env, CI: "1", SPECS_SHARD: "" }, encoding: "utf8" },
      ),
    );
    const workers: number = listed.config.workers;
    const tests: number = listed.suites.reduce((sum: number, suite: any) => sum + count(suite), 0);
    const legs = (
      parseYaml(readFileSync(resolve(repoRoot, ".depot/workflows", file), "utf8")) as any
    ).jobs[SHARD_JOB];
    const shards = Number(legs.env.SPECS_SHARDS);

    expect(
      shards,
      `${tests} specs need ${Math.ceil(tests / workers)} shards of ${workers} workers: set SPECS_SHARDS and ${SHARD_JOB}'s matrix to match in preview-os.yml and main-os-e2e.yml`,
    ).toBe(Math.ceil(tests / workers));
    // one leg a shard, each named for it
    expect(legs).toMatchObject({
      name: `Browser specs \${{ matrix.shard }}/${shards}`,
      env: { SPECS_SHARD: "${{ matrix.shard }}" },
      strategy: { matrix: { shard: Array.from({ length: shards }, (_, index) => index + 1) } },
    });
  },
);

test("Browser specs waits for the shards, then takes each one's blob report from its newest attempt", async () => {
  using run = shardedRun({
    "Browser specs 2/3": { statuses: ["running", "finished"], blobs: ["report-2.zip"] },
    "Browser specs 3/3": { statuses: ["queued", "running", "running", "finished"], retried: true },
  });

  const problems = await collectShards({ ...run, job: SHARD_JOB });

  expect({
    problems,
    blobs: Object.fromEntries(
      readdirSync(run.out).map((file) => [file, readFileSync(join(run.out, file), "utf8")]),
    ),
    seconds: (Date.now() - run.started) / 1000,
    logged: run.lines,
  }).toEqual({
    problems: [],
    blobs: {
      "report-2.zip": "Browser specs 2/3's blob report (attempt 1)",
      "report-3.zip": "Browser specs 3/3's blob report (attempt 2)",
    },
    seconds: 3,
    logged: [
      "[specs-shards] 0.0 s: waiting for Browser specs 2/3 (running), Browser specs 3/3 (queued)",
      "[specs-shards] 1.0 s: waiting for Browser specs 3/3 (running)",
      "[specs-shards] 3.0 s: all 2 settled",
    ],
  });
});

test.for([
  {
    name: "failed",
    shard: { statuses: ["failed"] },
    problem: "Browser specs 3/3 failed",
  },
  {
    name: "passed with no blob report",
    shard: { statuses: ["finished"], blobs: [] },
    problem: "Browser specs 3/3 passed but left no blob report",
  },
  {
    name: "was cancelled before it wrote a blob report",
    shard: { statuses: ["cancelled"], blobs: [] },
    problem: "Browser specs 3/3 cancelled but left no blob report",
  },
  {
    name: "never ends",
    shard: { statuses: ["running"], blobs: [] },
    problem: `Browser specs 3/3 is still running after ${COLLECT_BOUND_MS / 1000}.0 s`,
  },
])(
  "a shard that $name keeps the specs from passing, and the others' reports are still taken",
  async ({ shard, problem }) => {
    using run = shardedRun({
      "Browser specs 2/3": { statuses: ["finished"] },
      "Browser specs 3/3": shard,
    });

    const problems = await collectShards({ ...run, job: SHARD_JOB });

    expect({ problems, blobs: readdirSync(run.out) }).toEqual({
      problems: [problem],
      blobs: shard.statuses[0] === "failed" ? ["report-2.zip", "report-3.zip"] : ["report-2.zip"],
    });
  },
);

test("the collection fails at once when its workflow has no shard job", async () => {
  using run = shardedRun({ "Browser specs 2/3": { statuses: ["finished"] } });

  await expect(collectShards({ ...run, job: "specs-shards" })).rejects.toThrow(
    "Depot lists no job specs-shards in workflow wf-1 to collect",
  );
});

/** The tests one suite of Playwright's JSON listing holds, its nested suites' included. */
function count(suite: any): number {
  return (
    (suite.specs || []).reduce((sum: number, spec: any) => sum + spec.tests.length, 0) +
    (suite.suites || []).reduce((sum: number, child: any) => sum + count(child), 0)
  );
}

/** A Preview OS run whose Browser specs job collects: each named leg of `specs-shard` moves through its
 *  statuses, one a call to GetWorkflow, the last repeated, on a fake clock that moves on whenever
 *  the wait sleeps. The blob reports go to a temporary directory, `out`, removed with the run. A leg's newest attempt's test results hold its `blobs` (one named for its shard
 *  unless given); a `retried` leg has an older attempt whose results the collection must not take. */
function shardedRun(
  legs: Record<string, { statuses: string[]; blobs?: string[]; retried?: boolean }>,
) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setTimerTickMode("nextTimerAsync");
  onTestFinished(() => void vi.useRealTimers());
  const out = mkdtempDisposableSync(join(tmpdir(), "iterate-test-"));
  const shards = Object.entries(legs).map(([displayName, leg], index) => {
    const shard = displayName.split(" ").at(-1)!.split("/")[0]!;
    const attempts = leg.retried ? [1, 2] : [1];
    return {
      job: {
        jobKey: `preview-os.yml:specs-shard:matrix-${index}`,
        jobDisplayName: displayName,
        status: leg.statuses[0]!,
        attempts: attempts.map((attempt) => ({ attemptId: `${shard}-${attempt}`, attempt })),
      },
      statuses: leg.statuses,
      artifacts: Object.fromEntries(
        attempts.map((attempt) => [
          `preview-os-test-artifacts-attempt-${shard}-${attempt}`,
          Object.fromEntries(
            (leg.blobs || [`report-${shard}.zip`]).map((blob) => [
              `playwright-blob/${blob}`,
              attempt === attempts.length
                ? `${displayName}'s blob report (attempt ${attempt})`
                : "an older attempt's blob report",
            ]),
          ),
        ]),
      ),
    };
  });
  const workflow = {
    workflowId: "wf-1",
    runId: "run-1",
    status: "running",
    trigger: "pull_request",
    sha: "a".repeat(40),
    createdAt: "2026-09-28T21:00:00.000Z",
    jobs: [
      {
        jobKey: "preview-os.yml:specs",
        jobDisplayName: "Browser specs",
        status: "running",
        attempts: [{ attemptId: "1-1", attempt: 1 }],
      },
      ...shards.map((shard) => shard.job),
    ],
    artifacts: Object.assign({}, ...shards.map((shard) => shard.artifacts)),
  };
  const fake = fakeDepot({ "Preview OS": [workflow] });
  const lines: string[] = [];
  let calls = 0;
  return {
    workflowId: "wf-1",
    out: out.path,
    started: Date.now(),
    lines,
    log: (line: string) => void lines.push(line),
    depot: async (method: string, body: object) => {
      if (method === "GetWorkflow") {
        for (const shard of shards)
          shard.job.status = shard.statuses[Math.min(calls, shard.statuses.length - 1)]!;
        calls++;
      }
      return fake(method, body);
    },
    [Symbol.dispose]: () => out[Symbol.dispose](),
  };
}
