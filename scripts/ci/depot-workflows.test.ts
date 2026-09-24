import { readFileSync, readdirSync } from "node:fs";
import { join, matchesGlob, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { SUITE_WORKFLOWS } from "./flake-dashboard/update.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const bakedImage = "0p91s0lz49.registry.depot.dev/iterate-preview-ci:node24-pnpm10-worktree";

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  name?: string;
  if?: string;
  parallel?: WorkflowStep[];
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  "working-directory"?: string;
};

type WorkflowJob = {
  permissions?: Record<string, string>;
  "runs-on": {
    image?: string;
    size?: string;
  };
  "timeout-minutes"?: number;
  steps?: WorkflowStep[];
};

type Workflow = {
  concurrency?: {
    group: string;
    "cancel-in-progress": boolean;
  };
  env?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
  permissions?: Record<string, string>;
  on?: {
    pull_request?: {
      paths?: string[];
      types?: string[];
    };
    push?: {
      branches?: string[];
      paths?: string[];
    };
    schedule?: Array<{ cron: string }>;
  };
};

function loadWorkflow(file: string): Workflow {
  return parseYaml(readFileSync(resolve(repoRoot, file), "utf8")) as Workflow;
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

  test.each(deploymentWorkflows.filter(({ app }) => app !== "os-next"))(
    "$file does not redeploy for the platform's source, which no client imports",
    ({ file }) => {
      expect(triggers(loadWorkflow(file).on?.push?.paths ?? [], "apps/os/src/worker.ts")).toBe(
        false,
      );
    },
  );

  test.each(["kit", "voice"])(
    "deploy-%s.yml redeploys when apps/agents changes: vite.config.ts builds voice-install.json from it",
    (app) => {
      const paths = loadWorkflow(`.depot/workflows/deploy-${app}.yml`).on?.push?.paths ?? [];
      expect(triggers(paths, "apps/agents/runtime/index.ts")).toBe(true);
      expect(triggers(paths, "apps/agents/voice/screen-context.md")).toBe(true);
    },
  );

  test("deploy-spa.yml ignores the root manifests and lockfile: no npm dependency ships", () => {
    const paths = loadWorkflow(".depot/workflows/deploy-spa.yml").on?.push?.paths ?? [];
    for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      expect(triggers(paths, file), `${file} does not deploy`).toBe(false);
    }
    expect(triggers(paths, "apps/spa/public/index.html")).toBe(true);
  });

  test("deploy-os-next.yml runs for what reaches the Worker, not the app's docs, tests or preview tooling", () => {
    const paths = loadWorkflow(".depot/workflows/deploy-os-next.yml").on?.push?.paths ?? [];
    const shipped = ["apps/os/src", "apps/os/public"].flatMap((directory) =>
      readdirSync(resolve(repoRoot, directory), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.endsWith(".test.ts"))
        .map((entry) => relative(repoRoot, join(entry.parentPath, entry.name))),
    );

    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped.filter((file) => !triggers(paths, file))).toEqual([]);
    for (const file of [
      "apps/os/public/setup-prompt.md", // served at os.iterate.com/setup-prompt.md
      "apps/os/scripts/build.ts",
      "apps/os/scripts/deploy.ts",
      "apps/os/scripts/generate-wrangler-config.ts",
      "apps/os/vite.config.ts",
      "apps/os/wrangler.base.jsonc",
      "configs-next/default/AGENTS.md", // build.ts bakes it into the Worker
      "scripts/lib/deploy-app.ts",
    ]) {
      expect(triggers(paths, file), `${file} deploys`).toBe(true);
    }
    for (const file of [
      "apps/os/README.md",
      "apps/os/SELF-HOSTING.md",
      "apps/os/docs/project-seeds.md",
      "apps/os/e2e/AGENTS.md",
      "apps/os/e2e/support/client.ts",
      "apps/os/src/project/templates.test.ts",
      "apps/os/__workers-tests__/support.ts",
      "apps/os/bench/api.bench.ts",
      "apps/os/scripts/preview.ts",
      "apps/os/scripts/preview-config.ts",
      "apps/os/scripts/e2e-soak.ts",
      "scripts/depot-ci/dependencies.mjs",
    ]) {
      expect(triggers(paths, file), `${file} does not deploy`).toBe(false);
    }
  });

  test.each(
    deploymentWorkflows.filter(({ app }) =>
      ["os-next", "dash", "agents", "notes", "voice", "kit"].includes(app),
    ),
  )("$file posts the deploy's own result to #ci as the deploy job's last step", ({ file }) => {
    const workflow = loadWorkflow(file);
    const steps = workflow.jobs.deploy?.steps ?? [];

    expect(Object.keys(workflow.jobs)).toEqual(["deploy"]);
    expect(steps.filter((step) => step.id === "deploy")).toHaveLength(1);
    expect(steps.at(-1)).toMatchObject({
      name: "Notify Slack",
      if: "${{ always() && github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
      env: expect.objectContaining({
        DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
        APP_DISPLAY_NAME: expect.any(String),
        PUBLIC_URL: expect.stringMatching(/^https:\/\//),
      }),
      run: "pnpm tsx scripts/ci/notify.ts deploy-${{ steps.deploy.outcome == 'success' && 'success' || 'failure' }}",
    });
  });

  test("runs OS and Notes stateful proofs only against an isolated preview", () => {
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
        // the root Playwright suite (specs/AGENTS.md) runs only here
        "specs/**",
        "playwright.config.ts",
      ]),
    );
    // one `pnpm spec` in the e2e job runs every project, the notes one against the Notes preview
    expect(previewScript).toContain('run("pnpm", ["spec"], {');
    expect(previewScript).toContain('NOTES_BASE_URL: appUrl("notes")');
    expect(previewScript).toContain('VOICE_BASE_URL: appUrl("voice")');
    expect(previewScript).toContain('DASH_BASE_URL: appUrl("dash")');
  });

  // apps/kit/README.md "Firmware releases": the Kit Worker streams firmware from GitHub releases
  test("Kit deploys only the installer; firmware ships as GitHub releases", () => {
    const workflow = loadWorkflow(".depot/workflows/deploy-kit.yml");
    const deploy = workflow.jobs.deploy!;
    const paths = workflow.on?.push?.paths || [];
    const runs = (deploy.steps || []).map((step) => step.run || "");

    expect(runs.filter((run) => /esp-idf|export\.sh|firmware:/i.test(run))).toEqual([]);
    expect(deploy).toMatchObject({ "runs-on": { size: "2x8" } });
    expect(triggers(paths, "apps/kit/firmware/targets/havpe/CMakeLists.txt")).toBe(false);
    expect(triggers(paths, "apps/kit/src/firmware/catalog.ts")).toBe(true);
    expect(paths).toEqual(
      expect.arrayContaining([
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
      file: ".depot/workflows/preview-sweep.yml",
      permissions: { contents: "read", "pull-requests": "read" },
    },
    {
      file: ".depot/workflows/preview-delete.yml",
      permissions: { contents: "read", "pull-requests": "read" },
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
    {
      file: ".depot/workflows/kit-firmware.yml",
      permissions: { contents: "read" },
    },
  ])("$file grants only its required GitHub permissions", ({ file, permissions }) => {
    expect(loadWorkflow(file).permissions).toEqual(permissions);
  });

  // The legs run the firmware's own CMake, third-party components and scripts; none of them may hold
  // a token that can create a release (apps/kit/scripts/firmware-release.ts).
  test("Kit Firmware publishes from one job that runs no repository code", () => {
    const workflow = loadWorkflow(".depot/workflows/kit-firmware.yml");
    const writers = Object.entries(workflow.jobs).filter(
      ([, job]) => job.permissions?.contents === "write",
    );
    const publish = workflow.jobs["publish-firmware"]!;
    const checkouts = Object.values(workflow.jobs).flatMap((job) =>
      (job.steps || []).filter((step) => step.uses?.startsWith("actions/checkout")),
    );

    expect(writers.map(([jobId]) => jobId)).toEqual(["publish-firmware"]);
    expect(publish.steps?.filter((step) => step.uses?.startsWith("actions/checkout"))).toEqual([]);
    expect(checkouts.length).toBeGreaterThan(0);
    for (const checkout of checkouts) expect(checkout.with?.["persist-credentials"]).toBe(false);
    // the daily vYYYY-… release stays the repository's Latest
    expect(publish.steps?.map((step) => step.run || "").join("\n")).toContain("--latest=false");
    expect(workflow.on?.push?.paths).toEqual(workflow.on?.pull_request?.paths);
    // the schedule is the bounded recovery for a failed publish
    expect(workflow.on?.schedule).toEqual([{ cron: expect.any(String) }]);
  });

  test("release.yml never takes a kit-firmware tag for the last release", () => {
    const releaseInfo = loadWorkflow(".depot/workflows/release.yml").jobs.release?.steps?.find(
      (step) => step.name === "Get release info",
    );

    expect(releaseInfo?.run).toContain("git describe --tags --abbrev=0 --match 'v[0-9]*'");
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

  test.for([
    { file: ".depot/workflows/preview-os-next.yml", jobId: "deploy" },
    { file: ".depot/workflows/preview-os-next.yml", jobId: "e2e" },
    { file: ".depot/workflows/preview-sweep.yml", jobId: "sweep" },
    { file: ".depot/workflows/preview-delete.yml", jobId: "delete" },
  ])("$file $jobId starts from the baked workspace", ({ file, jobId }) => {
    const workflow = loadWorkflow(file);
    const job = workflow.jobs[jobId];

    expect(job["runs-on"]).toMatchObject({ image: bakedImage });
    // the store the image was baked with, or the reconcile never reuses the baked node_modules
    expect(workflow.env).toMatchObject({ PNPM_CONFIG_STORE_DIR: "/home/runner/.pnpm-store" });

    const checkout = job.steps?.find((step) => step.uses === "actions/checkout@v4");
    expect(checkout?.with).toMatchObject({ clean: false });

    const reconcile = job.steps?.find((step) => step.name === "Reconcile dependencies (baked)");
    expect(reconcile?.run).toBe("node scripts/depot-ci/dependencies.mjs install");
    // Any one of these means the job installs its own toolchain instead of using the baked one.
    const installSteps = ["Setup pnpm", "Setup Node", "Install Doppler CLI"];
    expect(job.steps?.filter((step) => installSteps.includes(step.name || ""))).toEqual([]);
  });

  // Each runs the baked image's pnpm install, which the 2x8 client deploys run too (Deploy Dash's
  // whole job takes under a minute), then calls APIs or runs one git command at a time: a larger
  // runner only costs more.
  test.for([
    { file: ".depot/workflows/loc-report.yml", jobId: "loc-report" },
    { file: ".depot/workflows/pr-dashboard.yml", jobId: "update_dashboard" },
    { file: ".depot/workflows/release.yml", jobId: "release" },
  ])("$file runs on the smallest runner", ({ file, jobId }) => {
    expect(loadWorkflow(file).jobs[jobId]?.["runs-on"]).toMatchObject({ size: "2x8" });
  });

  test("the nightly preview sweep runs alone, one at a time, never cancelled", () => {
    const workflow = loadWorkflow(".depot/workflows/preview-sweep.yml");

    expect(workflow).toMatchObject({
      on: { schedule: [{ cron: "37 4 * * *" }] },
      concurrency: { group: "preview-sweep", "cancel-in-progress": false },
    });
    expect(workflow.jobs.sweep?.steps?.at(-1)).toMatchObject({
      "working-directory": "apps/os",
      run: "doppler run -- pnpm preview sweep",
    });
  });

  // A job of Preview OS that ran only on `closed` was a skipped check on every push to an open PR.
  test("a closed PR's preview is deleted by its own workflow, in that PR's preview group", () => {
    const preview = loadWorkflow(".depot/workflows/preview-os-next.yml");
    const workflow = loadWorkflow(".depot/workflows/preview-delete.yml");

    expect(preview.on?.pull_request?.types).not.toContain("closed");
    expect(Object.keys(workflow.on || {}).sort()).toEqual(["pull_request", "workflow_dispatch"]);
    expect(workflow).toMatchObject({
      // every PR that got a preview, and no other
      on: { pull_request: { types: ["closed"], paths: preview.on?.pull_request?.paths } },
      // a delete waits for the PR's in-flight deploy and e2e instead of racing them
      concurrency: preview.concurrency,
    });
    expect(workflow.jobs.delete?.steps?.at(-1)).toMatchObject({
      "working-directory": "apps/os",
      run: "doppler run -- pnpm preview delete",
    });
  });

  // A scheduled run reports on main's head commit, and a push or PR run of a workflow whose job
  // only runs on its schedule carries that job as a skipped check. Two workflows run the same jobs
  // on every trigger: the image bake (its push to main runs the same bake), and Kit Firmware,
  // whose daily run re-plans every board so a failed publish is repaired without a firmware push.
  test.for(
    depotWorkflowFiles.filter(
      (file) =>
        loadWorkflow(file).on?.schedule &&
        ![
          ".depot/workflows/build-preview-ci-image.yml",
          ".depot/workflows/kit-firmware.yml",
        ].includes(file),
    ),
  )("%s runs only on its schedule or on request", (file) => {
    expect(
      Object.keys(loadWorkflow(file).on || {}).filter(
        (event) => !["schedule", "workflow_dispatch", "workflow_call"].includes(event),
      ),
    ).toEqual([]);
  });

  test("runs every workspace test script, then Kit's firmware host tests", () => {
    const steps = loadWorkflow(".depot/workflows/test.yml").jobs.test.steps ?? [];
    const runTests = steps.findIndex((step) => step.name === "Run Tests");
    const firmwareHostTests = steps.findIndex(
      (step) => step.run === "pnpm --dir apps/kit firmware:test:host",
    );

    expect(readPackageJson(".").scripts?.test).toBe("pnpm -r --parallel test");
    expect(steps[runTests]?.run).toBe("doppler run -- pnpm test");
    // The host tests need cmake, so they stay out of `pnpm test` (which then runs on any machine)
    // and keep their place in the required Test check as a step of their own.
    expect(readPackageJson("apps/kit").scripts?.test).not.toContain("firmware:test:host");
    expect(firmwareHostTests).toBeGreaterThan(runTests);
    expect(steps[firmwareHostTests]?.if).toBe("${{ !cancelled() }}");
  });

  test("the Lint check runs the root lint script that local runs use", () => {
    const steps = loadWorkflow(".depot/workflows/lint-typecheck.yml").jobs["lint-typecheck"].steps;
    const lint = steps
      ?.flatMap((step) => step.parallel || [step])
      .find((step) => step.name === "Run Lint");
    const scripts = readPackageJson(".").scripts;

    expect(lint?.run).toBe("pnpm lint");
    expect(scripts?.lint).toBe("oxlint . --threads 1 --deny-warnings");
    // One thread for fixes too: at the default one per core, every JS worker starts its own
    // type-aware service and grandfather-rule git spawns, and a 16-core machine hits spawn ENOMEM.
    // Measured at 1, 4, 8 and 12 threads, more threads were no faster.
    expect(scripts?.["lint:fix"]).toBe("oxlint . --fix --threads 1");
  });

  test("the preview's e2e suite and browser specs write the canonical telemetry artifact", () => {
    // `e2e` is a build plus `e2e:run`; the preview runs `e2e:run` alone (it must not rebuild the
    // deployed dist/), so the reporter lives on `e2e:run`.
    expect(readPackageJson("apps/os").scripts?.e2e).toBe("pnpm build && pnpm e2e:run");
    expect(readPackageJson("apps/os").scripts?.["e2e:run"]).toMatch(/retry-telemetry-reporter\.ts/);
    expect(readFileSync(resolve(repoRoot, "apps/os/scripts/preview.ts"), "utf8")).toContain(
      'runAsync("pnpm", ["e2e:run"]',
    );
    expect(readFileSync(resolve(repoRoot, "playwright.config.ts"), "utf8")).toContain(
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

  test("the preview e2e job keeps the browser evidence, whatever the suite's outcome", () => {
    const steps = loadWorkflow(".depot/workflows/preview-os-next.yml").jobs.e2e?.steps ?? [];
    const playwrightConfig = readFileSync(resolve(repoRoot, "playwright.config.ts"), "utf8");
    const suite = steps.find((step) => step.run?.includes("pnpm preview e2e"));
    const results = steps.find((step) => step.with?.name === "preview-os-test-artifacts");
    const report = steps.find((step) => step.with?.name === "public-playwright-report");

    // the root config writes per-test output (traces, screenshots, error context) and the HTML
    // report under the directory the job uploads
    expect(playwrightConfig).toContain('outputDir: "test-results/playwright-output"');
    expect(playwrightConfig).toContain('outputFolder: "test-results/playwright-html"');
    expect(results).toMatchObject({
      if: "always()",
      uses: "actions/upload-artifact@v4",
      with: expect.objectContaining({ path: "test-results" }),
    });
    expect(report).toMatchObject({
      if: expect.stringContaining("always()"),
      uses: "actions/upload-artifact@v4",
      with: expect.objectContaining({ path: "test-results/playwright-html" }),
    });
    expect(steps.indexOf(suite!)).toBeLessThan(steps.indexOf(results!));
    expect(steps.indexOf(suite!)).toBeLessThan(steps.indexOf(report!));
  });

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
