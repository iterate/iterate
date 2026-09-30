import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { AWAIT_DEPLOY, SUITE_BOUND_MS } from "./await-deploy.ts";
import { COLLECT_BOUND_MS, SHARD_JOB } from "./specs-shards.ts";
import { evaluateWorkflowExpression as evaluate } from "./workflow-expression.ts";

type PreviewStep = {
  "continue-on-error"?: boolean;
  id?: string;
  if?: string;
  name?: string;
  parallel?: PreviewStep[];
  run?: string;
  "timeout-minutes"?: number;
  uses?: string;
  with?: { ref?: string; name?: string };
  env?: Record<string, string>;
};

/** The parts of .depot/workflows/preview-os.yml these tests read. */
type PreviewWorkflow = {
  concurrency: { group: string; "cancel-in-progress": string };
  env?: Record<string, string>;
  on: { pull_request?: { paths?: string[] }; workflow_dispatch?: { inputs?: object } };
  jobs: Record<
    string,
    {
      if?: string;
      name?: string;
      needs?: string | string[];
      /** A Depot stock image's label (`depot-ubuntu-24.04-4`) */
      "runs-on"?: string;
      "timeout-minutes"?: number;
      strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] } };
      env?: Record<string, string>;
      outputs?: Record<string, string>;
      steps?: PreviewStep[];
    }
  >;
};

const source = readFileSync(
  resolve(import.meta.dirname, "../../.depot/workflows/preview-os.yml"),
  "utf8",
);
const preview = parseYaml(source) as PreviewWorkflow;
// As the jobs run: each `parallel:` block's steps stand where the block does.
for (const job of Object.values(preview.jobs))
  job.steps = job.steps?.flatMap((step) => step.parallel || [step]);
// Both suite jobs run one step list; the job's SUITE picks what it runs. The specs run in shards,
// the legs of `specs-shard`, and Browser specs (`specs`) gives their verdict.
const suites = [
  { job: "e2e", name: "E2E tests", suite: "e2e" },
  { job: SHARD_JOB, name: "Browser specs ${{ matrix.shard }}/11", suite: "specs" },
] as const;
const suiteRun =
  'doppler run --project os --config preview -- pnpm preview "$SUITE" ${PR_NUMBER:+--pr "$PR_NUMBER"} ${DEPLOYMENT_PREFIX:+--name "$DEPLOYMENT_PREFIX"} ${SLOW_ROWS:+--slow-rows "$SLOW_ROWS"}';

test("Preview OS names each job for the check it is: deploy and the two suites side by side, the cleanup after the deploy, then the trace", () => {
  expect(
    Object.fromEntries(Object.entries(preview.jobs).map(([id, job]) => [id, job.name])),
  ).toEqual({
    deploy: "Deploy preview",
    e2e: "E2E tests",
    specs: "Browser specs",
    [SHARD_JOB]: "Browser specs ${{ matrix.shard }}/11",
    cleanup: "Clean up superseded",
    // temporary, for PR #3434's branch alone, which never merges
    copybara: "Copybara copies",
    trace: "CI trace",
  });
  const runs = (job: string) => (preview.jobs[job]?.steps || []).map((step) => step.run);
  expect(runs("deploy")).toContain(
    'doppler run --project os --config preview -- pnpm preview deploy --pr "$PR_NUMBER" --apps "$APPS"',
  );
  expect([preview.jobs.cleanup!.needs].flat()).toEqual(["deploy"]);
  expect(runs("cleanup")).toContain(
    "doppler run --project os --config preview -- pnpm preview cleanup-superseded",
  );
  for (const suite of suites) {
    // started with the run, beside the deploy: the suite step waits for it (below)
    expect(preview.jobs[suite.job]!.needs).toBeUndefined();
    // one suite per job: specs share no runner's CPU with vitest
    expect(preview.jobs[suite.job]!.env?.SUITE).toBe(suite.suite);
    expect(runs(suite.job)).toContain(suiteRun);
  }
  // Browser specs runs no spec itself: it starts with the run too, and collects the shards
  expect(preview.jobs.specs!.needs).toBeUndefined();
  expect(runs("specs")).toEqual(
    expect.arrayContaining(["node scripts/ci/specs-shards.ts collect"]),
  );
  expect(runs("specs")).not.toContain(suiteRun);
  expect(runs("deploy")).not.toContain(suiteRun);
});

