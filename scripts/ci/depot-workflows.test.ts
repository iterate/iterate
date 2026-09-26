import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, matchesGlob, relative, resolve } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { temporaryDirectory } from "@iterate-com/shared/test-support/temporary-directory";
import { testEvidencePaths } from "@iterate-com/shared/test-support/test-evidence";
import { CI_WORKFLOW_PREVIEWS } from "../../apps/os/scripts/preview-sweep.ts";
import { stateArtifact as osLatencyState } from "./os-latency-guard.ts";
import { stepFailureTitles, testEvidenceJobs } from "./test-evidence.ts";
import { CHECKS, stateArtifact as prTtgState } from "./pr-ttg-guard.ts";
import { stateArtifact as prdFaultAlarmState } from "./prd-fault-alarm.ts";
import { previewPaths } from "./preview-paths.ts";
import { unitTestWorkspaces } from "./test-telemetry-completeness.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const bakedImage = "0p91s0lz49.registry.depot.dev/iterate-preview-ci:node24-pnpm10-worktree";
const espIdfImage = "0p91s0lz49.registry.depot.dev/iterate-esp-idf-ci:node24";
/** What a test job's evidence artifacts end with: the job attempt's id (docs/depot-ci.md#artifacts-per-job-attempt). */
const attemptSuffix = "-attempt-${{ steps.attempt.outputs.id }}";

type WorkflowStep = {
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
  "fail-fast"?: boolean;
  id?: string;
  name?: string;
  if?: string;
  parallel?: WorkflowStep[];
  run?: string;
  "timeout-minutes"?: number;
  uses?: string;
  with?: Record<string, unknown>;
  "working-directory"?: string;
};

type WorkflowJob = {
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  name?: string;
  needs?: string | string[];
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
  name?: string;
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

// ── Depot deployment safety ──
test("finds the production deploy workflows", () => {
  expect(deploymentWorkflows.map(({ app }) => app)).toEqual(
    expect.arrayContaining(["os", "dash", "agents", "notes", "voice", "kit", "spa"]),
  );
});

test.each(deploymentWorkflows)(
  "$file serializes the destination without cancelling an active deploy",
  ({ file, app }) => {
    const workflow = loadWorkflow(file);

    expect(workflow).toMatchObject({
      concurrency: { group: `deploy-${app}-production`, "cancel-in-progress": false },
    });
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      expect(job["runs-on"], `${file} job ${jobId} runs on the baked image`).toMatchObject({
        image: bakedImage,
      });
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
    const packageJson = readPackageJson(`apps/${app}`);
    const workspaceDependencies = Object.entries({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    })
      .filter(([, version]) => version.startsWith("workspace:"))
      .map(([name]) => workspaceByName.get(name));

    expect(loadWorkflow(file).on?.push?.paths).toEqual(
      expect.arrayContaining([
        file,
        `apps/${app}/**`,
        ...workspaceDependencies.map((directory) => `${directory}/**`),
      ]),
    );
  },
);

test.each(deploymentWorkflows.filter(({ app }) => app !== "os"))(
  "$file does not redeploy for the platform's source, which no client imports",
  ({ file }) => {
    expect(triggers(loadWorkflow(file).on?.push?.paths ?? [], "apps/os/src/worker.ts")).toBe(false);
  },
);

test.each(["kit", "voice"])(
  "deploy-%s.yml redeploys when the agents or voice package changes: its installer ships in the app",
  (app) => {
    const paths = loadWorkflow(`.depot/workflows/deploy-${app}.yml`).on?.push?.paths ?? [];
    expect(triggers(paths, "packages/agents/src/install.ts")).toBe(true);
    expect(triggers(paths, "packages/voice/src/install.ts")).toBe(true);
  },
);

test("deploy-spa.yml ignores the root manifests and lockfile: capnweb ships with the next deploy", () => {
  const paths = loadWorkflow(".depot/workflows/deploy-spa.yml").on?.push?.paths ?? [];
  for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    expect(triggers(paths, file), `${file} does not deploy`).toBe(false);
  }
  expect(triggers(paths, "apps/spa/public/index.html")).toBe(true);
  expect(triggers(paths, "apps/browser-extension/public/panel.js")).toBe(true);
});

test("deploy-os.yml runs for what reaches the Worker, not the app's docs, tests or preview tooling", () => {
  const paths = loadWorkflow(".depot/workflows/deploy-os.yml").on?.push?.paths ?? [];
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
    "configs/default/AGENTS.md", // build.ts bakes it into the Worker
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
    "apps/os/perf/push-delivery.perf.test.ts",
    "apps/os/perf/latency.ts",
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
    ["os", "dash", "agents", "notes", "admin", "voice", "kit"].includes(app),
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
  for (const { file } of deploymentWorkflows) {
    const runs = Object.values(loadWorkflow(file).jobs).flatMap((job) =>
      (job.steps || []).map((step) => step.run || ""),
    );
    for (const suite of [
      "pnpm e2e",
      "pnpm spec",
      "pnpm preview e2e",
      "pnpm preview specs",
      'pnpm preview "$SUITE"',
    ]) {
      expect(
        runs.filter((run) => run.includes(suite)),
        `${file} must not run ${suite}`,
      ).toEqual([]);
    }
  }
  expect(previewPaths).toEqual(
    expect.arrayContaining([
      ".depot/workflows/deploy-os.yml",
      ".depot/workflows/deploy-notes.yml",
      // the root Playwright suite (specs/AGENTS.md) runs only here
      "specs/**",
      "playwright.config.ts",
    ]),
  );
});

// apps/kit/README.md "Firmware releases": the Kit Worker streams firmware from GitHub releases
test("Kit deploys only the installer; firmware ships as GitHub releases", () => {
  const workflow = loadWorkflow(".depot/workflows/deploy-kit.yml");
  const deploy = workflow.jobs.deploy!;
  const paths = workflow.on?.push?.paths || [];
  const runs = (deploy.steps || []).map((step) => step.run || "");

  expect(runs.filter((run) => /esp-idf|export\.sh|firmware:/i.test(run))).toEqual([]);
  expect(triggers(paths, "apps/kit/firmware/targets/havpe/CMakeLists.txt")).toBe(false);
  expect(triggers(paths, "apps/kit/src/firmware/catalog.ts")).toBe(true);
  expect(paths).toEqual(
    expect.arrayContaining(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "patches/**"]),
  );
});

