import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

/** The parts of .depot/workflows/main-os-e2e.yml these tests read. */
type MainWorkflow = {
  on: { push?: { branches?: string[]; paths?: string[] } };
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
const preview = readWorkflow("preview-os-next.yml") as {
  on: { pull_request: { paths: string[] } };
};

test("runs on every main push a PR preview would run for, one run at a time, never cancelled", () => {
  expect(main.on.push?.branches).toEqual(["main"]);
  expect(main.on.push?.paths).toEqual(
    expect.arrayContaining(
      preview.on.pull_request.paths.filter((path) => !path.includes("preview-os-next.yml")),
    ),
  );
  // every started run reaches delete and alert; Depot keeps only the newest pending push
  expect(main).toMatchObject({
    concurrency: { group: "main-os-e2e", "cancel-in-progress": false },
  });
});

test("first deploys the preview parent from main, one push at a time", () => {
  expect(runs("parent")).toContain("doppler run -- pnpm run-script deploy --env preview");
  expect(main.jobs.parent).toMatchObject({
    concurrency: { group: "os-next-preview-parent", "cancel-in-progress": false },
  });
  expect(main.jobs.deploy?.needs).toBe("parent");
});

test("deploys and tests a throwaway preview named for the commit", () => {
  expect(runs("deploy")).toContain('echo "preview-name=main-${GITHUB_SHA::7}" >> "$GITHUB_OUTPUT"');
  expect(runs("deploy")).toContain("doppler run -- pnpm preview deploy");
  expect(runs("e2e")).toContain("doppler run -- pnpm preview e2e");
  // no PR number anywhere: nothing is written to a pull request
  expect(JSON.stringify(main)).not.toContain("PREVIEW_PR_NUMBER");
});

test("always deletes the preview and everything it created, cancelled or failed", () => {
  expect(main.jobs.delete?.if).toBe("always()");
  expect([main.jobs.delete?.needs].flat()).toEqual(["deploy", "e2e"]);
  expect(runs("delete")).toContain(
    'PREVIEW_NAME="main-${GITHUB_SHA::7}" doppler run -- pnpm preview delete',
  );
  // a run cancelled by hand has its delete cancelled with it: the next run deletes its preview first
  expect(runs("deploy").indexOf("doppler run -- pnpm preview delete-superseded")).toBeLessThan(
    runs("deploy").indexOf("doppler run -- pnpm preview deploy"),
  );
  expect(runs("deploy")).toContain("doppler run -- pnpm preview delete-superseded");
});

test("pages on main's change of state, never for a run cancelled by hand", () => {
  expect(main.jobs.alert?.if).toBe("${{ !cancelled() && github.event_name == 'push' }}");
  expect([main.jobs.alert?.needs].flat()).toEqual(["parent", "deploy", "e2e", "delete"]);
  expect(runs("alert")).toContain("pnpm tsx scripts/ci/main-e2e-alert.ts alert");
});

function readWorkflow(file: string): unknown {
  return parseYaml(
    readFileSync(resolve(import.meta.dirname, "../../.depot/workflows", file), "utf8"),
  );
}

function runs(jobId: string): string[] {
  return (main.jobs[jobId]?.steps || []).map((step) => step.run || "");
}
