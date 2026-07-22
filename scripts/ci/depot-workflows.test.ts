import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  steps?: Array<{
    env?: Record<string, string>;
    name?: string;
    if?: string;
    run?: string;
    uses?: string;
    with?: Record<string, unknown>;
  }>;
};

type Workflow = {
  concurrency?: {
    group: string;
    "cancel-in-progress": boolean;
  };
  jobs: Record<string, WorkflowJob>;
  permissions?: Record<string, string>;
  on?: {
    push?: {
      paths?: string[];
    };
  };
};

function loadWorkflow(file: string): Workflow {
  return parseYaml(readFileSync(resolve(repoRoot, file), "utf8")) as Workflow;
}

const depotWorkflowFiles = readdirSync(resolve(repoRoot, ".depot/workflows"))
  .filter((file) => file.endsWith(".yml"))
  .map((file) => `.depot/workflows/${file}`);

const deploymentWorkflows = [
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

  it("redeploys tunnels when its workflow changes", () => {
    const workflow = loadWorkflow(".depot/workflows/deploy-tunnels.yml");

    expect(workflow.on?.push?.paths).toContain(".depot/workflows/deploy-tunnels.yml");
  });

  it("redeploys OS when its iterate/sdk/itx/react workspace dependency changes", () => {
    const workflow = loadWorkflow(".depot/workflows/deploy-os.yml");

    expect(workflow.on?.push?.paths).toContain("packages/iterate/**");
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

describe("Depot credential boundaries", () => {
  it("uses DOPPLER_TOKEN as the only stored Depot secret", () => {
    const secretReferences = depotWorkflowFiles.flatMap((file) => {
      const contents = readFileSync(resolve(repoRoot, file), "utf8");
      return [...contents.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
    });

    expect([...new Set(secretReferences)]).toEqual(["DOPPLER_TOKEN"]);
  });

  it("uses only GitHub's job-scoped token for GitHub API calls", () => {
    const tokenAssignments = depotWorkflowFiles.flatMap((file) => {
      const contents = readFileSync(resolve(repoRoot, file), "utf8");
      return [...contents.matchAll(/^\s+GITHUB_TOKEN:\s*(.+)$/gm)].map((match) => match[1]);
    });

    expect(tokenAssignments.length).toBeGreaterThan(0);
    expect([...new Set(tokenAssignments)]).toEqual(["${{ github.token }}"]);
  });

  it.each([
    {
      file: ".depot/workflows/ci-telemetry.yml",
      permissions: {
        actions: "read",
        checks: "read",
        contents: "read",
        "pull-requests": "read",
      },
    },
    {
      file: ".depot/workflows/cloudflare-preview-cleanup.yml",
      permissions: { contents: "read", "pull-requests": "write" },
    },
    {
      file: ".depot/workflows/cloudflare-previews.yml",
      permissions: { contents: "read", "pull-requests": "write", statuses: "read" },
    },
    {
      file: ".depot/workflows/deploy-os.yml",
      permissions: { contents: "read", deployments: "write", statuses: "write" },
    },
    {
      file: ".depot/workflows/loc-report.yml",
      permissions: { contents: "read", "pull-requests": "write" },
    },
    {
      file: ".depot/workflows/nag.yml",
      permissions: { contents: "read", issues: "write", "pull-requests": "write" },
    },
    {
      file: ".depot/workflows/pr-dashboard.yml",
      permissions: {
        actions: "write",
        contents: "read",
        issues: "read",
        "pull-requests": "read",
      },
    },
    {
      file: ".depot/workflows/preview-e2e-marathon.yml",
      permissions: { contents: "read", "pull-requests": "write", statuses: "read" },
    },
    {
      file: ".depot/workflows/release.yml",
      permissions: { contents: "write" },
    },
  ])("$file grants only its required GitHub permissions", ({ file, permissions }) => {
    expect(loadWorkflow(file).permissions).toEqual(permissions);
  });

  it("loads the Depot telemetry token from preview without changing the PostHog config", () => {
    const workflow = loadWorkflow(".depot/workflows/ci-telemetry.yml");
    const collector = workflow.jobs.sync.steps?.find((step) =>
      step.run?.includes("scripts/ci/sync-ci-telemetry.ts"),
    );

    expect(collector?.run).toContain(
      "doppler secrets get DEPOT_CI_TELEMETRY_TOKEN --plain --project _shared --config preview",
    );
    expect(collector?.run).toContain("doppler run --project _shared --config prd");
    expect(collector?.run).toContain("--preserve-env=DEPOT_CI_TELEMETRY_TOKEN,GITHUB_TOKEN");
  });
});

describe("Depot validation capacity", () => {
  it("runs every workspace test script, including the iterate CLI", () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
      scripts: { test: string };
    };
    const workflow = readFileSync(resolve(repoRoot, ".depot/workflows/test.yml"), "utf8");

    expect(packageJson.scripts.test).toBe("pnpm -r --parallel test");
    expect(workflow).toContain("run: doppler run -- pnpm test");
  });

  it("every unit-test workspace writes the canonical telemetry artifact", () => {
    const packageFiles = [
      ...["apps", "packages"].flatMap((directory) =>
        readdirSync(resolve(repoRoot, directory), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${directory}/${entry.name}/package.json`),
      ),
      "lint/package.json",
      "scripts/package.json",
    ].filter((file) => {
      if (!existsSync(resolve(repoRoot, file))) return false;
      const packageJson = JSON.parse(readFileSync(resolve(repoRoot, file), "utf8")) as {
        scripts?: Record<string, string>;
      };
      return packageJson.scripts?.test !== undefined;
    });
    const expectedWorkspaces = packageFiles.map((file) => {
      const packageJson = JSON.parse(readFileSync(resolve(repoRoot, file), "utf8")) as {
        name: string;
        scripts: Record<string, string>;
      };
      const testCommand = [packageJson.scripts.test, packageJson.scripts["test:unit"]]
        .filter(Boolean)
        .join(" ");
      expect(testCommand, `${file} must install one canonical test telemetry reporter`).toMatch(
        /(?:retry-telemetry-reporter|node-test-telemetry-reporter)\.ts/,
      );
      return packageJson.name;
    });

    const finalizer = loadWorkflow(".depot/workflows/test.yml").jobs.test?.steps?.find((step) =>
      step.run?.includes("scripts/ci/upload-test-telemetry.ts"),
    );
    expect(finalizer?.env?.TEST_TELEMETRY_EXPECTED_WORKSPACES?.split(",").sort()).toEqual(
      expectedWorkspaces.sort(),
    );
  });

  it.each([
    {
      file: ".depot/workflows/test.yml",
      group: "test-${{ github.head_ref || github.ref_name || github.run_id }}",
      jobId: "test",
      size: "4x16",
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

  it.each([
    { file: ".depot/workflows/test.yml", jobId: "test" },
    { file: ".depot/workflows/cloudflare-previews.yml", jobId: "preview" },
    { file: ".depot/workflows/preview-e2e-marathon.yml", jobId: "marathon" },
  ])("$file always finalizes and retains test telemetry", ({ file, jobId }) => {
    const steps = loadWorkflow(file).jobs[jobId]?.steps ?? [];
    const finalizer = steps.find((step) =>
      step.run?.includes("scripts/ci/upload-test-telemetry.ts"),
    );
    const upload = steps.find((step) => step.uses === "actions/upload-artifact@v4");

    expect(finalizer, `${file} must normalize and send telemetry`).toMatchObject({
      if: "always()",
    });
    expect(finalizer?.run, `${file} must not send cancelled runs as test failures`).toContain(
      "cancelled() && '--cancelled'",
    );
    expect(upload, `${file} must retain raw and normalized telemetry`).toMatchObject({
      if: "always()",
      with: expect.objectContaining({
        path: expect.stringContaining("test-results"),
        "if-no-files-found": "error",
      }),
    });
    expect(steps.indexOf(finalizer!)).toBeLessThan(steps.indexOf(upload!));
  });

  it("labels unit artifacts with the exact checked-out pull-request head", () => {
    const runTests = loadWorkflow(".depot/workflows/test.yml").jobs.test.steps?.find(
      (step) => step.name === "Run Tests",
    );

    expect(runTests?.env).toMatchObject({
      TEST_TELEMETRY_BRANCH: "${{ github.head_ref || github.ref_name }}",
      TEST_TELEMETRY_HEAD_SHA: "${{ github.event.pull_request.head.sha || github.sha }}",
      TEST_TELEMETRY_PULL_REQUEST_NUMBER: "${{ github.event.pull_request.number }}",
    });
  });

  it.each([
    { file: ".depot/workflows/test.yml", jobId: "test" },
    { file: ".depot/workflows/cloudflare-previews.yml", jobId: "preview" },
    { file: ".depot/workflows/preview-e2e-marathon.yml", jobId: "marathon" },
  ])("$file sends finalized test telemetry to the canonical PostHog project", ({ file, jobId }) => {
    const finalizer = loadWorkflow(file).jobs[jobId]?.steps?.find((step) =>
      step.run?.includes("scripts/ci/upload-test-telemetry.ts"),
    );

    expect(finalizer?.run).toContain("doppler run --project _shared --config prd --");
  });
});