// ── Depot credential boundaries ──
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
    permissions: { contents: "read", "pull-requests": "read" },
  },
  {
    file: ".depot/workflows/preview-os.yml",
    permissions: { contents: "read", "pull-requests": "write", statuses: "write" },
  },
  {
    file: ".depot/workflows/main-os-e2e.yml",
    permissions: { contents: "read", statuses: "write" },
  },
  {
    file: ".depot/workflows/preview-sweep.yml",
    permissions: { contents: "read", "pull-requests": "read" },
  },
  {
    file: ".depot/workflows/preview-delete.yml",
    permissions: { contents: "read" },
  },
  {
    file: ".depot/workflows/preview-parents.yml",
    permissions: { contents: "read" },
  },
  {
    file: ".depot/workflows/deploy-os.yml",
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
  {
    file: ".depot/workflows/pr-ttg.yml",
    permissions: { contents: "read" },
  },
])("$file grants only its required GitHub permissions", ({ file, permissions }) => {
  // oxlint-disable-next-line iterate/prefer-object-property-match -- exact: an extra permission must fail
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

// A leg that installed ESP-IDF itself made a GitHub clone and a PyPI install, and one broken
// download failed a board with no firmware change (scripts/depot-ci/esp-idf.sh). The image is the
// legs' own: in the shared one, ESP-IDF's 3.9 GB and downloads rode along on every bake.
test("Kit Firmware legs take ESP-IDF from their own CI image", () => {
  const workflow = loadWorkflow(".depot/workflows/kit-firmware.yml");
  const leg = workflow.jobs["build-firmware"]!;
  const runs = (leg.steps || []).map((step) => step.run || "");
  const bake = loadWorkflow(".depot/workflows/build-esp-idf-image.yml");
  const bakeSteps = bake.jobs["build-image"]!.steps || [];
  const sharedBake = readFileSync(
    resolve(repoRoot, "scripts/depot-ci/bake-preview-ci-image.sh"),
    "utf8",
  );

  expect(leg["runs-on"]).toMatchObject({ image: espIdfImage });
  expect(runs).toContain("scripts/depot-ci/esp-idf.sh ensure");
  expect(runs.filter((run) => /git clone|install\.sh/.test(run))).toEqual([]);
  expect(bakeSteps.map((step) => step.run)).toContain("scripts/depot-ci/esp-idf.sh install");
  expect(bakeSteps.at(-1)).toMatchObject({
    uses: "depot/snapshot-action@v1",
    with: { image: espIdfImage },
  });
  expect(bake.on?.push?.paths).toContain("scripts/depot-ci/esp-idf.sh");
  expect(sharedBake).not.toContain("esp-idf");
  expect(workflow.on?.pull_request?.paths).toContain("scripts/depot-ci/esp-idf.sh");
});

test("release.yml never takes a kit-firmware tag for the last release", () => {
  const releaseInfo = loadWorkflow(".depot/workflows/release.yml").jobs.release?.steps?.find(
    (step) => step.name === "Get release info",
  );

  expect(releaseInfo?.run).toContain("git describe --tags --abbrev=0 --match 'v[0-9]*'");
});

test("every job that records flakes uploads its test evidence to R2, where the flake dashboard reads them", () => {
  const jobs = depotWorkflowFiles.flatMap((file) =>
    Object.entries(loadWorkflow(file).jobs).flatMap(([jobId, job]) =>
      (job.steps || []).some((step) => String(step.with?.name || "").startsWith("flake-records-"))
        ? [{ job: `${file}:${jobId}`, steps: job.steps || [] }]
        : [],
    ),
  );

  expect(jobs.length).toBeGreaterThan(0);
  for (const { job, steps } of jobs)
    expect(
      steps.some((step) => step.run?.includes("scripts/ci/test-evidence.ts upload")),
      job,
    ).toBe(true);
});

test("the iterate GitHub App's key is read only by the flake dashboard, which never runs on a pull request or push", () => {
  const readers = depotWorkflowFiles.filter((file) =>
    readFileSync(resolve(repoRoot, file), "utf8").includes("GITHUB_APP_PRIVATE_KEY"),
  );
  expect(readers).toEqual([".depot/workflows/flake-dashboard.yml"]);
  expect(Object.keys(loadWorkflow(".depot/workflows/flake-dashboard.yml").on || {}).sort()).toEqual(
    ["schedule", "workflow_dispatch"],
  );
});

// Each scheduled guard hands its state to its next run as an artifact of its own workflow
// (scripts/ci/depot.ts newestArtifactFile): the workflow the guard names uploads the file the guard
// wrote, whatever the run's outcome, and the guard reads back what its previous-state step saved.
// The scripts decide which runs write one: the latency, time-to-green and fault guards only a real
// run on main (their `--ref`).
const guards = [
  { script: "scripts/ci/os-latency-guard.ts", state: osLatencyState },
  { script: "scripts/ci/pr-ttg-guard.ts", state: prTtgState },
  { script: "scripts/ci/prd-fault-alarm.ts", state: prdFaultAlarmState },
];
test.each(guards)("$script keeps its state for its next run", ({ script, state }) => {
  const workflows = depotWorkflowFiles
    .map((file) => loadWorkflow(file))
    .filter((workflow) => workflow.name === state.workflow);
  expect(workflows).toHaveLength(1);
  const steps = Object.values(workflows[0]!.jobs).flatMap((job) => job.steps || []);
  const keep = steps.find((step) => step.with?.name === state.artifact);
  const path = String(keep?.with?.path);
  const writer = steps.find(
    (step) => step.run?.includes(script) && step.run.includes(`--state-out ${path}`),
  );
  const saved = steps.map((step) => /previous-state --out (\S+)/u.exec(step.run || "")?.[1]);

  expect(keep).toMatchObject({
    if: expect.stringMatching(/^always\(\)/u),
    uses: "actions/upload-artifact@v4",
  });
  expect(path.endsWith(`/${state.file}`), path).toBe(true);
  expect(writer, `${script} writes --state-out ${path}`).toBeDefined();
  expect(steps.indexOf(writer!)).toBeLessThan(steps.indexOf(keep!));
  for (const out of saved.filter(Boolean)) expect(writer?.run).toContain(`--state ${out}`);
});

test("every artifact kept as a run's state is a guard's", () => {
  const kept = depotWorkflowFiles.flatMap((file) =>
    Object.values(loadWorkflow(file).jobs).flatMap((job) =>
      (job.steps || []).flatMap((step) => {
        const name = String(step.with?.name || "");
        return name.endsWith("-state") ? [name] : [];
      }),
    ),
  );
  expect(kept.toSorted()).toEqual(guards.map(({ state }) => state.artifact).toSorted());
});

test("the PR time-to-green guard's checks are workflows by their names", () => {
  const names = depotWorkflowFiles.map((file) => loadWorkflow(file).name);
  for (const check of CHECKS) expect(names, check).toContain(check);
});

// ── Depot validation capacity ──
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
  { file: ".depot/workflows/preview-os.yml", jobId: "deploy" },
  { file: ".depot/workflows/preview-os.yml", jobId: "e2e" },
  { file: ".depot/workflows/preview-os.yml", jobId: "specs" },
  { file: ".depot/workflows/preview-sweep.yml", jobId: "sweep" },
  { file: ".depot/workflows/preview-sweep.yml", jobId: "reset-parent" },
  { file: ".depot/workflows/preview-delete.yml", jobId: "delete" },
  { file: ".depot/workflows/preview-parents.yml", jobId: "deploy" },
])("$file $jobId starts from the baked workspace", ({ file, jobId }) => {
  const job = loadWorkflow(file).jobs[jobId];

  // its image, store and checkout: the next test, for every job that reconciles
  const reconcile = job.steps?.find((step) => step.name === "Reconcile dependencies (baked)");
  expect(reconcile?.run).toBe("node scripts/depot-ci/dependencies.mjs install");
});

