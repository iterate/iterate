import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { assertPreviewCiIdentity, readPreviewCiResults } from "./ci-identity.ts";
import {
  assertPlaywrightCapacity,
  previewPlaywrightShards,
} from "./playwright-capacity-reporter.ts";

test("distributed preview work refuses another head, run attempt, or slot", () => {
  const plan = { headSha: "candidate", runId: "run-1", runAttempt: "1", slot: "preview-2" };
  expect(() => assertPreviewCiIdentity(plan, { ...plan })).not.toThrow();
  for (const changed of [
    { headSha: "new-push" },
    { runId: "run-2" },
    { runAttempt: "2" },
    { slot: "preview-3" },
  ]) {
    expect(() => assertPreviewCiIdentity(plan, { ...plan, ...changed })).toThrow(
      /Preview CI identity mismatch/,
    );
  }
});

test("fixed capacity rejects catalogue growth and an overloaded individual shard", () => {
  expect(() => assertPlaywrightCapacity({ tests: 92, workers: 16, shard: null })).not.toThrow();
  expect(() => assertPlaywrightCapacity({ tests: 97, workers: 16, shard: null })).toThrow(
    /96 slots/,
  );
  expect(() =>
    assertPlaywrightCapacity({ tests: 16, workers: 16, shard: { current: 1, total: 6 } }),
  ).not.toThrow();
  expect(() =>
    assertPlaywrightCapacity({ tests: 17, workers: 16, shard: { current: 1, total: 6 } }),
  ).toThrow(/16 slots/);
  expect(() =>
    assertPlaywrightCapacity({ tests: 10, workers: 16, shard: { current: 1, total: 2 } }),
  ).toThrow(/six shards/);
});

test("the lifecycle owner encloses every fixed shard and cleanup waits for their completion", () => {
  const root = resolve(import.meta.dirname, "../..");
  const caller = parse(readFileSync(resolve(root, ".depot/workflows/preview.yml"), "utf8"));
  const workflow = parse(readFileSync(resolve(root, ".depot/workflows/preview-run.yml"), "utf8"));
  expect(caller.on.pull_request.paths).toBeUndefined();
  expect(workflow.jobs.plan.steps[0].with["fetch-depth"]).toBe("${{ inputs.all-apps && 10 || 0 }}");
  expect(workflow.jobs.prepare.needs).toBeUndefined();
  expect(workflow.jobs.prepare.if).toBeUndefined();
  const prepareSteps = workflow.jobs.prepare.steps;
  const waitForPlan = prepareSteps.findIndex((step: any) => step.id === "plan");
  expect(waitForPlan).toBeGreaterThan(
    prepareSteps.findIndex((step: any) => step.id === "install_dependencies"),
  );
  expect(prepareSteps[waitForPlan].run).toContain("wait-for plan preview-plan");
  for (const step of prepareSteps.slice(waitForPlan + 1)) {
    expect(step.if, step.name).toContain("steps.plan.outputs.tests == 'true'");
  }
  expect(workflow.jobs.plan.steps.at(-1)).toMatchObject({
    // Inherited red still publishes its decision before the producer stops.
    if: "always() && steps.plan.outputs.tests != ''",
    run: expect.stringContaining('set preview-plan --values "$PLAN_VALUES"'),
  });
  // The shell tracer adds ci-trace-end to every step's outputs. Publish only
  // the small planning payload, not that JSON marker or future step metadata.
  expect(workflow.jobs.plan.steps.at(-1).env.PLAN_VALUES).toBe("${{ steps.plan.outputs.values }}");
  expect(workflow.jobs.prepare.steps.find((step: any) => step.id === "prepare").run).toContain(
    "--reuse-commit {0} --reuse-slot {1}",
  );
  expect(workflow.jobs.prepare.steps.find((step: any) => step.id === "prepare").run).toContain(
    "steps.plan.outputs.deploy == 'false'",
  );
  expect(workflow.jobs.plan.steps.find((step: any) => step.id === "plan").run).toContain(
    "inputs.all-apps",
  );
  expect(caller.jobs.preview).toMatchObject({
    uses: "./.depot/workflows/preview-run.yml",
    concurrency: { "cancel-in-progress": false },
  });
  expect(workflow.jobs.playwright).toMatchObject({
    strategy: { "fail-fast": false, matrix: { shard: previewPlaywrightShards } },
  });
  expect(workflow.jobs.playwright.concurrency).toBeUndefined();
  expect(workflow.jobs.apps).toMatchObject({
    needs: "plan",
    if: "needs.plan.outputs.tests == 'true'",
  });
  expect(workflow.jobs.playwright).toMatchObject({
    needs: "plan",
    if: "needs.plan.outputs.tests == 'true'",
  });
  expect(workflow.jobs.finish).toMatchObject({
    needs: ["plan", "prepare"],
    if: "always() && needs.plan.outputs.tests == 'true'",
  });
  const steps = workflow.jobs.finish.steps;
  const green = steps.findIndex((step: any) => step.id === "tests_passed");
  const trace = steps.findIndex((step: any) => step.id === "trace");
  const cleanup = steps.findIndex((step: any) => step.id === "erase");
  expect(green).toBeGreaterThan(steps.findIndex((step: any) => step.id === "merge_reports"));
  expect(trace).toBeGreaterThan(green);
  expect(cleanup).toBeGreaterThan(trace);
  expect(workflow.jobs.trace).toBeUndefined();
  expect(steps[trace]).toMatchObject({
    if: "always() && steps.consumers.outputs.settled == 'true'",
    "timeout-minutes": 5,
    env: {
      CI_TRACE_GREEN: "${{ steps.tests_passed.outputs.ci-trace-green }}",
      CI_TRACE_VALIDATION_END: "${{ steps.merge_reports.outputs.ci-trace-end }}",
      CI_TRACE_GREEN_END: "${{ steps.tests_passed.outputs.ci-trace-end }}",
    },
  });
  expect(steps[green]).toMatchObject({
    if: "success() && needs.prepare.result == 'success' && steps.consumers.outputs.succeeded == 'true' && steps.merge_reports.outcome == 'success'",
  });
  expect(steps[cleanup]).toMatchObject({
    if: "always() && steps.consumers.outputs.settled == 'true'",
  });
  expect(steps[cleanup].run).toContain("--restore --prepared-ci-plan");
  const settled = steps.findIndex((step: any) => step.id === "settled");
  expect(settled).toBe(steps.length - 1);
  expect(settled).toBeGreaterThan(cleanup);
  expect(steps[settled]).toMatchObject({
    if: "always() && !cancelled() && steps.erase.outcome == 'success' && steps.erase.outputs.restored == 'true' && steps.merge_reports.outputs.test_outcome != ''",
    run: expect.stringContaining("set-preview-settled"),
  });
});

