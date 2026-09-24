import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

/** The parts of .depot/workflows/main-os-e2e.yml these tests read. */
type MainWorkflow = {
  on: { push?: { branches?: string[]; paths?: string[] }; schedule?: { cron: string }[] };
  env?: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string | string[];
      concurrency?: { group: string; "cancel-in-progress": boolean };
      steps?: Array<{ run?: string; env?: Record<string, string> }>;
    }
  >;
};

const main = readWorkflow("main-os-e2e.yml") as MainWorkflow;
const prdAccount = readWorkflow("main-os-e2e-prd-account.yml") as MainWorkflow;
const preview = readWorkflow("preview-os-next.yml") as {
  on: { pull_request: { paths: string[] } };
};

test("runs on every main push a PR preview would run for, the latest push only", () => {
  expect(main.on.push?.branches).toEqual(["main"]);
  expect(main.on.push?.paths).toEqual(
    expect.arrayContaining(
      preview.on.pull_request.paths.filter((path) => !path.includes("preview-os-next.yml")),
    ),
  );
  expect(main).toMatchObject({
    concurrency: { group: "main-os-e2e", "cancel-in-progress": true },
  });
});

test("first deploys the preview parent from main, one push at a time", () => {
  expect(runs("parent")).toContain("doppler run -- pnpm run-script deploy --env preview");
  expect(main.jobs.parent).toMatchObject({
    concurrency: { group: "os-next-preview-parent", "cancel-in-progress": false },
  });
  expect(main.jobs.deploy?.needs).toBe("parent");
});

test("deploys, tests and reads residency on a throwaway preview named for the commit", () => {
  expect(runs("deploy")).toContain('echo "preview-name=main-${GITHUB_SHA::7}" >> "$GITHUB_OUTPUT"');
  expect(runs("deploy")).toContain("doppler run -- pnpm preview deploy");
  expect(runs("e2e")).toContain("doppler run -- pnpm preview e2e");
  expect(runs("residency")).toContain("doppler run -- pnpm preview residency");
  // no PR number anywhere: nothing is written to a pull request
  expect(JSON.stringify(main)).not.toContain("PREVIEW_PR_NUMBER");
});

test("always deletes the preview and everything it created, cancelled or failed", () => {
  expect(main.jobs.delete?.if).toBe("always()");
  expect([main.jobs.delete?.needs].flat()).toEqual(["deploy", "e2e", "residency"]);
  // a superseded run skips the analytics wait, so the delete is not held behind it
  expect(main.jobs.residency?.if).toBe(
    "${{ !cancelled() && needs.e2e.outputs.suite-started != '' }}",
  );
  expect(runs("delete")).toContain(
    'PREVIEW_NAME="main-${GITHUB_SHA::7}" doppler run -- pnpm preview delete',
  );
  // a cancelled run's delete is cancelled with it: the next run deletes its preview first
  expect(runs("deploy").indexOf("doppler run -- pnpm preview delete-superseded")).toBeLessThan(
    runs("deploy").indexOf("doppler run -- pnpm preview deploy"),
  );
  expect(runs("deploy")).toContain("doppler run -- pnpm preview delete-superseded");
  // nothing redeploys or keeps the preview after the suite
  expect(Object.keys(main.jobs).flatMap(runs)).not.toContain("doppler run -- pnpm preview release");
});

test("pages on main's change of state, never for a superseded run", () => {
  expect(main.jobs.alert?.if).toBe("${{ !cancelled() && github.event_name == 'push' }}");
  expect([main.jobs.alert?.needs].flat()).toEqual([
    "parent",
    "deploy",
    "e2e",
    "residency",
    "delete",
  ]);
  // main's state is the workflow's own last finished run, read from the check runs it posted
  expect(runs("alert")).toContain(
    'pnpm tsx scripts/ci/main-e2e-alert.ts alert --workflow "Main OS e2e"',
  );
  expect(readWorkflowName("main-os-e2e.yml")).toBe("Main OS e2e");
});

test("the prd account's run is the same run on the one throwaway parent, the platform alone", () => {
  expect(prdAccount.on.push?.branches).toEqual(["main"]);
  expect(prdAccount.env?.PREVIEW_PARENT_ENV).toBe("prd-account-e2e");
  const step = (jobId: string, command: string) =>
    prdAccount.jobs[jobId]?.steps?.find((candidate) => candidate.run === command);
  expect(step("deploy", "doppler run -- pnpm preview deploy")?.env?.PREVIEW_APPS).toBe("none");
  // a cancelled run's delete is cancelled with it: the next run deletes its preview first
  const deploySteps = (prdAccount.jobs.deploy?.steps || []).map((candidate) => candidate.run);
  expect(deploySteps.indexOf("doppler run -- pnpm preview delete-superseded")).toBeGreaterThan(-1);
  expect(deploySteps.indexOf("doppler run -- pnpm preview delete-superseded")).toBeLessThan(
    deploySteps.indexOf("doppler run -- pnpm preview deploy"),
  );
  expect(step("e2e", "doppler run -- pnpm preview e2e")).toBeDefined();
  expect(step("residency", "doppler run -- pnpm preview residency")).toBeDefined();
  expect(prdAccount.jobs.delete?.if).toBe("always() && github.event_name != 'schedule'");
  expect(prdAccount.jobs.residency?.if).toBe(main.jobs.residency?.if);
  expect(prdAccount.jobs.alert?.steps?.at(-1)?.run).toBe(
    'pnpm tsx scripts/ci/main-e2e-alert.ts alert --workflow "Main OS e2e on the prd account" --label "main e2e on the prd account"',
  );
  expect(readWorkflowName("main-os-e2e-prd-account.yml")).toBe("Main OS e2e on the prd account");
  // the nightly backstop sweeps the prd account parent's leftovers
  expect(prdAccount.on.schedule).toHaveLength(1);
  expect(prdAccount.jobs.sweep?.if).toBe("github.event_name == 'schedule'");
  expect(step("sweep", "doppler run -- pnpm preview sweep")).toBeDefined();
});

function readWorkflow(file: string): unknown {
  return parseYaml(
    readFileSync(resolve(import.meta.dirname, "../../.depot/workflows", file), "utf8"),
  );
}

function runs(jobId: string): string[] {
  return (main.jobs[jobId]?.steps || []).map((step) => step.run || "");
}

/** The workflow's `name:`, the prefix of every check run it posts (`<name> / <job>`). */
function readWorkflowName(file: string): string {
  return (readWorkflow(file) as { name: string }).name;
}