// Reuse of the baked node_modules hangs on all three: the image's preinstalled workspace, the
// store it was baked with (dependencies.mjs fingerprints every pnpm_config_*), and the reconcile
// command itself. A job missing one pays a full install on every run, and the image bake's check,
// which compares the same fingerprint with the image's stamp, would bake on every push.
test("every job that fingerprints the baked workspace has the image, the store and the checkout it needs", () => {
  const reconcilers = readdirSync(resolve(repoRoot, ".depot/workflows"))
    .filter((file) => file.endsWith(".yml"))
    .flatMap((file) => {
      const workflow = loadWorkflow(`.depot/workflows/${file}`);
      return Object.entries(workflow.jobs).flatMap(([jobId, job]) =>
        job.steps?.some((step) => step.run?.includes("node scripts/depot-ci/dependencies.mjs "))
          ? [{ file, jobId, workflow, job }]
          : [],
      );
    });
  expect(reconcilers.length).toBeGreaterThan(0);
  for (const { file, jobId, workflow, job } of reconcilers) {
    expect({ file, jobId, image: job["runs-on"] }).toMatchObject({
      image: expect.objectContaining({ image: bakedImage }),
    });
    expect({ file, jobId, env: { ...workflow.env, ...job.env } }).toMatchObject({
      env: expect.objectContaining({ PNPM_CONFIG_STORE_DIR: "/home/runner/.pnpm-store" }),
    });
    const checkout = job.steps?.find((step) => step.uses === "actions/checkout@v4");
    expect({ file, jobId, checkout: checkout?.with }).toMatchObject({
      checkout: expect.objectContaining({ clean: false }),
    });
  }
});

test("a step named for the baked reconcile runs it", () => {
  const misnamed = readdirSync(resolve(repoRoot, ".depot/workflows"))
    .filter((file) => file.endsWith(".yml"))
    .flatMap((file) =>
      Object.values(loadWorkflow(`.depot/workflows/${file}`).jobs).flatMap((job) =>
        (job.steps || []).filter(
          (step) =>
            step.name === "Reconcile dependencies (baked)" &&
            step.run !== "node scripts/depot-ci/dependencies.mjs install",
        ),
      ),
    );
  expect(misnamed).toEqual([]);
});

// The Test job installs on purpose: its install pages the lazily loaded image in (test.yml).
test("jobs on the baked image install no toolchain or dependencies of their own, but Test", () => {
  const install = /pnpm install|setup-node|action-setup|cli\.doppler\.com/;
  const ownInstalls = depotWorkflowFiles.flatMap((file) =>
    Object.entries(loadWorkflow(file).jobs).flatMap(([jobId, job]) =>
      job["runs-on"].image === bakedImage
        ? (job.steps || [])
            .filter((step) => install.test(`${step.run} ${step.uses}`))
            .map((step) => `${file} ${jobId}: ${step.name}`)
        : [],
    ),
  );
  expect(ownInstalls).toEqual([
    ".depot/workflows/test.yml test: Install dependencies (pages the baked tree in)",
  ]);
});

// People and agents use the parents (os.iterate-dev-preview.workers.dev, dash.…); what they leave
// goes nightly, never while a push to main deploys the parent.
test("the os parent's data is reset nightly, in the parents' deploy group", () => {
  const workflow = loadWorkflow(".depot/workflows/preview-sweep.yml");
  const parents = loadWorkflow(".depot/workflows/preview-parents.yml");

  expect(workflow.jobs["reset-parent"]).toMatchObject({
    concurrency: { ...parents.concurrency, "cancel-in-progress": false },
  });
  expect(workflow.jobs["reset-parent"]?.steps?.at(-1)).toMatchObject({
    "working-directory": "apps/os",
    run: "doppler run -- pnpm preview reset-parent",
  });
});