// Why the suite jobs share one definition: .depot/workflows/preview-os.yml (THE TWO SUITES).
test("Preview OS's suite jobs are one definition, differing only in the suite and the shard they name", () => {
  const [e2e, shard] = [preview.jobs.e2e!, preview.jobs[SHARD_JOB]!];
  expect(shard).toMatchObject({ steps: e2e.steps, "timeout-minutes": e2e["timeout-minutes"] });
  // written once: the shards alias E2E tests'
  expect(source.match(/^ {4}steps: \*suite-steps$/gmu)).toHaveLength(1);
  const suiteEnv = ["SUITE", "FLAKE_SUITE", "TEST_TELEMETRY_EXPECTED_WORKSPACES"];
  const shardEnv = ["SPECS_SHARD", "SPECS_SHARDS"];
  const shared = (env: Record<string, string> = {}) =>
    Object.fromEntries(
      Object.entries(env).filter(([name]) => ![...suiteEnv, ...shardEnv].includes(name)),
    );
  expect(shared(shard.env)).toEqual(shared(e2e.env));
  expect([e2e.env, shard.env]).toMatchObject([
    { SUITE: "e2e", FLAKE_SUITE: "preview-e2e", TEST_TELEMETRY_EXPECTED_WORKSPACES: "os" },
    { SUITE: "specs", FLAKE_SUITE: "specs", TEST_TELEMETRY_EXPECTED_WORKSPACES: "iterate-root" },
  ]);
  // how many shards: ./specs-shards.test.ts
  expect(e2e.env).not.toHaveProperty("SPECS_SHARD");
  // each skips on a dispatch of the other suite alone, and that is the only difference
  expect(shard.if?.replace("inputs.action != 'e2e'", "inputs.action != 'specs'")).toBe(e2e.if);
  // a red shard leaves the others running, and Browser specs runs whenever the shards do
  expect(shard).toMatchObject({ strategy: { "fail-fast": false } });
  expect(preview.jobs.specs).toMatchObject({ if: shard.if, env: { SUITE: "specs" } });
});

// Why each suite runs on its size: docs/depot-ci.md#reliability-defaults.
test("Preview OS's E2E tests and Browser specs run on the smallest runner, and each specs shard on a 4x16", () => {
  expect(preview.jobs.e2e!["runs-on"]).toBe("depot-ubuntu-24.04");
  // it only waits and merges
  expect(preview.jobs.specs!["runs-on"]).toBe("depot-ubuntu-24.04");
  expect(preview.jobs[SHARD_JOB]!["runs-on"]).toBe("depot-ubuntu-24.04-4");
});

// A required check has to report on every pull request: GitHub leaves one "Pending" when a `paths`
// filter skips its workflow (scripts/ci/preview-paths.ts).
test("Preview OS runs on every pull request, and Deploy preview decides whether it deploys", () => {
  expect(preview.on.pull_request).toBeDefined();
  expect(preview.on.pull_request?.paths).toBeUndefined();
  const steps = preview.jobs.deploy!.steps || [];
  const changes = steps.findIndex((step) => step.id === "changes");
  expect(steps[changes]).toMatchObject({
    if: "github.event_name == 'pull_request'",
    run: "node scripts/ci/preview-paths.ts changes",
  });
  // decided on the tested commit, before anything is installed
  expect(changes).toBe(steps.findIndex((step) => step.id === "tested") + 1);
  expect(steps.slice(changes + 1).map((step) => step.if)).toEqual(
    steps.slice(changes + 1).map(() => "steps.changes.outputs.preview != 'false'"),
  );
  expect(preview.jobs.deploy!.outputs?.preview).toBe("${{ steps.changes.outputs.preview }}");
});

