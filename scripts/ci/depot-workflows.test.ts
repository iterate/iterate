import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const repoRoot = resolve(import.meta.dirname, "../..");

type WorkflowJob = {
  "runs-on": {
    image?: string;
    size?: string;
  };
  "timeout-minutes"?: number;
};

type Workflow = {
  concurrency?: {
    group: string;
    "cancel-in-progress": boolean;
  };
  jobs: Record<string, WorkflowJob>;
  on?: {
    push?: {
      paths?: string[];
    };
  };
};

function loadWorkflow(file: string): Workflow {
  return parseYaml(readFileSync(resolve(repoRoot, file), "utf8")) as Workflow;
}

const deploymentWorkflows = [
  {
    file: ".depot/workflows/ci.yml",
    group: "deploy-iterate-com-production",
    jobs: {
      "deploy-iterate-com": { size: "2x8", timeoutMinutes: 20 },
      slack_failure: { size: "2x8", timeoutMinutes: 10 },
    },
  },
  {
    file: ".depot/workflows/deploy-auth.yml",
    group: "deploy-auth-dev-global",
    jobs: {
      "deploy-dev-global": { size: "2x8", timeoutMinutes: 20 },
    },
  },
  {
    file: ".depot/workflows/deploy-os.yml",
    group: "deploy-auth-os-production",
    jobs: {
      deploy: { size: "4x16", timeoutMinutes: 45 },
      notify: { size: "2x8", timeoutMinutes: 10 },
    },
  },
  {
    file: ".depot/workflows/deploy-semaphore.yml",
    group: "deploy-semaphore-production",
    jobs: {
      deploy: { size: "2x8", timeoutMinutes: 20 },
      notify: { size: "2x8", timeoutMinutes: 10 },
    },
  },
  {
    file: ".depot/workflows/deploy-streams-example-app.yml",
    group: "deploy-streams-example-app-production",
    jobs: {
      deploy: { size: "2x8", timeoutMinutes: 20 },
      notify: { size: "2x8", timeoutMinutes: 10 },
    },
  },
  {
    file: ".depot/workflows/deploy-tunnels.yml",
    group: "deploy-tunnels-production",
    jobs: {
      deploy: { size: "2x8", timeoutMinutes: 20 },
    },
  },
] as const;

describe("Depot deployment safety", () => {
  it.each(deploymentWorkflows)(
    "$file serializes the destination without cancelling an active deploy",
    ({ file, group, jobs }) => {
      const workflow = loadWorkflow(file);

      expect(workflow.concurrency).toEqual({
        group,
        "cancel-in-progress": false,
      });
      expect(Object.keys(workflow.jobs).sort()).toEqual(Object.keys(jobs).sort());

      for (const [jobId, expected] of Object.entries(jobs)) {
        const job = workflow.jobs[jobId];
        expect(job, `${file} is missing job ${jobId}`).toBeDefined();
        expect(job["runs-on"].size).toBe(expected.size);
        expect(job["runs-on"].image).toBe(
          "0p91s0lz49.registry.depot.dev/iterate-preview-ci:node24-pnpm10-worktree",
        );
        expect(job["timeout-minutes"]).toBe(expected.timeoutMinutes);
      }
    },
  );

  it("deploys iterate.com only for inputs that can change its artifact", () => {
    const workflow = loadWorkflow(".depot/workflows/ci.yml");

    expect(workflow.on?.push?.paths).toEqual([
      ".depot/workflows/ci.yml",
      ".agents/skills/**",
      "apps/iterate-com/**",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "patches/**",
    ]);
  });

  it("redeploys tunnels when its workflow changes", () => {
    const workflow = loadWorkflow(".depot/workflows/deploy-tunnels.yml");

    expect(workflow.on?.push?.paths).toContain(".depot/workflows/deploy-tunnels.yml");
  });

  it.each([
    ".depot/workflows/deploy-semaphore.yml",
    ".depot/workflows/deploy-streams-example-app.yml",
  ])("$file redeploys when its bundled Auth workspace code changes", (file) => {
    const workflow = loadWorkflow(file);

    expect(workflow.on?.push?.paths).toEqual(
      expect.arrayContaining(["apps/auth/**", "apps/auth-contract/**"]),
    );
  });
});

describe("Depot validation capacity", () => {
  it.each([
    {
      file: ".depot/workflows/test.yml",
      group: "test-${{ github.head_ref || github.ref_name || github.run_id }}",
      jobId: "test",
      size: "8x32",
      timeoutMinutes: 20,
    },
    {
      file: ".depot/workflows/lint-typecheck.yml",
      group: "lint-typecheck-${{ github.head_ref || github.ref_name || github.run_id }}",
      jobId: "lint-typecheck",
      size: "8x32",
      timeoutMinutes: 20,
    },
    {
      file: ".depot/workflows/autofix.yml",
      group: "autofix-${{ github.head_ref || github.ref_name || github.run_id }}",
      jobId: "autofix",
      size: "2x8",
      timeoutMinutes: 15,
    },
  ])("$file coalesces superseded branch runs", ({ file, group, jobId, size, timeoutMinutes }) => {
    const workflow = loadWorkflow(file);
    const job = workflow.jobs[jobId];

    expect(workflow.concurrency).toEqual({ group, "cancel-in-progress": true });
    expect(job["runs-on"].size).toBe(size);
    expect(job["timeout-minutes"]).toBe(timeoutMinutes);
  });
});