// The parents every preview branches from are main's: they deploy when a PR's preview would have.
test("the preview parents deploy from main, for the paths a PR gets a preview for, one at a time", () => {
  const workflow = loadWorkflow(".depot/workflows/preview-parents.yml");

  expect(workflow).toMatchObject({
    on: {
      push: {
        branches: ["main"],
        paths: [...previewPaths, ".depot/workflows/preview-parents.yml"],
      },
      workflow_dispatch: { inputs: { ref: { required: false } } },
    },
    concurrency: { group: "preview-parents", "cancel-in-progress": false },
  });
  expect(workflow.jobs.deploy?.steps?.at(-1)).toMatchObject({
    "working-directory": "apps/os",
    run: "doppler run -- pnpm preview deploy-parents",
  });
  // and nothing else deploys a parent: Main OS e2e's preview does not wait for one
  const deploysAParent = depotWorkflowFiles.filter((file) =>
    Object.values(loadWorkflow(file).jobs).some((job) =>
      (job.steps || []).some((step) =>
        /pnpm (run-script deploy --env preview|preview deploy-parents)/.test(step.run || ""),
      ),
    ),
  );
  expect(deploysAParent).toEqual([".depot/workflows/preview-parents.yml"]);
});

// A job of Preview OS that ran only on `closed` was a skipped check on every push to an open PR.
test("a closed PR's preview is deleted by its own workflow, in that PR's preview group", () => {
  const preview = loadWorkflow(".depot/workflows/preview-os.yml");
  const workflow = loadWorkflow(".depot/workflows/preview-delete.yml");

  expect(preview.on?.pull_request?.types).not.toContain("closed");
  expect(Object.keys(workflow.on || {}).sort()).toEqual(["pull_request", "workflow_dispatch"]);
  expect(workflow).toMatchObject({
    // every PR that got a preview, and no other
    on: { pull_request: { types: ["closed"], paths: previewPaths } },
    // a delete waits for the PR's in-flight deploy and e2e instead of racing them, and is never
    // cut short
    concurrency: { group: preview.concurrency?.group, "cancel-in-progress": false },
  });
});

// Each CI workflow of main that deploys a preview keeps one of its own, never brand-new
// (apps/os/scripts/preview-sweep.ts CI_WORKFLOW_PREVIEWS; docs/depot-ci.md#main-os-e2e-keeps-one-preview):
// it redeploys it in place one run at a time, with no hold (the gate waits until the preview runs the
// deployment), and never deletes it.
test("each CI workflow that deploys a preview redeploys its own in place, one run at a time, and never deletes it", () => {
  const ownPreviews = depotWorkflowFiles.flatMap((file) => {
    const workflow = loadWorkflow(file);
    const preview = workflow.env?.PREVIEW_NAME;
    return preview ? [{ file, preview, workflow }] : [];
  });
  expect(Object.fromEntries(ownPreviews.map(({ file, preview }) => [preview, file]))).toEqual({
    main: ".depot/workflows/main-os-e2e.yml",
    latency: ".depot/workflows/os-latency.yml",
    "real-model": ".depot/workflows/os-real-model.yml",
  });
  expect(ownPreviews.map(({ preview }) => preview).toSorted()).toEqual(
    [...CI_WORKFLOW_PREVIEWS].toSorted(),
  );
  for (const { file, workflow } of ownPreviews) {
    expect(workflow.concurrency, file).toMatchObject({ "cancel-in-progress": false });
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps || []);
    const runs = steps.map((step) => step.run || "");
    expect(runs, file).toContainEqual("doppler run -- pnpm preview deploy");
    expect(runs, file).not.toContainEqual(expect.stringMatching(/pnpm preview (delete|reset)$/));
    expect(
      steps.filter((step) => step.env?.PREVIEW_NAME || step.run?.includes("PREVIEW_NAME=")),
      file,
    ).toEqual([]);
    // no PR number anywhere: nothing is written to a pull request
    expect(JSON.stringify(workflow), file).not.toContain("PREVIEW_PR_NUMBER");
  }
});

test("Main OS e2e runs on every main push a PR preview would run for", () => {
  const main = loadWorkflow(".depot/workflows/main-os-e2e.yml");

  expect(main.on?.push?.branches).toEqual(["main"]);
  expect(main.on?.push?.paths).toEqual(
    expect.arrayContaining(previewPaths.filter((path) => !path.includes("preview-os.yml"))),
  );
});

// The checks a main push shows are the ones a PR's preview shows, and main is traced as a PR preview
// is (docs/ci-traces.md). Only the trace's checkout and traced commit differ: main's pushed commit; a
// PR's tested merge commit, with the statuses on its head.
test("Main OS e2e names its checks as Preview OS does and traces them the same way", () => {
  const main = loadWorkflow(".depot/workflows/main-os-e2e.yml");
  const preview = loadWorkflow(".depot/workflows/preview-os.yml");
  const trace = (workflow: Workflow) => ({
    env: { BASH_ENV: workflow.env?.BASH_ENV, CI_TRACE_ENABLED: workflow.env?.CI_TRACE_ENABLED },
    steps: (workflow.jobs.trace?.steps || []).filter(
      (step) => step.uses !== "actions/checkout@v4" && step.name !== "Record the traced commit",
    ),
  });

  for (const job of ["deploy", "e2e", "specs", "trace"])
    expect(main.jobs[job]?.name, job).toBe(preview.jobs[job]?.name);
  expect(trace(main)).toEqual(trace(preview));
  // it only reports: nothing that follows the suites waits for it
  expect(Object.values(main.jobs).filter((job) => [job.needs].flat().includes("trace"))).toEqual(
    [],
  );
});

