import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

/** The parts of .depot/workflows/preview-os-next.yml these tests read. */
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
  readFileSync(resolve(import.meta.dirname, "../../.depot/workflows/preview-os-next.yml"), "utf8"),
) as PreviewWorkflow;

describe("the OS-Next preview workflow", () => {
  test("deploys in one job and runs the suite in the next", () => {
    expect(preview.jobs.deploy.steps?.map((step) => step.run)).not.toContain(
      "doppler run -- pnpm preview e2e",
    );
    expect([preview.jobs.e2e.needs].flat()).toEqual(["deploy"]);
    expect(preview.jobs.e2e.steps?.map((step) => step.run)).toContain(
      "doppler run -- pnpm preview e2e",
    );
  });

  test("deploys the PR merged into main, and e2e uses that very commit", () => {
    const deploySteps = preview.jobs.deploy.steps || [];
    const resolve = deploySteps.findIndex((step) => step.id === "tested");
    const deploy = deploySteps.findIndex((step) => step.run?.includes('pnpm preview "$ACTION"'));
    expect(deploySteps[resolve]?.run).toBe("node scripts/ci/preview-tested-commit.ts");
    // resolved before anything is installed or deployed from the checkout
    expect(resolve).toBeLessThan(
      deploySteps.findIndex((step) => step.name === "Reconcile dependencies (baked)"),
    );
    expect(resolve).toBeLessThan(deploy);
    expect(deploySteps[deploy]?.env?.PREVIEW_TESTED_COMMIT).toBe(
      "${{ steps.tested.outputs.description }}",
    );
    expect(preview.jobs.deploy.outputs?.["tested-sha"]).toBe("${{ steps.tested.outputs.sha }}");
    const checkout = preview.jobs.e2e.steps?.find((step) => step.uses === "actions/checkout@v4");
    expect(checkout?.with?.ref).toMatch(/^\$\{\{ needs\.deploy\.outputs\.tested-sha \|\| /);
  });

  test("only the trace runs after the suite, so the next push's deploy waits for nothing else", () => {
    const afterSuite = Object.entries(preview.jobs).filter(([, job]) =>
      [job.needs].flat().includes("e2e"),
    );
    expect(afterSuite.map(([jobId]) => jobId)).toEqual(["trace"]);
  });

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
  ])("e2e on %s action=%s after a %s deploy runs: %s", (event, action, result, runs) => {
    const condition = preview.jobs.e2e.if || "";
    const context: Record<string, string> = {
      "github.event_name": event,
      "inputs.action": action,
      "inputs.pull-request-number": event === "workflow_dispatch" ? "123" : "",
      "needs.deploy.result": result,
    };
    // Enough of the expression language for this condition: without a status function a job's
    // `if` is `success() && (...)`, which a skipped or failed deploy makes false. Then always(),
    // quoted strings, ==, !=, &&, || and parentheses are JavaScript once each context path is
    // replaced by its value.
    const javascript = (condition.includes("always()") ? condition : `success() && (${condition})`)
      .replaceAll("always()", "true")
      .replaceAll("success()", String(result === "success"))
      .replace(/[a-z_]+(?:\.[a-z_-]+)+/g, (path) => {
        expect(context, `${path} is not in the test's context`).toHaveProperty([path]);
        return JSON.stringify(context[path]);
      });
    // oxlint-disable-next-line no-new-func -- evaluating the workflow's own condition IS the test
    expect(new Function(`return (${javascript});`)()).toBe(runs);
  });
});

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
