import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

/** The parts of .depot/workflows/preview-os.yml these tests read. */
type PreviewWorkflow = {
  env?: Record<string, string>;
  jobs: Record<
    string,
    {
      if?: string;
      name?: string;
      needs?: string | string[];
      outputs?: Record<string, string>;
      steps?: Array<{
        id?: string;
        name?: string;
        run?: string;
        uses?: string;
        with?: { ref?: string };
        env?: Record<string, string>;
      }>;
    }
  >;
};

const preview = parseYaml(
  readFileSync(resolve(import.meta.dirname, "../../.depot/workflows/preview-os.yml"), "utf8"),
) as PreviewWorkflow;

test("Preview OS deploys in one job and runs the suite in the next", () => {
  expect(preview.jobs.deploy.steps?.map((step) => step.run)).not.toContain(
    "doppler run -- pnpm preview e2e",
  );
  expect([preview.jobs.e2e.needs].flat()).toEqual(["deploy"]);
  expect(preview.jobs.e2e.steps?.map((step) => step.run)).toContain(
    "doppler run -- pnpm preview e2e",
  );
});

test("Preview OS deploys the PR merged into main, and e2e uses that very commit", () => {
  const deploySteps = preview.jobs.deploy.steps || [];
  const resolve = deploySteps.findIndex((step) => step.id === "tested");
  const deploy = deploySteps.findIndex((step) => step.run?.includes('pnpm preview "$ACTION"'));
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
  expect(deploySteps[deploy]?.env?.PREVIEW_TESTED_COMMIT).toBe(
    "${{ steps.tested.outputs.description }}",
  );
  expect(preview.jobs.deploy.outputs?.["tested-sha"]).toBe("${{ steps.tested.outputs.sha }}");
  // e2e and trace run the scripts of the tree deploy tested, not of the PR head alone
  for (const job of [preview.jobs.e2e, preview.jobs.trace]) {
    const checkout = job.steps?.find((step) => step.uses === "actions/checkout@v4");
    expect(checkout?.with?.ref).toMatch(/^\$\{\{ needs\.deploy\.outputs\.tested-sha \|\| /);
  }
  // the trace's statuses still go on the PR head
  expect(
    preview.jobs.trace.steps?.find((step) => step.name === "Record the traced commit")?.env,
  ).toEqual({ HEAD_SHA: "${{ needs.deploy.outputs.head-sha }}" });
});

test("Preview OS: only the trace and the gate run after the suite, and the gate starts no deploy", () => {
  const afterSuite = Object.entries(preview.jobs).filter(([, job]) =>
    [job.needs].flat().includes("e2e"),
  );
  expect(afterSuite.map(([jobId]) => jobId)).toEqual(["trace", "gate"]);
  expect(preview.jobs.gate.steps?.map((step) => step.run).filter(Boolean)).toEqual([
    "node scripts/ci/preview-os-gate.ts verdict",
  ]);
});

// scripts/ci/preview-os-gate.ts: the changes job decides from the run's merge commit, on pull
// requests only; a dispatch names its operation and a merge-queue group deploys nothing.
test("Preview OS: changes diffs the run's merge commit against its first parent", () => {
  expect(preview.jobs.changes).toMatchObject({
    if: "github.event_name == 'pull_request'",
    outputs: { preview: "${{ steps.match.outputs.preview }}" },
    steps: [
      { uses: "actions/checkout@v4", with: { ref: "${{ github.sha }}", "fetch-depth": 2 } },
      { id: "match", run: "node scripts/ci/preview-os-gate.ts changes" },
    ],
  });
});

// The gate reads every job it needs whatever they did, and hands their results to the verdict.
test("Preview OS: the gate always runs, last, on the results of changes, deploy and e2e", () => {
  expect(preview.jobs.gate).toMatchObject({
    needs: ["changes", "deploy", "e2e"],
    if: "always()",
  });
  expect(preview.jobs.gate.steps?.at(-1)?.env).toEqual({
    PREVIEW_GATE_EVENT: "${{ github.event_name }}",
    PREVIEW_GATE_CHANGES: "${{ needs.changes.result }}",
    PREVIEW_GATE_TOUCHED: "${{ needs.changes.outputs.preview }}",
    PREVIEW_GATE_DEPLOY: "${{ needs.deploy.result }}",
    PREVIEW_GATE_E2E: "${{ needs.e2e.result }}",
  });
});

// A pull request deploys when changes found a preview path; a dispatch when it asks for a deploy or
// a reset; a merge-queue group never.
test.each([
  ["pull_request", "", "true", true],
  ["pull_request", "", "false", false],
  // changes failed: no output, no deploy, and the gate goes red on the failure
  ["pull_request", "", "", false],
  ["workflow_dispatch", "deploy", "", true],
  ["workflow_dispatch", "reset", "", true],
  ["workflow_dispatch", "e2e", "", false],
  ["merge_group", "", "", false],
])(
  "Preview OS: deploy on %s action=%s with changes preview=%s runs: %s",
  (event, action, touched, expected) => {
    expect(
      runs(preview.jobs.deploy.if || "", {
        "github.event_name": event,
        "inputs.action": action,
        "inputs.pull-request-number": event === "workflow_dispatch" ? "123" : "",
        "needs.changes.outputs.preview": touched,
      }),
    ).toBe(expected);
  },
);

// After every deploy that succeeded, never after one that did not, and alone (deploy skipped) on
// a dispatch with action=e2e.
test.each([
  ["pull_request", "", "success", true],
  ["pull_request", "", "failure", false],
  ["pull_request", "", "cancelled", false],
  ["pull_request", "", "skipped", false],
  ["workflow_dispatch", "deploy", "success", true],
  ["workflow_dispatch", "reset", "success", true],
  ["workflow_dispatch", "reset", "failure", false],
  ["workflow_dispatch", "e2e", "skipped", true],
])(
  "Preview OS: e2e on %s action=%s after a %s deploy runs: %s",
  (event, action, result, expected) => {
    expect(
      runs(
        preview.jobs.e2e.if || "",
        {
          "github.event_name": event,
          "inputs.action": action,
          "inputs.pull-request-number": event === "workflow_dispatch" ? "123" : "",
          "needs.deploy.result": result,
        },
        result === "success",
      ),
    ).toBe(expected);
  },
);

// docs/ci-traces.md: every run step's markers, the e2e step as the Test phase, and one trace job
// after deploy and e2e settle.
test("the CI trace collects deploy and e2e after both settle and posts its status", () => {
  expect(preview.env).toMatchObject({
    BASH_ENV: "${{ github.workspace }}/scripts/ci/tracing/shell.sh",
    CI_TRACE_ENABLED: "1",
  });
  expect(
    preview.jobs.e2e.steps?.find((step) => step.run === "doppler run -- pnpm preview e2e"),
  ).toMatchObject({ id: "e2e" });
  expect(preview.jobs.trace).toMatchObject({
    needs: ["deploy", "e2e"],
    if: expect.stringContaining("always()"),
  });
  const runs = (preview.jobs.trace.steps || []).map((step) => step.run || step.uses || "");
  const order = [
    runs.findIndex((run) => run.includes("scripts/ci/tracing/cli.ts current")),
    runs.indexOf("actions/upload-artifact@v4"),
    runs.findIndex((run) => run.includes("scripts/ci/tracing/cli.ts publish")),
  ];
  expect(order.every((index) => index >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

/**
 * Enough of the expression language for these conditions: without a status function a job's `if`
 * is `success() && (...)`, which a skipped or failed job it needs makes false (`neededSucceeded`).
 * Then always(), quoted strings, ==, !=, &&, || and parentheses are JavaScript once each context
 * path is replaced by its value.
 */
function runs(condition: string, context: Record<string, string>, neededSucceeded = false) {
  const javascript = (condition.includes("always()") ? condition : `success() && (${condition})`)
    .replaceAll("always()", "true")
    .replaceAll("success()", String(neededSucceeded))
    .replace(/[a-z_]+(?:\.[a-z_-]+)+/g, (path) => {
      expect(context, `${path} is not in the test's context`).toHaveProperty([path]);
      return JSON.stringify(context[path]);
    });
  // oxlint-disable-next-line no-new-func -- evaluating the workflow's own condition IS the test
  return new Function(`return (${javascript});`)() as boolean;
}