// ONE DEFINITION in each workflow, and the same one in both: Browser specs is E2E tests' runner,
// outputs and steps (YAML aliases), the two differing only in the suite their env names. Main's
// steps are a PR preview's less its guard and its PR's checkouts, plus the failing rows the alert
// names; every step they share runs the same command and uploads the same files.
test("Main OS e2e's two suite jobs are one definition, a PR preview's suite steps on its runner", () => {
  const source = readFileSync(resolve(repoRoot, ".depot/workflows/main-os-e2e.yml"), "utf8");
  const main = loadWorkflow(".depot/workflows/main-os-e2e.yml");
  const preview = loadWorkflow(".depot/workflows/preview-os.yml");
  const [e2e, specs] = [main.jobs.e2e!, main.jobs.specs!];
  expect(specs).toMatchObject({
    steps: e2e.steps,
    outputs: e2e.outputs,
    "runs-on": e2e["runs-on"],
    "timeout-minutes": e2e["timeout-minutes"],
  });
  expect(source.match(/^ {4}steps: \*suite-steps$/gmu)).toHaveLength(1);
  expect(e2e).toMatchObject({
    "runs-on": preview.jobs.e2e?.["runs-on"],
    "timeout-minutes": preview.jobs.e2e?.["timeout-minutes"],
  });
  // each suite as a PR preview names it; E2E tests runs every row and judges the slow ones, which
  // the alert pages under their own name, and Browser specs judges none
  for (const job of ["e2e", "specs"])
    for (const name of ["SUITE", "FLAKE_SUITE", "TEST_TELEMETRY_EXPECTED_WORKSPACES"])
      expect(main.jobs[job]?.env?.[name], `${job} ${name}`).toBe(preview.jobs[job]?.env?.[name]);
  expect(e2e.env).toMatchObject({
    E2E_SLOW_ROWS: "run",
    JUDGED_SUITE: "slow e2e rows",
    JUDGED_TAG: "slow",
  });
  expect(Object.keys(specs.env || {})).not.toContain("JUDGED_SUITE");

  const mainSteps = e2e.steps || [];
  const previewSteps = preview.jobs.e2e?.steps || [];
  const prOnly = [
    "Require a deployed preview",
    "Record the PR head for test telemetry",
    "Check out the PR merged into main",
  ];
  const expected = previewSteps
    .map((step) => step.name!)
    .filter((name) => !prOnly.includes(name))
    .map((name) => (name === "Checkout the tested commit" ? "Checkout main" : name));
  expected.splice(
    expected.indexOf("Run the suite against the preview") + 1,
    0,
    "Collect the failing rows",
  );
  expect(mainSteps.map((step) => step.name)).toEqual(expected);
  for (const step of mainSteps) {
    const twin = previewSteps.find((candidate) => candidate.name === step.name);
    if (twin?.run) expect(step, step.name).toMatchObject({ run: twin.run });
    // the same uploads, their artifacts named for main instead of a preview
    if (twin?.uses)
      expect({
        ...step.with,
        name: String(step.with?.name).replace(/^main-/u, "preview-"),
      }).toEqual(twin.with);
  }
});

// A scheduled run reports on main's head commit, and a push or PR run of a workflow whose job
// only runs on its schedule carries that job as a skipped check. Four workflows run the same jobs
// on every trigger: the two image bakes (a push to main bakes as the schedule does, the preview
// image's once a check finds its stamp stale), Kit Firmware, whose daily run re-plans every board
// so a failed publish is repaired without a firmware push, and the real-model suite, which runs a
// main push to the agents runtime as it runs main daily.
test.for(
  depotWorkflowFiles.filter(
    (file) =>
      loadWorkflow(file).on?.schedule &&
      ![
        ".depot/workflows/build-preview-ci-image.yml",
        ".depot/workflows/build-esp-idf-image.yml",
        ".depot/workflows/kit-firmware.yml",
        ".depot/workflows/os-real-model.yml",
      ].includes(file),
  ),
)("%s runs only on its schedule or on request", (file) => {
  expect(
    Object.keys(loadWorkflow(file).on || {}).filter(
      (event) => !["schedule", "workflow_dispatch"].includes(event),
    ),
  ).toEqual([]);
});