test("the shared workflow keeps the experiment disabled unless a dispatch supplies a receipt", () => {
  const root = resolve(import.meta.dirname, "../..");
  const caller = parse(readFileSync(resolve(root, ".depot/workflows/preview-main.yml"), "utf8"));
  const workflow = parse(readFileSync(resolve(root, ".depot/workflows/preview-run.yml"), "utf8"));
  expect(caller.on.workflow_dispatch.inputs["lease-cycling-receipt"]).toMatchObject({
    required: false,
    default: "",
  });
  expect(workflow.on.workflow_call.inputs["lease-cycling-receipt"]).toMatchObject({
    type: "string",
    default: "",
  });
  expect(workflow.env).toMatchObject({
    PREVIEW_LEASE_CYCLING_RECEIPT: "${{ inputs.lease-cycling-receipt }}",
  });
});

test("result collection retains failures and rejects missing or foreign shard receipts", async () => {
  const identity = { headSha: "candidate", runId: "run", runAttempt: "1", slot: "preview-2" };
  const directory = await mkdtemp(join(tmpdir(), "preview-receipts-"));
  try {
    const passed = { ...identity, key: "playwright-1", exitCode: 0, error: null, durationMs: 123 };
    await writeFile(join(directory, "playwright-1.json"), JSON.stringify(passed));
    expect(await readPreviewCiResults(identity, ["playwright-1"], directory)).toEqual({
      failures: [],
      durationMs: 123,
      complete: true,
    });
    await writeFile(
      join(directory, "playwright-2.json"),
      JSON.stringify({ ...passed, key: "playwright-2", exitCode: 1, error: "browser crashed" }),
    );
    expect(
      await readPreviewCiResults(identity, ["playwright-1", "playwright-2"], directory),
    ).toMatchObject({
      complete: true,
      failures: ["browser crashed"],
    });
    await writeFile(
      join(directory, "playwright-3.json"),
      JSON.stringify({ ...passed, key: "playwright-3", headSha: "other-commit" }),
    );
    const result = await readPreviewCiResults(
      identity,
      ["playwright-1", "playwright-2", "playwright-3", "playwright-4"],
      directory,
    );
    expect(result.complete).toBe(false);
    await writeFile(
      join(directory, "playwright-2.json"),
      JSON.stringify({
        ...passed,
        key: "playwright-2",
        exitCode: 124,
        error: "timed out",
      }),
    );
    expect(await readPreviewCiResults(identity, ["playwright-2"], directory)).toMatchObject({
      complete: false,
      failures: ["timed out"],
    });
    expect(result.failures).toEqual([
      "browser crashed",
      expect.stringContaining("identity mismatch"),
      expect.stringContaining("Missing or invalid playwright-4"),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
