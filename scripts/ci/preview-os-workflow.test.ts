import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { AWAIT_DEPLOY, SUITE_BOUND_MS } from "./await-deploy.ts";
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
// Both suite jobs run one step list; the job's SUITE picks what it runs.
const suites = [
  { job: "e2e", name: "E2E tests", suite: "e2e" },
  { job: "specs", name: "Browser specs", suite: "specs" },
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
    cleanup: "Clean up superseded",
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
  expect(runs("deploy")).not.toContain(suiteRun);
});

// Why the two suite jobs share one definition: .depot/workflows/preview-os.yml (THE TWO SUITES).
test("Preview OS's two suite jobs are one definition, differing only in the suite they name", () => {
  const [e2e, specs] = [preview.jobs.e2e!, preview.jobs.specs!];
  expect(specs).toMatchObject({
    steps: e2e.steps,
    "timeout-minutes": e2e["timeout-minutes"],
  });
  // written once: the second job aliases the first's
  expect(source.match(/^ {4}steps: \*suite-steps$/gmu)).toHaveLength(1);
  const suiteEnv = ["SUITE", "FLAKE_SUITE", "TEST_TELEMETRY_EXPECTED_WORKSPACES"];
  const shared = (env: Record<string, string> = {}) =>
    Object.fromEntries(Object.entries(env).filter(([name]) => !suiteEnv.includes(name)));
  expect(shared(specs.env)).toEqual(shared(e2e.env));
  expect([e2e.env, specs.env]).toMatchObject([
    { SUITE: "e2e", FLAKE_SUITE: "preview-e2e", TEST_TELEMETRY_EXPECTED_WORKSPACES: "os" },
    { SUITE: "specs", FLAKE_SUITE: "specs", TEST_TELEMETRY_EXPECTED_WORKSPACES: "iterate-root" },
  ]);
  // each skips on a dispatch of the other suite alone, and that is the only difference
  expect(specs.if?.replace("inputs.action != 'e2e'", "inputs.action != 'specs'")).toBe(e2e.if);
});

// Why each suite runs on its size: docs/depot-ci.md#reliability-defaults.
test("Preview OS's E2E tests run on the smallest runner, and Browser specs on a 4x16", () => {
  expect(preview.jobs.e2e!["runs-on"]).toBe("depot-ubuntu-24.04");
  expect(preview.jobs.specs!["runs-on"]).toBe("depot-ubuntu-24.04-4");
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
    run: "node scripts/ci/preview-inherit.ts",
  });
  // decided on the tested commit, before anything is installed
  expect(changes).toBe(steps.findIndex((step) => step.id === "tested") + 1);
  expect(steps.slice(changes + 1).map((step) => step.if)).toEqual(
    steps.slice(changes + 1).map(() => "steps.changes.outputs.preview != 'false'"),
  );
  expect(preview.jobs.deploy!.outputs?.preview).toBe("${{ steps.changes.outputs.preview }}");
});