test("runs every workspace test script, then Kit's firmware host tests", () => {
  const steps = loadWorkflow(".depot/workflows/test.yml").jobs.test.steps ?? [];
  const runTests = steps.findIndex((step) => step.name === "Run Tests");
  const firmwareHostTests = steps.findIndex(
    (step) => !!step.run?.includes("pnpm --dir apps/kit firmware:test:host"),
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

  expect(steps?.find((step) => step.name === "Run Lint")?.run).toBe("pnpm lint");
});

test("the preview's e2e suite writes the canonical telemetry artifact", () => {
  // The preview runs `e2e:run` alone (it must not rebuild the deployed dist/); the reporters are a
  // root option of apps/os's vitest config, so every project's run writes it.
  expect(readVitestConfig("apps/os")).toMatch(/^ {4}reporters: vitestReporters,$/m);
});

test("every unit-test workspace writes the canonical telemetry artifact", () => {
  const expectedWorkspaces = workspaceDirectories.flatMap((directory) => {
    const packageJson = readPackageJson(directory);
    const testCommand = [packageJson.scripts?.test, packageJson.scripts?.["test:unit"]]
      .filter(Boolean)
      .join(" ");
    if (!testCommand) return [];
    expect(
      readVitestConfig(directory),
      `${directory}/vitest.config.ts must install the canonical test telemetry reporter`,
    ).toMatch(/reporters: vitestReporters/);
    return [packageJson.name];
  });

  // The finalizer reads the list from the checkout, by the same rule this test applies.
  const finalizer = loadWorkflow(".depot/workflows/test.yml").jobs.test?.steps?.find((step) =>
    step.run?.includes("scripts/ci/upload-test-telemetry.ts"),
  );
  expect(finalizer?.run).toContain("--expect-unit-workspaces");
  expect(finalizer?.env?.TEST_TELEMETRY_EXPECTED_WORKSPACES).toBeUndefined();
  expect(unitTestWorkspaces(repoRoot).sort()).toEqual(expectedWorkspaces.sort());
});

test.each([
  { file: ".depot/workflows/test.yml", jobId: "test", suite: "unit" },
  { file: ".depot/workflows/preview-os.yml", jobId: "e2e", suite: "preview-e2e" },
  { file: ".depot/workflows/preview-os.yml", jobId: "specs", suite: "specs" },
  { file: ".depot/workflows/main-os-e2e.yml", jobId: "e2e", suite: "preview-e2e" },
  { file: ".depot/workflows/main-os-e2e.yml", jobId: "specs", suite: "specs" },
])("$file $jobId always finalizes and retains $suite test telemetry", ({ file, jobId, suite }) => {
  const steps = stepsAsRun(file, jobId);
  const finalizer = steps.find((step) => step.run?.includes("scripts/ci/upload-test-telemetry.ts"));
  // Flake records have their own upload. Select the complete telemetry directory this
  // retention guard is about.
  const upload = steps.find(
    (step) =>
      step.uses === "actions/upload-artifact@v4" && step.with?.path === "test-results/ci-telemetry",
  );
  // whatever the suite's outcome; a preview test job's once its suite started, since a job whose
  // guard found no deployed preview has nothing to keep (preview-os-workflow.test.ts)
  const always = expect.stringMatching(
    /^always\(\)( && steps\.[a-z0-9-]+\.outcome != 'skipped')?$/u,
  );

  expect(finalizer, `${file} must normalize telemetry`).toMatchObject({ if: always });
  expect(finalizer?.run, `${file} must not send cancelled runs as test failures`).toContain(
    "cancelled() && '--cancelled'",
  );
  expect(finalizer?.run, `${file} must write its suite's summary`).toContain(
    `--flake-suites ${suite}`,
  );
  expect(upload, `${file} must retain the raw telemetry and its manifest`).toMatchObject({
    if: always,
    with: expect.objectContaining({
      path: expect.stringContaining("test-results"),
      "if-no-files-found": "error",
    }),
  });
  expect(steps.indexOf(finalizer!)).toBeLessThan(steps.indexOf(upload!));
  // The suite's records (and the summary the finalizer wrote beside them) leave the job after the
  // finalizer, whatever the suite's outcome.
  const records = steps.find(
    (step) => step.with?.name === `flake-records-${suite}${attemptSuffix}`,
  );
  expect(records, `${file} must upload flake-records-${suite}`).toMatchObject({
    if: always,
    uses: "actions/upload-artifact@v4",
  });
  expect(steps.indexOf(finalizer!)).toBeLessThan(steps.indexOf(records!));
});

test.each([
  { file: ".depot/workflows/test.yml", jobId: "test" },
  { file: ".depot/workflows/preview-os.yml", jobId: "e2e" },
  { file: ".depot/workflows/preview-os.yml", jobId: "specs" },
  { file: ".depot/workflows/main-os-e2e.yml", jobId: "e2e" },
  { file: ".depot/workflows/main-os-e2e.yml", jobId: "specs" },
])(
  "the $jobId job of $file names its evidence per job attempt and never overwrites it",
  ({ file, jobId }) => {
    const steps = stepsAsRun(file, jobId);
    // Overwritten on purpose: the latest attempt's HTML report, which a link can name. Each
    // attempt's own copy is inside its test-results artifact.
    const evidence = steps.filter(
      (step) =>
        step.uses === "actions/upload-artifact@v4" &&
        step.with?.name !== "public-playwright-report",
    );

    expect(steps[0], `${file} must name the attempt before anything can fail`).toMatchObject({
      id: "attempt",
    });
    expect(evidence.length).toBeGreaterThan(0);
    for (const step of evidence) {
      expect(String(step.with?.name), `${file}: ${step.name}`).toMatch(
        /^[a-z0-9-]+-attempt-\$\{\{ steps\.attempt\.outputs\.id \}\}$/u,
      );
      expect(step.with?.overwrite, `${file}: ${step.name}`).toBeUndefined();
    }
  },
);

// docs/test-evidence.md: each test job attempt's test-results/ folder, its manifest and its upload
// to R2.
test.each([
  { file: ".depot/workflows/test.yml", jobId: "test", testSteps: ["tests", "kit-host-tests"] },
  // the suite jobs' one step, `suite`, recorded under the suite its job names
  { file: ".depot/workflows/preview-os.yml", jobId: "e2e", testSteps: ["suite"], as: ["e2e"] },
  { file: ".depot/workflows/preview-os.yml", jobId: "specs", testSteps: ["suite"], as: ["specs"] },
  { file: ".depot/workflows/main-os-e2e.yml", jobId: "e2e", testSteps: ["suite"], as: ["e2e"] },
  { file: ".depot/workflows/main-os-e2e.yml", jobId: "specs", testSteps: ["suite"], as: ["specs"] },
])(
  "the $jobId job of $file writes its test evidence manifest after the finalizer, and puts the folder in R2, deciding nothing and never failing unseen",
  ({ file, jobId, testSteps, as }) => {
    const workflow = loadWorkflow(file);
    const job = workflow.jobs[jobId]!;
    const steps = stepsAsRun(file, jobId);
    const index = (command: string) => steps.findIndex((step) => !!step.run?.includes(command));
    const write = steps[index("scripts/ci/test-evidence.ts write")];
    const upload = steps[index("scripts/ci/test-evidence.ts upload")];
    const report = steps[index("scripts/ci/test-evidence-unreported.sh")];

    // always, a cancelled job's folder saying so; bounded, so a hang cannot reach the job's timeout.
    // A preview test job's once its suite started: one whose guard found no preview has no folder.
    expect(write).toMatchObject({
      id: "evidence-write",
      if: expect.stringMatching(/^always\(\)( && steps\.[a-z0-9-]+\.outcome != 'skipped')?$/u),
      "continue-on-error": true,
      "timeout-minutes": expect.any(Number),
      run: expect.stringContaining("cancelled() && '--cancelled'"),
    });
    // the outcome of every step that runs tests, each one before the write, so a failure the
    // telemetry does not see (Kit's CTest, a runner that never started) is not a pass
    expect(write?.env?.TEST_EVIDENCE_STEPS).toBe(
      testSteps.map((id, i) => `${as?.[i] ?? id}=\${{ steps.${id}.outcome }}`).join(" "),
    );
    for (const id of testSteps) {
      const step = steps.findIndex((candidate) => candidate.id === id);
      expect(step, id).toBeGreaterThan(-1);
      expect(step).toBeLessThan(steps.indexOf(write!));
    }
    // a cancelled or timed-out job's folder too, bounded the same way
    expect(upload).toMatchObject({
      id: "evidence-upload",
      if: expect.stringContaining("always()"),
      "continue-on-error": true,
      "timeout-minutes": expect.any(Number),
    });
    // a step that failed before it could say why is reported by the next one, whatever happened
    expect(report?.if).toContain("always()");
    // after every runner and the finalizer; then the R2 upload beside every artifact that keeps
    // the folder, each only reading it (docs/depot-ci.md#parallel-steps); then the report
    expect(index("scripts/ci/upload-test-telemetry.ts")).toBeLessThan(steps.indexOf(write!));
    const artifacts = steps.filter((step) => step.uses === "actions/upload-artifact@v4");
    const block = readWorkflow(file).jobs[jobId]?.steps?.find((step) => step.parallel);
    expect(block?.["fail-fast"]).toBe(false);
    expect(block?.parallel?.map((step) => step.name)).toEqual(
      [upload, ...artifacts].map((step) => step?.name),
    );
    expect(steps.indexOf(write!)).toBeLessThan(steps.indexOf(upload!));
    expect(steps.indexOf(report!)).toBe(steps.indexOf(artifacts.at(-1)!) + 1);
    // the runners write into the folder
    const telemetryDirectories = [
      job.env?.TEST_TELEMETRY_ARTIFACT_DIR,
      ...steps.map((step) => step.env?.TEST_TELEMETRY_ARTIFACT_DIR),
    ].filter(Boolean);
    expect(telemetryDirectories).toEqual([testEvidencePaths.telemetry]);
  },
);

test("the Test job's manifest names the pull request, branch and head its runners do", () => {
  const steps = loadWorkflow(".depot/workflows/test.yml").jobs.test?.steps ?? [];
  const runTests = steps.find((step) => step.name === "Run Tests");
  const write = steps.find((step) => step.id === "evidence-write");
  const source = [
    "TEST_TELEMETRY_BRANCH",
    "TEST_TELEMETRY_HEAD_SHA",
    "TEST_TELEMETRY_PULL_REQUEST_NUMBER",
  ];
  for (const name of source) {
    expect(write?.env?.[name], name).toBeTruthy();
    expect(write?.env?.[name], name).toBe(runTests?.env?.[name]);
  }
});

test("the CI telemetry sync's test evidence jobs are the jobs that upload a folder", () => {
  const uploading = depotWorkflowFiles.flatMap((file) =>
    Object.entries(loadWorkflow(file).jobs).flatMap(([jobId, job]) =>
      (job.steps || []).some((step) => step.run?.includes("scripts/ci/test-evidence.ts upload"))
        ? [`${file.slice(".depot/workflows/".length)}:${jobId}`]
        : [],
    ),
  );
  expect(uploading.toSorted()).toEqual(testEvidenceJobs.toSorted());
});

test("the fallback report names a failed evidence step that did not report itself, once, and never fails", () => {
  using runner = temporaryDirectory();
  const summary = join(runner.path, "summary.md");
  const report = (write: string, upload: string) => {
    writeFileSync(summary, "");
    const result = spawnSync(
      "bash",
      [resolve(repoRoot, "scripts/ci/test-evidence-unreported.sh"), write, upload],
      {
        env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: runner.path },
        encoding: "utf8",
      },
    );
    return { status: result.status, stdout: result.stdout, summary: readFileSync(summary, "utf8") };
  };
  // Doppler refused: the upload never reached the script
  const unreported = report("success", "failure");
  expect(unreported).toEqual({
    status: 0,
    stdout: `::warning title=${stepFailureTitles.upload}::the upload step failed before it could say why (Doppler, pnpm or the step's timeout); its log has the rest\n`,
    summary: `**${stepFailureTitles.upload}**: the upload step failed before it could say why (Doppler, pnpm or the step's timeout); its log has the rest. The tests' result is unaffected.\n`,
  });
  const write = report("failure", "skipped");
  expect(write.stdout).toContain(`::warning title=${stepFailureTitles.write}::the write step`);

  // the script reported the upload itself (reportStepFailure's marker): nothing more to say
  writeFileSync(join(runner.path, "test-evidence-upload.reported"), "R2 PUT …: 500\n");
  expect(report("success", "failure")).toEqual({ status: 0, stdout: "", summary: "" });
});

