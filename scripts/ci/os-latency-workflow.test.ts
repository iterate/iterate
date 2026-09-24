import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { stateArtifact } from "./os-latency-guard.ts";

/** The parts of .depot/workflows/os-latency.yml these tests read. */
type LatencyWorkflow = {
  name: string;
  on: {
    schedule?: { cron: string }[];
    workflow_dispatch?: { inputs?: Record<string, unknown> };
  };
  concurrency: { group: string; "cancel-in-progress": boolean };
  env: Record<string, string>;
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string | string[];
      steps?: Array<{ name?: string; if?: string; run?: string; with?: Record<string, unknown> }>;
    }
  >;
};

const latency = readWorkflow("os-latency.yml") as LatencyWorkflow;

// Not on a push: depot-workflows.test.ts holds every scheduled workflow to its schedule and dispatch.
test("runs every 3 hours and on dispatch; one run at a time, never cut short", () => {
  expect(latency).toMatchObject({
    on: { schedule: [{ cron: expect.stringMatching(/^\d+ \*\/3 \* \* \*$/) }] },
    concurrency: { group: "os-latency", "cancel-in-progress": false },
  });
  expect(latency.on.workflow_dispatch?.inputs).toHaveProperty("budget-scale");
});

test("measures a preview of its own, redeployed in place, never deleted", () => {
  const measure = runs("measure").join("\n");
  const order = [
    "doppler run -- pnpm preview deploy",
    "pnpm perf:run --reporter=default --reporter=json --outputFile.json=output/perf-report.json",
    "pnpm tsx scripts/ci/os-latency-guard.ts previous-state",
    "pnpm tsx scripts/ci/os-latency-guard.ts judge",
  ].map((command) => measure.indexOf(command));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect(order).toEqual(order.toSorted((a, b) => a - b));
  // nothing but the one parent's preview: no app on top, no PR
  expect(JSON.stringify(latency)).not.toContain("PREVIEW_PR_NUMBER");
  // one preview for every run, a CI workflow's own, never brand-new
  // (apps/os/scripts/preview-sweep.ts CI_WORKFLOW_PREVIEWS)
  expect(latency.env).toMatchObject({ PREVIEW_NAME: "latency" });
  expect(Object.keys(latency.jobs)).toEqual(["measure"]);
  expect(measure).not.toMatch(/pnpm preview (delete|reset)$/m);
});

test("the judge reads the report the perf suite wrote and keeps the state the next run reads", () => {
  expect(latency).toMatchObject({ name: stateArtifact.workflow });
  const keep = latency.jobs.measure?.steps?.find(
    (step) => step.with?.name === stateArtifact.artifact,
  );
  expect(keep).toMatchObject({
    if: "always()",
    with: { path: `test-results/os-latency/${stateArtifact.file}`, "if-no-files-found": "ignore" },
  });
  const judge = runs("measure").find((run) => run.includes("os-latency-guard.ts judge"));
  expect(judge).toContain("--report apps/os/output/perf-report.json");
  expect(judge).toContain("--state test-results/os-latency/previous.json");
  expect(judge).toContain(`--state-out test-results/os-latency/${stateArtifact.file}`);
});

function readWorkflow(file: string): unknown {
  return parseYaml(
    readFileSync(resolve(import.meta.dirname, "../../.depot/workflows", file), "utf8"),
  );
}

function runs(jobId: string): string[] {
  return (latency.jobs[jobId]?.steps || []).map((step) => step.run || "");
}
