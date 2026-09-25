import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

type PreviewStep = {
  id?: string;
  if?: string;
  name?: string;
  parallel?: PreviewStep[];
  run?: string;
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
      "runs-on"?: { size: string; image: string };
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
const suiteRun = 'doppler run -- pnpm preview "$SUITE"';

test("Preview OS names each job for the check it is: deploy, then the two suites and the cleanup side by side, then the trace", () => {
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
  expect(runs("deploy")).toContain("doppler run -- pnpm preview deploy");
  expect([preview.jobs.cleanup!.needs].flat()).toEqual(["deploy"]);
  expect(runs("cleanup")).toContain("doppler run -- pnpm preview cleanup-superseded");
  for (const suite of suites) {
    expect([preview.jobs[suite.job]!.needs].flat()).toEqual(["deploy"]);
    // one suite per job: specs share no runner's CPU with vitest
    expect(preview.jobs[suite.job]!.env?.SUITE).toBe(suite.suite);
    expect(runs(suite.job)).toContain(suiteRun);
  }
  expect(runs("deploy")).not.toContain(suiteRun);
});

// ONE DEFINITION: Browser specs is E2E tests' runner and steps (YAML aliases), and the two jobs
// differ only in the suite their env names and in the dispatch that skips them.
test("Preview OS's two suite jobs are one definition, differing only in the suite they name", () => {
  const [e2e, specs] = [preview.jobs.e2e!, preview.jobs.specs!];
  expect(specs).toMatchObject({
    steps: e2e.steps,
    "runs-on": e2e["runs-on"],
    "timeout-minutes": e2e["timeout-minutes"],
  });
  // written once: the second job aliases the first's
  expect(source.match(/^ {4}steps: \*suite-steps$/gmu)).toHaveLength(1);
  expect(source.match(/^ {4}runs-on: \*suite-runner$/gmu)).toHaveLength(1);
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

// Both suites wait on a remote preview: on 4x16 they peaked at 53 % of four vCPUs and 20 % of 16 GB
// (measured 2026-09-24; docs/depot-ci.md#reliability-defaults).
test("Preview OS's suites run on the smallest runner", () => {
  expect(preview.jobs.e2e!["runs-on"]?.size).toBe("2x8");
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
  const deploySteps = preview.jobs.deploy!.steps || [];
  const resolve = deploySteps.findIndex((step) => step.id === "tested");
  const deploy = deploySteps.findIndex((step) => step.run === "doppler run -- pnpm preview deploy");
  expect(deploySteps[resolve]?.run).toBe("node scripts/ci/preview-tested-commit.ts");
  // on a push, the run's own commit: the merge commit this workflow file was read from
  expect(deploySteps[resolve]?.env?.PREVIEW_RUN_SHA).toBe(
    "${{ github.event_name == 'pull_request' && github.sha || '' }}",
  );
  // resolved before anything is installed or deployed from the checkout
  expect(resolve).toBeLessThan(
    deploySteps.findIndex((step) => step.name === "Reconcile dependencies (baked)"),
  );
  expect(resolve).toBeLessThan(deploy);
  expect(preview.jobs.deploy!.outputs).toMatchObject({
    "tested-sha": "${{ steps.tested.outputs.sha }}",
    // the name preview.ts gives the deployment, `pr<n>-<sha7>` of the tested commit
    deployment: "${{ steps.deploy.outputs.deployment }}",
  });
  expect(deploySteps[deploy]?.id).toBe("deploy");
  // the test jobs and the trace run the scripts of the tree deploy tested, not of the PR head alone
  for (const job of [preview.jobs.e2e!, preview.jobs.specs!, preview.jobs.trace!]) {
    const checkout = job.steps?.find((step) => step.uses === "actions/checkout@v4");
    expect(checkout?.with?.ref).toMatch(/^\$\{\{ needs\.deploy\.outputs\.tested-sha \|\| /);
  }
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

// THE REQUIRED CHECKS' TRUTH TABLE (docs/depot-ci.md#preview-job-shape). GitHub counts a skipped
// job as passing, so each suite's job skips only when there is nothing for it to prove: a PR that
// changes no preview path, or a dispatch of the other suite alone. Wherever a preview was needed
// and none was deployed, the job runs and its "Require a deployed preview" step fails it.
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
    { e2e: "skipped", specs: "skipped", trace: false },
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
    const guard = steps.find((step) => step.name === "Require a deployed preview");
    // first after naming the attempt: nothing is checked out or installed for a job that fails
    expect(steps.indexOf(guard!)).toBe(1);
    if (!evaluate(preview.jobs[job]!.if, context)) return "skipped";
    // the job's own suite, from its env
    const jobContext = { ...context, "env.SUITE": preview.jobs[job]!.env!.SUITE! };
    return evaluate(guard!.if, jobContext) ? "fails" : "tests";
  };
  const e2e = outcome("e2e");
  const specs = outcome("specs");
  const result = (value: string) => (value === "tests" ? "success" : value);
  const trace = evaluate(preview.jobs.trace!.if, {
    ...context,
    "needs.e2e.result": e2e === "fails" ? "failure" : result(e2e),
    "needs.specs.result": specs === "fails" ? "failure" : result(specs),
  });
  expect({ e2e, specs, trace }).toEqual(expected);
});

// A PR's deployments are `pr<n>-<sha7>` whatever its branch (apps/os/scripts/preview-config.ts
// resolvePreviewPrefix): a suite tests the one its run deployed, and a test-only dispatch the newest
// of the PR's, or of preview-name's without one.
test("a test job tests the deployment its run made, else the newest of the PR's or preview-name's", () => {
  for (const suite of suites) {
    const step = preview.jobs[suite.job]!.steps?.find((step) => step.id === "suite");
    expect(step?.env).toMatchObject({
      PREVIEW_DEPLOYMENT: "${{ needs.deploy.outputs.deployment }}",
      PREVIEW_NAME: "${{ inputs.preview-name }}",
      PREVIEW_PR_NUMBER: "${{ env.PR_NUMBER }}",
    });
  }
  expect(preview.on.workflow_dispatch?.inputs).toHaveProperty("preview-name");
});

// The cleanup deletes only once this run's deployment is ready, and only this run's prefix's older
// ones (apps/os/scripts/preview-sweep.ts planSupersededCleanup).
test.each([
  { deploy: "success", deployment: "pr123-a1b2c3d", runs: true },
  // a PR that changes no preview path deploys nothing
  { deploy: "success", deployment: "", runs: false },
  { deploy: "failure", deployment: "pr123-a1b2c3d", runs: false },
  { deploy: "cancelled", deployment: "", runs: false },
])(
  "Clean up superseded after a deploy that ended $deploy, deployment '$deployment' ⇒ runs: $runs",
  ({ deploy, deployment, runs }) => {
    expect(
      evaluate(preview.jobs.cleanup!.if, {
        "needs.deploy.result": deploy,
        "needs.deploy.outputs.deployment": deployment,
      }),
    ).toBe(runs);
    expect(preview.jobs.cleanup!.steps?.at(-1)?.env).toMatchObject({
      PREVIEW_DEPLOYMENT: "${{ needs.deploy.outputs.deployment }}",
    });
  },
);

// Without a preview there is nothing to keep: the evidence steps follow the suite, not the guard.
// The R2 upload and its fallback report follow the manifest's write, and the Playwright report
// exists only once the specs ran.
test("a test job keeps its evidence whenever its suite started, and only then", () => {
  for (const suite of suites) {
    const steps = preview.jobs[suite.job]!.steps || [];
    const evidence = steps.slice(steps.findIndex((step) => step.id === "suite") + 1);
    const followers = evidence.filter(
      (step) =>
        step.id === "evidence-upload" ||
        step.name === "Report a test evidence step that could not" ||
        step.with?.name === "public-playwright-report",
    );
    expect(evidence.length - followers.length).toBeGreaterThan(0);
    for (const step of evidence.filter((step) => !followers.includes(step)))
      expect(step, step.name).toMatchObject({
        if: "always() && steps.suite.outcome != 'skipped'",
      });
    // the Playwright report only the specs write
    expect(followers.map((step) => step.if)).toEqual([
      "${{ always() && hashFiles('test-results/manifest.json') != '' }}",
      "${{ always() && hashFiles('test-results/playwright-html/index.html') != '' }}",
      "${{ always() && (steps.evidence-write.outcome == 'failure' || steps.evidence-upload.outcome == 'failure') }}",
    ]);
  }
});

/**
 * Enough of the expression language for these conditions: the jobs' `always()`, then quoted strings,
 * ==, !=, !, &&, || and parentheses are JavaScript once each context path is replaced by its value.
 * A step's condition without a status function is `success() && (...)`, true here: only the attempt
 * step ran before the guard.
 */
function evaluate(condition: string | undefined, context: Record<string, string>) {
  const javascript = (condition || "true")
    .replaceAll("always()", "true")
    .replace(/[a-z_]+(?:\.[A-Za-z0-9_-]+)+/g, (path) => {
      expect(context, `${path} is not in the test's context`).toHaveProperty([path]);
      return JSON.stringify(context[path]);
    });
  // oxlint-disable-next-line no-new-func -- evaluating the workflow's own condition IS the test
  return new Function(`return (${javascript});`)() as boolean;
}