test("Kit's host tests write CTest's JUnit XML into the test evidence folder", () => {
  const kit = loadWorkflow(".depot/workflows/test.yml").jobs.test.steps?.find(
    (step) => step.id === "kit-host-tests",
  );
  expect(kit?.run).toContain(
    `pnpm --dir apps/kit firmware:test:host --output-junit "$PWD/${testEvidencePaths.ctestJunit}"`,
  );
  expect(kit?.run).toContain(`mkdir -p ${dirname(testEvidencePaths.ctestJunit)}`);
});

test("the test jobs' flake records go into the test evidence folder", () => {
  const runTests = loadWorkflow(".depot/workflows/test.yml").jobs.test?.steps?.find(
    (step) => step.name === "Run Tests",
  );
  expect(runTests?.env?.FLAKE_RECORD_DIR).toBe(testEvidencePaths.flakeRecords);
  for (const path of Object.values(testEvidencePaths).filter((path) => path !== "test-results")) {
    expect(path.startsWith(`${testEvidencePaths.root}/`), path).toBe(true);
  }
});

test("the attempt step reads the job attempt's id from DEPOT_JOB_URL, and fails without one", () => {
  const run = loadWorkflow(".depot/workflows/test.yml").jobs.test?.steps?.[0]?.run ?? "";
  using directory = temporaryDirectory();
  const attempt = (jobUrl: string) => {
    const output = join(directory.path, "output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-e", "-c", run], {
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, DEPOT_JOB_URL: jobUrl },
      encoding: "utf8",
    });
    return { status: result.status, output: readFileSync(output, "utf8") };
  };
  expect(
    attempt(
      "https://depot.dev/orgs/0p91s0lz49/workflows/x37szwmr3k?job=xv1qfjsdbq&attempt=7wxvtkb2rg",
    ),
  ).toEqual({ status: 0, output: "id=7wxvtkb2rg\n" });
  expect(attempt("")).toEqual({ status: 1, output: "" });
  expect(attempt("https://depot.dev/orgs/0p91s0lz49/workflows/x37szwmr3k")).toEqual({
    status: 1,
    output: "",
  });
});