test("Preview OS deploys the PR's head, and the test jobs test that very commit", () => {
  const suiteSteps = preview.jobs.e2e!.steps || [];
  const deploySteps = preview.jobs.deploy!.steps || [];
  const deployCheckout = deploySteps.findIndex((step) => step.uses === "actions/checkout@v4");
  const tested = deploySteps.findIndex((step) => step.id === "tested");
  const deploy = deploySteps.findIndex((step) => step.run?.includes("pnpm preview deploy"));
  expect(deploySteps[deployCheckout]?.with?.ref).toBe(
    "${{ github.event.pull_request.head.sha || format('refs/pull/{0}/head', inputs.pull-request-number) }}",
  );
  // the head as checked out, recorded before anything is installed or deployed
  expect(tested).toBe(deployCheckout + 1);
  expect(deploySteps[tested]?.run).toBe('echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"');
  expect(tested).toBeLessThan(deploy);
  expect(preview.jobs.deploy!.outputs).toMatchObject({
    "tested-sha": "${{ steps.tested.outputs.sha }}",
    // the name preview.ts gives the deployment, `pr<n>-<sha7>` of the tested commit, for the cleanup
    deployment: "${{ steps.deploy.outputs.deployment }}",
  });
  expect(deploySteps[deploy]?.id).toBe("deploy");
  // the suites check out the same head, and nothing moves them off it
  const suiteCheckouts = suiteSteps.filter((step) => step.uses === "actions/checkout@v4");
  expect(suiteCheckouts).toMatchObject([
    {
      with: {
        ref: "${{ github.event.pull_request.head.sha || (inputs.pull-request-number != '' && format('refs/pull/{0}/head', inputs.pull-request-number)) || github.sha }}",
      },
    },
  ]);
  // the trace checks out that commit and posts its statuses on it
  expect(
    preview.jobs.trace!.steps?.find((step) => step.uses === "actions/checkout@v4")?.with?.ref,
  ).toMatch(/^\$\{\{ needs\.deploy\.outputs\.tested-sha \|\| /);
  expect(
    preview.jobs.trace!.steps?.find((step) => step.name === "Record the traced commit")?.env,
  ).toEqual({ HEAD_SHA: "${{ needs.deploy.outputs.tested-sha }}" });
});

// Whether a PR run reuses a deployment (apps/os/scripts/preview-reuse.ts) only its deploy knows: the
// suites read its plan from the run's artifact once their wait is over (preview.ts `planOfThisRun`).
// Which part of its suite to run, each suite job's own first step chose (preview-inherit.ts).
test("Deploy preview hands its plan to the suites, and each suite runs the part its first step chose", () => {
  const deploySteps = preview.jobs.deploy!.steps || [];
  const deploy = deploySteps.findIndex((step) => step.id === "deploy");
  expect(deploySteps[deploy + 1]).toMatchObject({
    uses: "actions/upload-artifact@v4",
    with: { name: "preview-plan", path: "apps/os/output/preview.json" },
  });
  const suite = (preview.jobs.e2e!.steps || []).find((step) => step.id === "suite");
  expect(suite?.env).toMatchObject({
    PREVIEW_SELECTION: "${{ steps.changes.outputs.selection }}",
  });
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
// decides whether it inherits as Deploy preview does, before it installs anything, and the steps
// after that pass on a push it inherits for.
test("Preview OS's suites decide as Deploy preview does whether there is a preview, then wait for it", () => {
  const deploySteps = preview.jobs.deploy!.steps || [];
  const steps = preview.jobs.e2e!.steps || [];
  const changes = steps.findIndex((step) => step.id === "changes");
  // for this job's suite alone, where Deploy preview's is for both (scripts/ci/preview-inherit.ts)
  expect(steps[changes]).toEqual({
    ...deploySteps.find((step) => step.id === "changes"),
    env: {
      ...deploySteps.find((step) => step.id === "changes")?.env,
      PREVIEW_SUITES: "${{ env.SUITE }}",
    },
  });
  // on the commit deploy tests, right after the checkout
  expect(changes).toBe(steps.findIndex((step) => step.uses === "actions/checkout@v4") + 1);
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
// (apps/os/scripts/preview.ts `runBounded`), so the job's timeout is never what stops a suite.
test("Preview OS's suite jobs outlast the deploy they wait for, and then their suite's 30 minutes", () => {
  expect({ ...AWAIT_DEPLOY, suiteMs: SUITE_BOUND_MS }).toMatchObject({
    boundMs: preview.jobs.deploy!["timeout-minutes"]! * 60_000,
    suiteMs: 30 * 60_000,
  });
  for (const suite of suites)
    expect(preview.jobs[suite.job]!["timeout-minutes"]! * 60_000).toBe(
      AWAIT_DEPLOY.boundMs + SUITE_BOUND_MS,
    );
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
  const outcome = (job: string) => {
    const steps = preview.jobs[job]!.steps || [];
    const guard = steps.find((step) => step.name === "Require a preview to test");
    // first after naming the attempt: nothing is checked out or installed for a job that fails
    expect(steps.indexOf(guard!)).toBe(1);
    if (!evaluate(preview.jobs[job]!.if, context)) return "skipped";
    // the job's own suite, from its env, and whether its path check ran and what it said
    const jobContext = {
      ...context,
      "env.SUITE": preview.jobs[job]!.env!.SUITE!,
      "steps.changes.outputs.preview": run.event === "pull_request" ? run.preview || "true" : "",
    };
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
  const specs = outcome("specs");
  const result = (value: string) => (["tests", "passes"].includes(value) ? "success" : value);
  const trace = evaluate(preview.jobs.trace!.if, {
    ...context,
    "needs.e2e.result": e2e === "fails" ? "failure" : result(e2e),
    "needs.specs.result": specs === "fails" ? "failure" : result(specs),
  });
  expect({ e2e, specs, trace }).toEqual(expected);
});

// The cleanup deletes only once this run's deployment is ready, and only this run's prefix's older
// ones (apps/os/scripts/preview-sweep.ts planSupersededCleanup).
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

// A PR's preview is `pr<n>` whatever its branch (apps/os/scripts/preview-config.ts
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
      // the Playwright report only the specs write
      [
        "Upload public Playwright HTML report",
        "${{ always() && steps.evidence-write.outputs.playwright-report == 'written' }}",
      ],
      [
        "Report a test evidence step that could not",
        "${{ always() && (steps.evidence-write.outcome == 'failure' || steps.evidence-upload.outcome == 'failure') }}",
      ],
    ]);
  }
});
