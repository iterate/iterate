import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

/** The parts of .depot/workflows/preview-os-next.yml these tests read. */
type PreviewWorkflow = {
  jobs: Record<
    string,
    {
      if?: string;
      name?: string;
      needs?: string | string[];
      "runs-on"?: { size?: string };
      steps?: Array<{ run?: string; if?: string }>;
    }
  >;
};

const preview = parseYaml(
  readFileSync(resolve(import.meta.dirname, "../../.depot/workflows/preview-os-next.yml"), "utf8"),
) as PreviewWorkflow;

describe("the OS-Next preview workflow", () => {
  it("deploys in one job and runs the suite in the next", () => {
    expect(preview.jobs.deploy.steps?.map((step) => step.run)).not.toContain(
      "doppler run -- pnpm preview e2e",
    );
    expect([preview.jobs.e2e.needs].flat()).toEqual(["deploy"]);
    expect(preview.jobs.e2e.steps?.map((step) => step.run)).toContain(
      "doppler run -- pnpm preview e2e",
    );
  });

  it("reads the preview's residency after every suite, then always releases it, in that order", () => {
    const steps = preview.jobs.residency.steps || [];
    expect([preview.jobs.residency.needs].flat()).toEqual(["e2e"]);
    expect(preview.jobs.residency["runs-on"]?.size).toBe("2x8");
    // a redeploy before the reading would end the very sessions the gate looks for
    expect(steps.map((step) => step.run).filter((run) => run?.includes("pnpm preview"))).toEqual([
      "doppler run -- pnpm preview residency",
      "doppler run -- pnpm preview release",
    ]);
    expect(steps.at(-1)?.if).toBe("always()");
  });

  // After every deploy that succeeded, never after one that did not, and alone (deploy skipped) on
  // a dispatch with action=e2e.
  it.each([
    ["pull_request", "", "success", true],
    ["pull_request", "", "failure", false],
    ["pull_request", "", "cancelled", false],
    ["pull_request", "", "skipped", false],
    ["workflow_dispatch", "deploy", "success", true],
    ["workflow_dispatch", "reset", "success", true],
    ["workflow_dispatch", "reset", "failure", false],
    ["workflow_dispatch", "e2e", "skipped", true],
    ["workflow_dispatch", "delete", "skipped", false],
    ["workflow_dispatch", "sweep", "skipped", false],
    ["schedule", "", "skipped", false],
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