test.for([
  {
    file: ".depot/workflows/preview-os.yml",
    results: `preview-os-test-artifacts${attemptSuffix}`,
  },
  { file: ".depot/workflows/main-os-e2e.yml", results: `main-os-test-artifacts${attemptSuffix}` },
])(
  "$file's Browser specs job keeps the browser evidence, whatever the suite's outcome",
  ({ file, results: name }) => {
    const steps = stepsAsRun(file, "specs");
    const suite = steps.find((step) => step.run?.includes("pnpm preview specs"));
    const results = steps.find((step) => step.with?.name === name);
    const report = steps.find((step) => step.with?.name === "public-playwright-report");

    // the root config writes per-test output and the HTML report into the test evidence folder
    expect(results).toMatchObject({
      if: expect.stringMatching(/^always\(\)/u),
      uses: "actions/upload-artifact@v4",
      with: expect.objectContaining({ path: testEvidencePaths.root }),
    });
    expect(report).toMatchObject({
      if: expect.stringContaining("always()"),
      uses: "actions/upload-artifact@v4",
      with: expect.objectContaining({ path: testEvidencePaths.playwrightReport }),
    });
    expect(steps.indexOf(suite!)).toBeLessThan(steps.indexOf(results!));
    expect(steps.indexOf(suite!)).toBeLessThan(steps.indexOf(report!));
  },
);

// docs/depot-ci.md#which-tree-a-pull-requests-ci-tests: Depot reads a PR run's workflow files from
// its merge commit, so the required checks test that commit, not the head it merges.
test.for([
  { file: ".depot/workflows/test.yml", jobIds: ["test"] },
  { file: ".depot/workflows/lint-typecheck.yml", jobIds: ["lint-typecheck"] },
  { file: ".depot/workflows/loc-report.yml", jobIds: ["loc-report"] },
  { file: ".depot/workflows/pr-dashboard.yml", jobIds: ["update_dashboard"] },
  { file: ".depot/workflows/kit-firmware.yml", jobIds: ["plan-firmware", "build-firmware"] },
])(
  "$file checks out the run's own commit, the tree its workflow file was read from",
  ({ file, jobIds }) => {
    const { jobs } = loadWorkflow(file);
    const checkouts = jobIds.flatMap((jobId) =>
      (jobs[jobId]?.steps || []).filter((step) => step.uses?.startsWith("actions/checkout")),
    );
    expect(checkouts.map((step) => step.with?.ref)).toEqual(jobIds.map(() => "${{ github.sha }}"));
  },
);

// A close runs from the merged PR's squash commit on main, or from an unmerged PR's head; a
// dispatch from main has neither, so it takes the PR's head.
test("Preview delete checks out the close's own commit", () => {
  const checkout = loadWorkflow(".depot/workflows/preview-delete.yml").jobs.delete?.steps?.find(
    (step) => step.uses?.startsWith("actions/checkout"),
  );

  expect(checkout?.with?.ref).toBe(
    "${{ github.event_name == 'pull_request' && github.sha || format('refs/pull/{0}/head', inputs.pull-request-number) }}",
  );
});

test("labels unit artifacts with the pull-request head, whose merge commit the job tests", () => {
  const runTests = loadWorkflow(".depot/workflows/test.yml").jobs.test.steps?.find(
    (step) => step.name === "Run Tests",
  );

  expect(runTests?.env).toMatchObject({
    TEST_TELEMETRY_BRANCH: "${{ github.head_ref || github.ref_name }}",
    TEST_TELEMETRY_HEAD_SHA: "${{ github.event.pull_request.head.sha || github.sha }}",
    TEST_TELEMETRY_PULL_REQUEST_NUMBER: "${{ github.event.pull_request.number }}",
  });
});

/** A workflow as its jobs run it: each `parallel:` block's steps stand where the block does. */
function loadWorkflow(file: string): Workflow {
  const workflow = readWorkflow(file);
  for (const job of Object.values(workflow.jobs))
    job.steps = job.steps?.flatMap((step) => step.parallel || [step]);
  return workflow;
}

/**
 * A job's steps as it runs them: flattened as loadWorkflow does, and each `${{ env.NAME }}` and
 * `"$NAME"` of the job's own env replaced by its value. The two suite jobs of Preview OS and Main OS
 * e2e run one step list, and the suite each runs is its env's.
 */
function stepsAsRun(file: string, jobId: string): WorkflowStep[] {
  const job = loadWorkflow(file).jobs[jobId];
  const env = job?.env || {};
  const expand = (value: unknown): unknown => {
    if (typeof value === "string")
      return value.replace(
        /\$\{\{ env\.([A-Z0-9_]+) \}\}|"\$([A-Z0-9_]+)"/gu,
        (match, expression?: string, shell?: string) => env[expression || shell || ""] || match,
      );
    if (Array.isArray(value)) return value.map(expand);
    if (value instanceof Object)
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry)]));
    return value;
  };
  return (job?.steps || []).map((step) => expand(step) as WorkflowStep);
}

function readWorkflow(file: string): Workflow {
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

function readVitestConfig(directory: string) {
  return readFileSync(resolve(repoRoot, directory, "vitest.config.ts"), "utf8");
}

function readPackageJson(directory: string) {
  return JSON.parse(readFileSync(resolve(repoRoot, directory, "package.json"), "utf8")) as {
    name: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}