test("Preview OS deploys the PR merged into main, and the test jobs use that very commit", () => {
  const suiteSteps = preview.jobs.e2e!.steps || [];
  const deploySteps = preview.jobs.deploy!.steps || [];
  const resolve = deploySteps.findIndex((step) => step.id === "tested");
  const deploy = deploySteps.findIndex((step) => step.run?.includes("pnpm preview deploy"));
  expect(deploySteps[resolve]?.run).toBe("node scripts/ci/preview-tested-commit.ts");
  // on a push, the run's own commit: the merge commit this workflow file was read from
  expect(deploySteps[resolve]?.env?.PREVIEW_RUN_SHA).toBe(
    "${{ github.event_name == 'pull_request' && github.sha || '' }}",
  );
  // resolved before anything is installed or deployed from the checkout
  expect(resolve).toBeLessThan(deploySteps.findIndex((step) => step.name === "Setup"));
  expect(resolve).toBeLessThan(deploy);
  expect(preview.jobs.deploy!.outputs).toMatchObject({
    "tested-sha": "${{ steps.tested.outputs.sha }}",
    // the name preview.ts gives the deployment, `pr<n>-<sha7>` of the tested commit, for the cleanup
    deployment: "${{ steps.deploy.outputs.deployment }}",
  });
  expect(deploySteps[deploy]?.id).toBe("deploy");
  // the trace runs the scripts of the tree deploy tested, not of the PR head alone
  expect(
    preview.jobs.trace!.steps?.find((step) => step.uses === "actions/checkout@v4")?.with?.ref,
  ).toMatch(/^\$\{\{ needs\.deploy\.outputs\.tested-sha \|\| /);
  // the suites resolve that commit by deploy's own two steps (preview-os.yml, THE COMMIT DEPLOY
  // PREVIEW DEPLOYS)
  const checkout = suiteSteps.findIndex((step) => step.uses === "actions/checkout@v4");
  const deployCheckout = deploySteps.findIndex((step) => step.uses === "actions/checkout@v4");
  expect(deploySteps[deployCheckout]?.with?.ref).toBe(
    "${{ github.event.pull_request.head.sha || format('refs/pull/{0}/head', inputs.pull-request-number) }}",
  );
  expect(suiteSteps[checkout]?.with?.ref).toBe(
    "${{ github.event.pull_request.head.sha || (inputs.pull-request-number != '' && format('refs/pull/{0}/head', inputs.pull-request-number)) || github.sha }}",
  );
  expect(resolve).toBe(deployCheckout + 1);
  expect(suiteSteps[checkout + 1]).toEqual({
    ...deploySteps[resolve],
    if: "github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && inputs.pull-request-number != '')",
  });
  // the trace's statuses still go on the PR head
  expect(
    preview.jobs.trace!.steps?.find((step) => step.name === "Record the traced commit")?.env,
  ).toEqual({ HEAD_SHA: "${{ needs.deploy.outputs.head-sha }}" });
});

test("Preview OS: only the trace runs after the suites, so the next push's deploy waits for nothing else", () => {
  for (const suite of suites) {
    const after = Object.entries(preview.jobs).filter(([, job]) =>
      [job.needs].flat().includes(suite.job),
    );
    expect(after.map(([jobId]) => jobId)).toEqual(["trace"]);
  }
});

// A newer push makes the run in progress out of date; a dispatch (an operator's, a soak's) waits its
// turn, and preview-delete.yml, in the same group, never cancels (depot-workflows.test.ts).
test("Preview OS: a PR's next push cancels its run in progress; a dispatch cancels nothing", () => {
  const cancels = (event: string) =>
    evaluate(preview.concurrency["cancel-in-progress"].replace(/^\$\{\{ (.*) \}\}$/, "$1"), {
      "github.event_name": event,
    });
  expect(cancels("pull_request")).toBe(true);
  expect(cancels("workflow_dispatch")).toBe(false);
});

// Why the suites start with the run: .depot/workflows/preview-os.yml (STARTED WITH THE RUN). Each
// decides whether the PR changes a preview path as Deploy preview does, before it installs anything,
// and the steps after that pass on a PR that changes none.
test("Preview OS's suites decide as Deploy preview does whether there is a preview, then wait for it", () => {
  const deploySteps = preview.jobs.deploy!.steps || [];
  const steps = preview.jobs.e2e!.steps || [];
  const changes = steps.findIndex((step) => step.id === "changes");
  expect(steps[changes]).toEqual(deploySteps.find((step) => step.id === "changes"));
  // on the commit deploy tests, resolved right after the checkout, as in deploy
  expect(changes).toBe(steps.findIndex((step) => step.id === "tested") + 1);
  expect(changes).toBe(steps.findIndex((step) => step.uses === "actions/checkout@v4") + 2);
  const after = steps.slice(changes + 1, steps.findIndex((step) => step.id === "suite") + 1);
  // the specs' browser restore also skips in E2E tests
  expect(after.map((step) => step.if)).toEqual(
    after.map((step) =>
      step.id === "playwright"
        ? "steps.changes.outputs.preview != 'false' && env.SUITE == 'specs'"
        : "steps.changes.outputs.preview != 'false'",
    ),
  );
  expect(steps.findIndex((step) => step.name === "Setup")).toBeGreaterThan(changes);
});

// The wait is bounded by the deploy's own timeout, and the suite by its 30 minutes after it
// (scripts/os/preview.ts `runBounded`), so the job's timeout is never what stops a suite. The
// first specs shard then collects the others, for as long as its step's timeout, which outlasts the
// collection's own bound (scripts/ci/specs-shards.ts).
test("Preview OS's suite jobs outlast the deploy they wait for and then their suite's 30 minutes, and Browser specs outlasts them", () => {
  expect({ ...AWAIT_DEPLOY, suiteMs: SUITE_BOUND_MS }).toMatchObject({
    boundMs: preview.jobs.deploy!["timeout-minutes"]! * 60_000,
    suiteMs: 30 * 60_000,
  });
  for (const suite of suites)
    expect(preview.jobs[suite.job]!["timeout-minutes"]! * 60_000).toBe(
      AWAIT_DEPLOY.boundMs + SUITE_BOUND_MS,
    );
  // Browser specs waits for the shards longer than they can run, within its step's timeout, within
  // its job's (scripts/ci/specs-shards.ts COLLECT_BOUND_MS)
  const collect = preview.jobs.specs!.steps!.find((step) => step.id === "collect")!;
  expect(COLLECT_BOUND_MS).toBeGreaterThan(preview.jobs[SHARD_JOB]!["timeout-minutes"]! * 60_000);
  expect(collect["timeout-minutes"]! * 60_000).toBeGreaterThan(COLLECT_BOUND_MS);
  expect(preview.jobs.specs!["timeout-minutes"]!).toBeGreaterThan(collect["timeout-minutes"]!);
});

// THE REQUIRED CHECKS' TRUTH TABLE: when each suite job skips, passes having tested nothing, or
// fails for want of a preview, as preview-os.yml's REQUIRED CHECKS comment says, over every case.
type Run = {
  event: "pull_request" | "workflow_dispatch";
  action?: string;
  pr?: string;
  name?: string;
  deploy: string;
  preview?: string;
};
test.each<[string, Run, { e2e: string; specs: string; trace: boolean }]>([
  [
    "a PR that changes a preview path",
    { event: "pull_request", deploy: "success", preview: "true" },
    { e2e: "tests", specs: "tests", trace: true },
  ],
  [
    "a PR that changes none",
    { event: "pull_request", deploy: "success", preview: "false" },
    { e2e: "passes", specs: "passes", trace: false },
  ],
  [
    "a PR whose deploy failed",
    { event: "pull_request", deploy: "failure", preview: "true" },
    { e2e: "fails", specs: "fails", trace: true },
  ],
  [
    "a PR whose deploy failed before deciding",
    { event: "pull_request", deploy: "failure" },
    { e2e: "fails", specs: "fails", trace: true },
  ],
  [
    "a PR whose deploy was cancelled",
    { event: "pull_request", deploy: "cancelled", preview: "true" },
    { e2e: "fails", specs: "fails", trace: true },
  ],
  [
    "a deploy dispatch",
    { event: "workflow_dispatch", action: "deploy", pr: "123", deploy: "success" },
    { e2e: "tests", specs: "tests", trace: true },
  ],
  [
    "a deploy dispatch whose deploy failed",
    { event: "workflow_dispatch", action: "deploy", pr: "123", deploy: "failure" },
    { e2e: "fails", specs: "fails", trace: true },
  ],
  [
    "a deploy dispatch with no PR",
    { event: "workflow_dispatch", action: "deploy", deploy: "skipped" },
    { e2e: "fails", specs: "fails", trace: true },
  ],
  [
    "a test dispatch for a PR's preview",
    { event: "workflow_dispatch", action: "test", pr: "123", deploy: "skipped" },
    { e2e: "tests", specs: "tests", trace: true },
  ],
  [
    "a test dispatch for a preview by name",
    { event: "workflow_dispatch", action: "test", name: "main", deploy: "skipped" },
    { e2e: "tests", specs: "tests", trace: true },
  ],
  [
    "a test dispatch that names no preview",
    { event: "workflow_dispatch", action: "test", deploy: "skipped" },
    { e2e: "fails", specs: "fails", trace: true },
  ],
  [
    "an e2e dispatch",
    { event: "workflow_dispatch", action: "e2e", pr: "123", deploy: "skipped" },
    { e2e: "tests", specs: "skipped", trace: true },
  ],
  [
    "a specs dispatch for a preview by name",
    { event: "workflow_dispatch", action: "specs", name: "pr3035-ttg", deploy: "skipped" },
    { e2e: "skipped", specs: "tests", trace: true },
  ],
])("Preview OS on %s", (_, run, expected) => {
  const context: Record<string, string> = {
    "github.event_name": run.event,
    "inputs.action": run.action || "",
    "inputs.pull-request-number": run.pr || "",
    "inputs.preview-name": run.name || "",
    "needs.deploy.result": run.deploy,
    "needs.deploy.outputs.preview": run.preview || "",
  };
  // the job's own suite, from its env, and whether its path check ran and what it said
  const contextOf = (job: string) => ({
    ...context,
    "env.SUITE": preview.jobs[job]!.env!.SUITE!,
    "steps.changes.outputs.preview": run.event === "pull_request" ? run.preview || "true" : "",
  });
  const outcome = (job: string) => {
    const steps = preview.jobs[job]!.steps || [];
    const guard = steps.find((step) => step.name === "Require a preview to test");
    // first after naming the attempt: nothing is checked out or installed for a job that fails
    expect(steps.indexOf(guard!)).toBe(1);
    if (!evaluate(preview.jobs[job]!.if, context)) return "skipped";
    const jobContext = contextOf(job);
    if (evaluate(guard!.if, jobContext)) return "fails";
    const suite = steps.find((step) => step.id === "suite")!;
    if (!evaluate(suite.if, jobContext)) return "passes";
    const awaited = evaluate(
      suite.env!.PREVIEW_AWAIT_DEPLOY_JOB!.replace(/^\$\{\{ (.*) \}\}$/, "$1"),
      jobContext,
    );
    if (!awaited) return "tests";
    // the wait's rule: this run's deploy job finished, or there is no preview to test
    expect(awaited).toBe("deploy");
    return run.deploy === "success" ? "tests" : "fails";
  };
  const e2e = outcome("e2e");
  const specs = outcome(SHARD_JOB);
  // Browser specs: the suites' guard first, then their path check, then the shards' verdict
  const verdict = () => {
    const steps = preview.jobs.specs!.steps || [];
    if (!evaluate(preview.jobs.specs!.if, context)) return "skipped";
    expect(steps[0]).toMatchObject({ name: "Require a preview to test" });
    if (evaluate(steps[0]!.if, contextOf("specs"))) return "fails";
    const collect = steps.find((step) => step.id === "collect")!;
    if (!evaluate(collect.if, contextOf("specs"))) return "passes";
    return specs;
  };
  const result = (value: string) => (["tests", "passes"].includes(value) ? "success" : value);
  const trace = evaluate(preview.jobs.trace!.if, {
    ...context,
    "needs.e2e.result": e2e === "fails" ? "failure" : result(e2e),
    "needs.specs.result": verdict() === "fails" ? "failure" : result(verdict()),
  });
  expect({ e2e, specs, trace }).toEqual(expected);
  // the required check says what the shards did, and is skipped with them
  expect(verdict()).toBe(specs);
});

// The cleanup deletes only once this run's deployment is ready, and only this run's prefix's older
// ones (scripts/os/preview-sweep.ts planSupersededCleanup).
test.for([
  { name: "a deploy that deployed", deploy: "success", deployment: "pr123-a1b2c3d", runs: true },
  { name: "a PR that changes no preview path", deploy: "success", deployment: "", runs: false },
  { name: "a deploy that failed", deploy: "failure", deployment: "pr123-a1b2c3d", runs: false },
  { name: "a deploy that was cancelled", deploy: "cancelled", deployment: "", runs: false },
])("Clean up superseded after $name ⇒ runs: $runs", ({ deploy, deployment, runs }) => {
  expect(
    evaluate(preview.jobs.cleanup!.if, {
      "needs.deploy.result": deploy,
      "needs.deploy.outputs.deployment": deployment,
    }),
  ).toBe(runs);
  expect(preview.jobs.cleanup!.steps?.at(-1)?.env).toMatchObject({
    PREVIEW_DEPLOYMENT: "${{ needs.deploy.outputs.deployment }}",
  });
});

// A PR's preview is `pr<n>` whatever its branch (scripts/os/preview-config.ts
// resolvePreviewPrefix), and `pnpm preview` takes flags only: its suite step passes `--pr` the PR's
// number and `--name` the dispatch's preview-name, each when set.
test("a test job names its preview by the PR's number, or by preview-name without one", () => {
  expect(preview.env).toMatchObject({
    PR_NUMBER: "${{ github.event.pull_request.number || inputs.pull-request-number }}",
  });
  for (const suite of suites) {
    const step = preview.jobs[suite.job]!.steps?.find((step) => step.id === "suite");
    expect(step).toMatchObject({
      env: {
        DEPLOYMENT_PREFIX: "${{ inputs.preview-name }}",
        SLOW_ROWS: "${{ inputs.slow-rows }}",
      },
      run: suiteRun,
    });
  }
  expect(preview.on.workflow_dispatch?.inputs).toMatchObject({
    "preview-name": {},
    "slow-rows": {},
  });
});

// Browser specs has a preview to test exactly when the suites do: their steps, then the collection
// of the shards' reports (scripts/ci/specs-shards.ts), whose merged report it uploads.
test("Browser specs decides as the suites do whether there is a preview, then collects the shards", () => {
  const steps = preview.jobs.specs!.steps || [];
  const suiteSteps = preview.jobs.e2e!.steps || [];
  const shared = [
    "Require a preview to test",
    "Checkout the PR head",
    "Check out the PR merged into main",
    "Decide whether the PR changes a preview path",
  ];
  expect(steps.slice(0, 4)).toEqual(
    shared.map((name) => suiteSteps.find((step) => step.name === name)),
  );
  expect(steps.slice(4).map((step) => [step.name, step.if])).toEqual([
    ["Setup", "steps.changes.outputs.preview != 'false'"],
    ["Collect the shards' results", "steps.changes.outputs.preview != 'false'"],
    [
      "Upload public Playwright HTML report",
      "${{ always() && steps.collect.outputs.playwright-report == 'written' }}",
    ],
  ]);
  // the suites neither collect nor upload a report of their own
  for (const name of ["Collect the shards' results", "Upload public Playwright HTML report"])
    expect(suiteSteps.map((step) => step.name)).not.toContain(name);
});

// The evidence is kept once the suite read its deployed target, and the steps after the finalizer
// follow its outputs (scripts/ci/test-evidence.ts `finalize`).
test("a test job keeps its evidence whenever its suite read its deployed target, and only then", () => {
  for (const suite of suites) {
    const steps = preview.jobs[suite.job]!.steps || [];
    const evidence = steps.slice(steps.findIndex((step) => step.id === "suite") + 1);
    expect(evidence[0]).toMatchObject({
      id: "evidence-write",
      if: "${{ always() && steps.suite.outcome != 'skipped' }}",
      run: expect.stringContaining("finalize --only-with-target"),
    });
    expect(evidence.slice(1).map((step) => [step.name, step.if])).toEqual([
      [
        "Upload the test evidence to R2",
        "${{ always() && steps.evidence-write.outputs.manifest == 'written' }}",
      ],
      // the Depot artifact also after a step that failed before it could say it kept them
      [
        "Upload results",
        "${{ always() && (steps.evidence-write.outputs.evidence == 'kept' || steps.evidence-write.outcome == 'failure') }}",
      ],
      [
        "Report a test evidence step that could not",
        "${{ always() && (steps.evidence-write.outcome == 'failure' || steps.evidence-upload.outcome == 'failure') }}",
      ],
    ]);
  }
});
