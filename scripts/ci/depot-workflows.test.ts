import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { SUITE_WORKFLOWS } from "./flake-dashboard/update.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const bakedImage = "0p91s0lz49.registry.depot.dev/iterate-preview-ci:node24-pnpm10-worktree";

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
    pull_request?: {
      paths?: string[];
    };
    push?: {
      branches?: string[];
      paths?: string[];
    };
  };
};

function loadWorkflow(file: string): Workflow {
  return parseYaml(readFileSync(resolve(repoRoot, file), "utf8")) as Workflow;
}

function readPackageJson(directory: string) {
  return JSON.parse(readFileSync(resolve(repoRoot, directory, "package.json"), "utf8")) as {
    name: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

const depotWorkflowFiles = readdirSync(resolve(repoRoot, ".depot/workflows"))
  .filter((file) => file.endsWith(".yml"))
  .map((file) => `.depot/workflows/${file}`);

// Every production deploy workflow is `deploy-<app>.yml` for `apps/<app>`.
const deploymentWorkflows = depotWorkflowFiles.flatMap((file) => {
  const app = /^\.depot\/workflows\/deploy-(.+)\.yml$/.exec(file)?.[1];
  return app ? [{ file, app }] : [];
});

const workspaceDirectories = (
  parseYaml(readFileSync(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8")) as {
    packages: string[];
  }
).packages;

describe("Depot deployment safety", () => {
  test("finds the production deploy workflows", () => {
    expect(deploymentWorkflows.map(({ app }) => app)).toEqual(
      expect.arrayContaining(["os-next", "dash", "agents", "notes", "voice", "kit", "spa"]),
    );
  });

  test.each(deploymentWorkflows)(
    "$file serializes the destination without cancelling an active deploy",
    ({ file, app }) => {
      const workflow = loadWorkflow(file);

      expect(workflow.concurrency).toEqual({
        group: `deploy-${app}-production`,
        "cancel-in-progress": false,
      });
      for (const [jobId, job] of Object.entries(workflow.jobs)) {
        expect(job["runs-on"].image, `${file} job ${jobId} runs on the baked image`).toBe(
          bakedImage,
        );
        expect(job["timeout-minutes"], `${file} job ${jobId} has a timeout`).toEqual(
          expect.any(Number),
        );
      }
    },
  );

  test.each(deploymentWorkflows)(
    "$file redeploys when its app or a workspace package it depends on changes",
    ({ file, app }) => {
      const workspaceByName = new Map(
        workspaceDirectories.map((directory) => [readPackageJson(directory).name, directory]),
      );
      const workspaceApp = app === "os-next" ? "os" : app;
      const packageJson = readPackageJson(`apps/${workspaceApp}`);
      const workspaceDependencies = Object.entries({
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      })
        .filter(([, version]) => version.startsWith("workspace:"))
        .map(([name]) => workspaceByName.get(name));

      expect(loadWorkflow(file).on?.push?.paths).toEqual(
        expect.arrayContaining([
          file,
          `apps/${workspaceApp}/**`,
          ...workspaceDependencies.map((directory) => `${directory}/**`),
        ]),
      );
    },
  );

  test("runs OS-Next and Notes stateful proofs only against an isolated preview", () => {
    const preview = loadWorkflow(".depot/workflows/preview-os-next.yml");
    const previewScript = readFileSync(resolve(repoRoot, "apps/os/scripts/preview.ts"), "utf8");

    for (const { file } of deploymentWorkflows) {
      const runs = Object.values(loadWorkflow(file).jobs).flatMap((job) =>
        (job.steps || []).map((step) => step.run || ""),
      );
      for (const suite of ["pnpm e2e", "pnpm spec", "pnpm preview e2e"]) {
        expect(
          runs.filter((run) => run.includes(suite)),
          `${file} must not run ${suite}`,
        ).toEqual([]);
      }
    }
    expect(preview.on?.pull_request?.paths).toEqual(
      expect.arrayContaining([
        ".depot/workflows/deploy-os-next.yml",
        ".depot/workflows/deploy-notes.yml",
      ]),
    );
    expect(previewScript).toContain('cwd: path.resolve(ROOT, "../notes")');
    expect(previewScript).toContain("NOTES_BASE_URL: notesPreview.url");
    expect(previewScript).toContain('cwd: path.resolve(ROOT, "../voice")');
    expect(previewScript).toContain("VOICE_BASE_URL: voicePreview.url");
  });

  test("installs the pinned ESP-IDF release before preparing Kit firmware", () => {
    const workflow = loadWorkflow(".depot/workflows/deploy-kit.yml");
    const deploy = workflow.jobs.deploy;
    const install = deploy.steps?.find((step) => step.name === "Install ESP-IDF 5.4.2");
    const build = deploy.steps?.find((step) => step.name === "Build Kit firmware releases");
    const deployKit = deploy.steps?.find((step) => step.name === "Deploy apps/kit");

    expect(install?.run).toContain("--recursive --branch v5.4.2");
    expect(install?.run).toContain("f5c3654a1c2d2a01f7f67def7a0dc48e691f63c0");
    expect(install?.run).toContain('"$IDF_PATH/install.sh" esp32s3');
    expect(build?.run).toContain('source "$IDF_PATH/export.sh"');
    expect(build?.run).toContain("pnpm run firmware:release");
    expect(deployKit?.run).toContain('source "$IDF_PATH/export.sh"');
    expect(workflow.on?.push?.paths).toEqual(
      expect.arrayContaining([
        "apps/os/**", // the page is an app of OS (workspace dependency)
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "patches/**",
      ]),
    );
  });
});

describe("Depot credential boundaries", () => {
  test("uses DOPPLER_TOKEN as the only stored Depot secret", () => {
    const secretReferences = depotWorkflowFiles.flatMap((file) => {
      const contents = readFileSync(resolve(repoRoot, file), "utf8");
      return [...contents.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
    });

    expect([...new Set(secretReferences)]).toEqual(["DOPPLER_TOKEN"]);
  });

  test("uses only GitHub's job-scoped token for GitHub API calls", () => {
    const tokenAssignments = depotWorkflowFiles.flatMap((file) => {
      const contents = readFileSync(resolve(repoRoot, file), "utf8");
      return [...contents.matchAll(/^\s+GITHUB_TOKEN:\s*(.+)$/gm)].map((match) => match[1]);
    });

    expect(tokenAssignments.length).toBeGreaterThan(0);
    expect([...new Set(tokenAssignments)]).toEqual(["${{ github.token }}"]);
  });

  test.each([
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
      file: ".depot/workflows/preview-os-next.yml",
      permissions: { contents: "read", "pull-requests": "write", statuses: "write" },
    },
    {
      file: ".depot/workflows/deploy-os-next.yml",
      permissions: { contents: "read", deployments: "write" },
    },
    {
      file: ".depot/workflows/loc-report.yml",
      permissions: { contents: "read", "pull-requests": "write" },
    },
    {
      file: ".depot/workflows/pr-dashboard.yml",
      permissions: {
        contents: "read",
        issues: "read",
        "pull-requests": "read",
      },
    },
    {
      file: ".depot/workflows/release.yml",
      permissions: { contents: "write" },
    },
    {
      file: ".depot/workflows/flake-dashboard.yml",
      permissions: { contents: "read" },
    },
  ])("$file grants only its required GitHub permissions", ({ file, permissions }) => {
    expect(loadWorkflow(file).permissions).toEqual(permissions);
  });

  test("loads the Depot telemetry token from preview without changing the PostHog config", () => {
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

  test("the flake dashboard lists every workflow that uploads flake records", () => {
    const uploaders = depotWorkflowFiles.flatMap((file) => {
      const workflow = parseYaml(readFileSync(resolve(repoRoot, file), "utf8")) as Workflow & {
        name: string;
      };
      return Object.values(workflow.jobs).some((job) =>
        (job.steps || []).some((step) =>
          String(step.with?.name || "").startsWith("flake-records-"),
        ),
      )
        ? [workflow.name]
        : [];
    });

    expect(uploaders.sort()).toEqual([...SUITE_WORKFLOWS].sort());
  });

  test("the iterate GitHub App's key is read only by the flake dashboard, which never runs on a pull request or push", () => {
    const readers = depotWorkflowFiles.filter((file) =>
      readFileSync(resolve(repoRoot, file), "utf8").includes("GITHUB_APP_PRIVATE_KEY"),
    );
    expect(readers).toEqual([".depot/workflows/flake-dashboard.yml"]);
    expect(
      Object.keys(loadWorkflow(".depot/workflows/flake-dashboard.yml").on || {}).sort(),
    ).toEqual(["schedule", "workflow_dispatch"]);
  });

  test("writes the flake dashboard with the Depot telemetry token and keeps its state only for real runs", () => {
    const steps = loadWorkflow(".depot/workflows/flake-dashboard.yml").jobs.update?.steps ?? [];
    const writer = steps.find((step) => step.run?.includes("scripts/ci/flake-dashboard/update.ts"));
    const keep = steps.find((step) => step.with?.name === "flake-dashboard-state");

    expect(writer?.run).toContain(
      "doppler secrets get DEPOT_CI_TELEMETRY_TOKEN --plain --project _shared --config preview",
    );
    expect(writer?.run).toContain("--state-out test-results/flake-dashboard/state.json");
    expect(keep).toMatchObject({
      if: "always() && inputs.dry-run != 'true'",
      uses: "actions/upload-artifact@v4",
      with: expect.objectContaining({ path: "test-results/flake-dashboard/state.json" }),
    });
    expect(steps.indexOf(writer!)).toBeLessThan(steps.indexOf(keep!));
  });
});

describe("Depot validation capacity", () => {
  test("refreshes the baked workspace when dependency inputs land on main", () => {
    const workflow = loadWorkflow(".depot/workflows/build-preview-ci-image.yml");

    expect(workflow.on?.push?.branches).toEqual(["main"]);
    expect(workflow.on?.push?.paths).toEqual(
      expect.arrayContaining([
        "**/package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "**/.npmrc",
        "patches/**",
        "scripts/depot-ci/dependencies.mjs",
        "scripts/depot-ci/bake-preview-ci-image.sh",
        ".depot/workflows/build-preview-ci-image.yml",
      ]),
    );
  });

  test.each(["deploy", "e2e"])(
    "starts the OS-Next preview %s job from the baked workspace",
    (jobId) => {
      const job = loadWorkflow(".depot/workflows/preview-os-next.yml").jobs[jobId];

      expect(job["runs-on"].image).toBe(bakedImage);

      const checkout = job.steps?.find((step) => step.uses === "actions/checkout@v4");
      expect(checkout?.with).toMatchObject({ clean: false });

      const reconcile = job.steps?.find((step) => step.name === "Reconcile dependencies (baked)");
      expect(reconcile?.run).toBe("node scripts/depot-ci/dependencies.mjs install");
      // Any one of these means the job installs its own toolchain instead of using the baked one.
      const installSteps = ["Setup pnpm", "Setup Node", "Install Doppler CLI"];
      expect(job.steps?.filter((step) => installSteps.includes(step.name || ""))).toEqual([]);
    },
  );

  test("runs every workspace test script", () => {
    const workflow = readFileSync(resolve(repoRoot, ".depot/workflows/test.yml"), "utf8");

    expect(readPackageJson(".").scripts?.test).toBe("pnpm -r --parallel test");
    expect(workflow).toContain("run: doppler run -- pnpm test");
  });

  test("the preview's e2e suite and browser specs write the canonical telemetry artifact", () => {
    expect(readPackageJson("apps/os").scripts?.e2e).toMatch(/retry-telemetry-reporter\.ts/);
    // The preview runs vitest directly (it must not rebuild the deployed dist/), so it names the
    // reporter itself.
    expect(readFileSync(resolve(repoRoot, "apps/os/scripts/preview.ts"), "utf8")).toContain(
      "--reporter=../../packages/shared/src/test-support/e2e-policy/retry-telemetry-reporter.ts",
    );
    expect(readFileSync(resolve(repoRoot, "apps/os/playwright.config.ts"), "utf8")).toContain(
      "scripts/ci/playwright-telemetry-reporter.ts",
    );
  });

  test("every unit-test workspace writes the canonical telemetry artifact", () => {
    const expectedWorkspaces = workspaceDirectories.flatMap((directory) => {
      const packageJson = readPackageJson(directory);
      const testCommand = [packageJson.scripts?.test, packageJson.scripts?.["test:unit"]]
        .filter(Boolean)
        .join(" ");
      if (!testCommand) return [];
      expect(
        testCommand,
        `${directory}/package.json must install the canonical test telemetry reporter`,
      ).toMatch(/retry-telemetry-reporter\.ts/);
      return [packageJson.name];
    });

    const finalizer = loadWorkflow(".depot/workflows/test.yml").jobs.test?.steps?.find((step) =>
      step.run?.includes("scripts/ci/upload-test-telemetry.ts"),
    );
    expect(finalizer?.env?.TEST_TELEMETRY_EXPECTED_WORKSPACES?.split(",").sort()).toEqual(
      expectedWorkspaces.sort(),
    );
  });

  test.each([
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

  test.each([
    { file: ".depot/workflows/test.yml", jobId: "test", group: "unit", suites: ["unit"] },
    {
      file: ".depot/workflows/preview-os-next.yml",
      jobId: "e2e",
      group: "preview",
      suites: ["specs", "preview-e2e"],
    },
  ])(
    "$file always finalizes and retains $group test telemetry",
    ({ file, jobId, group, suites }) => {
      const steps = loadWorkflow(file).jobs[jobId]?.steps ?? [];
      const finalizer = steps.find((step) =>
        step.run?.includes("scripts/ci/upload-test-telemetry.ts"),
      );
      // Flake records have their own upload. Select the complete telemetry directory this
      // retention guard is about.
      const upload = steps.find(
        (step) =>
          step.uses === "actions/upload-artifact@v4" &&
          step.with?.path === "test-results/ci-telemetry",
      );

      expect(finalizer, `${file} must normalize telemetry`).toMatchObject({ if: "always()" });
      expect(finalizer?.run, `${file} must not send cancelled runs as test failures`).toContain(
        "cancelled() && '--cancelled'",
      );
      expect(finalizer?.run, `${file} must write its suites' summaries`).toContain(
        `--flake-suites ${group}`,
      );
      expect(upload, `${file} must retain raw and normalized telemetry`).toMatchObject({
        if: "always()",
        with: expect.objectContaining({
          path: expect.stringContaining("test-results"),
          "if-no-files-found": "error",
        }),
      });
      expect(steps.indexOf(finalizer!)).toBeLessThan(steps.indexOf(upload!));
      // Every suite's records (and the summary the finalizer wrote beside them) leave the job after
      // the finalizer, whatever the suite's outcome.
      for (const suite of suites) {
        const records = steps.find((step) => step.with?.name === `flake-records-${suite}`);
        expect(records, `${file} must upload flake-records-${suite}`).toMatchObject({
          if: "always()",
          uses: "actions/upload-artifact@v4",
        });
        expect(steps.indexOf(finalizer!)).toBeLessThan(steps.indexOf(records!));
      }
    },
  );

  test("labels unit artifacts with the exact checked-out pull-request head", () => {
    const runTests = loadWorkflow(".depot/workflows/test.yml").jobs.test.steps?.find(
      (step) => step.name === "Run Tests",
    );

    expect(runTests?.env).toMatchObject({
      TEST_TELEMETRY_BRANCH: "${{ github.head_ref || github.ref_name }}",
      TEST_TELEMETRY_HEAD_SHA: "${{ github.event.pull_request.head.sha || github.sha }}",
      TEST_TELEMETRY_PULL_REQUEST_NUMBER: "${{ github.event.pull_request.number }}",
    });
  });

  test.each([
    [".depot/workflows/test.yml", "test"],
    [".depot/workflows/preview-os-next.yml", "e2e"],
  ])("%s finalizes test telemetry under the canonical PostHog project", (file, jobId) => {
    const finalizer = loadWorkflow(file).jobs[jobId]?.steps?.find((step) =>
      step.run?.includes("scripts/ci/upload-test-telemetry.ts"),
    );

    expect(finalizer?.run).toContain("doppler run --project _shared --config prd --");
  });
});
