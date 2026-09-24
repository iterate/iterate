import { readFileSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { stateArtifact } from "./os-latency-guard.ts";

/** The parts of .depot/workflows/os-latency.yml these tests read. */
type LatencyWorkflow = {
  name: string;
  on: {
    schedule?: { cron: string }[];
    push?: { branches?: string[]; paths?: string[] };
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
const deployOs = readWorkflow("deploy-os.yml") as { on: { push: { paths: string[] } } };

test("runs on a schedule, on every main push that could change the platform's speed, and on dispatch; one run at a time, never cut short", () => {
  expect(latency).toMatchObject({
    on: { schedule: [{ cron: expect.stringMatching(/^\d+ \*\/3 \* \* \*$/) }] },
    concurrency: { group: "os-latency", "cancel-in-progress": false },
  });
  expect(latency.on.push?.branches).toEqual(["main"]);
  const paths = latency.on.push?.paths ?? [];
  // everything that deploys the Worker, plus the perf lane and the guard itself
  for (const file of [
    "apps/os/src/worker.ts",
    "apps/os/src/control-plane/catalog.ts",
    "configs/default/AGENTS.md",
    "packages/iterate/src/stream/processor.ts",
    "packages/ui/src/button.tsx",
    "envs.ts",
    "pnpm-lock.yaml",
    "apps/os/perf/latency.ts",
    "apps/os/perf/project-creation.perf.test.ts",
    "apps/os/e2e/support/client.ts",
    "scripts/ci/os-latency-guard.ts",
    ".depot/workflows/os-latency.yml",
  ])
    expect(triggers(paths, file), `${file} runs the guard`).toBe(true);
  for (const file of deployOs.on.push.paths.filter((path) => !path.startsWith("!")))
    if (file !== ".depot/workflows/deploy-os.yml")
      expect(paths, `deploy-os.yml deploys for ${file}`).toContain(file);
  expect(latency.on.workflow_dispatch?.inputs).toHaveProperty("budget-scale");
});

test("measures a throwaway preview of its own, deleted whatever happened", () => {
  const measure = runs("measure").join("\n");
  const order = [
    "doppler run -- pnpm preview delete-superseded",
    "doppler run -- pnpm preview deploy",
    "pnpm perf:run --reporter=default --reporter=json --outputFile.json=output/perf-report.json",
    "pnpm tsx scripts/ci/os-latency-guard.ts previous-state",
    "pnpm tsx scripts/ci/os-latency-guard.ts judge",
  ].map((command) => measure.indexOf(command));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect(order).toEqual(order.toSorted((a, b) => a - b));
  // nothing but the one parent's preview: no app on top, no PR
  expect(JSON.stringify(latency)).not.toContain("PREVIEW_PR_NUMBER");
  expect(latency.jobs.delete).toMatchObject({ if: "always()", needs: "measure" });
  expect(runs("delete")).toContain("doppler run -- pnpm preview delete");
  // one preview per run attempt, a shape supersededMainPreviews knows (apps/os/scripts/preview-sweep.ts)
  expect(latency.env).toMatchObject({
    PREVIEW_NAME: "latency-${{ github.run_id }}-${{ github.run_attempt }}",
  });
});

test("the judge reads the report the perf lane wrote and keeps the state the next run reads", () => {
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

/** GitHub's `paths` filter: the last pattern a file matches decides, and a `!` pattern excludes. */
function triggers(paths: string[], file: string) {
  let included = false;
  for (const pattern of paths) {
    const negated = pattern.startsWith("!");
    if (matchesGlob(file, negated ? pattern.slice(1) : pattern)) included = !negated;
  }
  return included;
}
