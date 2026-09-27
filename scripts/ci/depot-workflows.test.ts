import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, matchesGlob, relative, resolve } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { temporaryDirectory } from "@iterate-com/shared/test-support/temporary-directory";
import { testEvidencePaths } from "@iterate-com/shared/test-support/test-evidence";
import { CI_WORKFLOW_PREVIEWS } from "../../apps/os/scripts/preview-sweep.ts";
import { mainE2eRecords, realModelTelemetry } from "../monitors/e2e.ts";
import { stateArtifacts as healthStates } from "../monitors/health.ts";
import { latencyReport } from "../monitors/latency.ts";
import { CHECKS } from "../monitors/ttg.ts";
import { stepFailureTitles, testEvidenceJobs } from "./test-evidence.ts";
import { stateArtifact as prdFaultAlarmState } from "./prd-fault-alarm.ts";
import { previewPaths } from "./preview-paths.ts";
import { unitTestWorkspaces } from "./test-telemetry-completeness.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
/** What a test job's evidence artifacts end with: the job attempt's id (docs/depot-ci.md#artifacts-per-job-attempt). */
const attemptSuffix = "-attempt-${{ steps.attempt.outputs.id }}";
/** When the preview and main suite jobs keep their evidence: once their suite read the deployed
 *  target (apps/os/scripts/preview.ts `writeDeployedTarget`), whatever its outcome. */
const afterTheDeployedTarget = `\${{ always() && hashFiles('${testEvidencePaths.target}') != '' }}`;

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
  if?: string;
  outputs?: Record<string, string>;
  name?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  /** A Depot stock image's label (`depot-ubuntu-24.04-8`); anything else fails a test. */
  "runs-on": string | Record<string, unknown>;
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
    ".depot/actions/setup/action.yml",
    "scripts/ci/toolchain.sh",
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
    file: ".depot/workflows/health.yml",
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

// A leg that installs ESP-IDF itself makes a GitHub clone and a PyPI install, any of whose
// downloads can fail a board with no firmware change. So Depot Cache holds it, keyed by its pin
// (scripts/ci/esp-idf.sh), and a main leg saves it, as installed, for a pin that has none yet.
test("Kit Firmware legs take ESP-IDF from Depot Cache, keyed by its pin", () => {
  const workflow = loadWorkflow(".depot/workflows/kit-firmware.yml");
  const leg = workflow.jobs["build-firmware"]!;
  const steps = leg.steps || [];
  const index = (name: string) => steps.findIndex((step) => step.name === name);
  const paths = "/home/runner/esp-idf\n/home/runner/.espressif\n";

  expect(leg["runs-on"]).toBe("depot-ubuntu-24.04-4");
  // the pin's hash and python3's version (scripts/ci/esp-idf.test.ts)
  expect(steps[index("ESP-IDF's key")]).toMatchObject({
    id: "esp-idf-key",
    run: 'scripts/ci/esp-idf.sh key >>"$GITHUB_OUTPUT"',
  });
  expect(steps[index("Restore ESP-IDF")]).toMatchObject({
    id: "esp-idf",
    uses: "actions/cache/restore@v4",
    with: { path: paths, key: "${{ steps.esp-idf-key.outputs.key }}" },
  });
  // an older pin's ESP-IDF is of no use to this one
  expect(steps[index("Restore ESP-IDF")]?.with?.["restore-keys"]).toBeUndefined();
  expect(steps[index("ESP-IDF")]).toMatchObject({
    id: "ensure",
    run: "scripts/ci/esp-idf.sh ensure",
  });
  expect(steps[index("Save ESP-IDF")]).toMatchObject({
    if: "${{ github.ref == 'refs/heads/main' && steps.ensure.outcome == 'success' && steps.esp-idf.outputs.cache-hit != 'true' }}",
    uses: "actions/cache/save@v4",
    with: { path: paths },
  });
  expect(index("ESP-IDF's key")).toBe(index("Restore ESP-IDF") - 1);
  expect(index("Restore ESP-IDF")).toBeLessThan(index("ESP-IDF"));
  expect(index("Save ESP-IDF")).toBe(index("ESP-IDF") + 1);
  expect(index("Save ESP-IDF")).toBeLessThan(index("Build"));
  expect(
    steps.map((step) => step.run || "").filter((run) => /git clone|install\.sh/.test(run)),
  ).toEqual([]);
  // the push's paths equal these (the publish test above)
  expect(workflow.on?.pull_request?.paths).toEqual(
    expect.arrayContaining(["scripts/ci/esp-idf.sh", "scripts/ci/toolchain.sh"]),
  );
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

// Each job that pages on a change of state hands its state to its next run as an artifact of its
// own workflow (scripts/ci/depot.ts newestArtifactFile): the workflow the script names uploads the
// file it wrote, whatever the run's outcome, and the script reads back what its previous-state step
// saved: its own state as --state, another job's (`--of <job>`) as --<job>-state. The scripts decide
// which runs write one: only a real run on main (their `--ref`).
const guards = [
  { script: "scripts/monitors/health.ts", state: healthStates.health, of: undefined },
  { script: "scripts/monitors/health.ts", state: healthStates["main-e2e"], of: "main-e2e" },
  { script: "scripts/ci/prd-fault-alarm.ts", state: prdFaultAlarmState, of: undefined },
];
test.each(guards)("$script keeps $state.artifact for its next run", ({ script, state, of }) => {
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
  const saved = steps.flatMap((step) => [
    ...(step.run || "").matchAll(/previous-state (?:--of (\S+) )?--out (\S+)/gu),
  ]);

  expect(keep).toMatchObject({
    if: expect.stringMatching(/^always\(\)/u),
    uses: "actions/upload-artifact@v4",
  });
  expect(path.endsWith(`/${state.file}`), path).toBe(true);
  expect(writer, `${script} writes --state-out ${path}`).toBeDefined();
  expect(steps.indexOf(writer!)).toBeLessThan(steps.indexOf(keep!));
  expect(saved.length).toBeGreaterThan(0);
  for (const [, savedOf, out] of saved)
    expect(writer?.run).toContain(`${savedOf === of ? "--state" : `--${savedOf}-state`} ${out}`);
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

test("the PR time-to-green check's checks are workflows by their names", () => {
  const names = depotWorkflowFiles.map((file) => loadWorkflow(file).name);
  for (const check of CHECKS) expect(names, check).toContain(check);
});

// The health job reads what other workflows keep (scripts/monitors): each is a workflow by its name
// that uploads the artifact the check reads, whatever its tests' outcome, and the file in it.
test.for([
  { ...latencyReport, path: `apps/os/output/${latencyReport.file}` },
  { ...realModelTelemetry, path: "test-results/ci-telemetry" },
])("the health job reads $workflow's $artifact", ({ workflow, artifact, path }) => {
  const [measured] = depotWorkflowFiles
    .map((file) => loadWorkflow(file))
    .filter((candidate) => candidate.name === workflow);
  const steps = Object.values(measured?.jobs ?? {}).flatMap((job) => job.steps || []);
  expect(steps.find((step) => step.with?.name === artifact)).toMatchObject({
    if: "always()",
    uses: "actions/upload-artifact@v4",
    with: { path },
  });
});

// The main e2e checks read the suite summary each Main OS e2e suite job's newest attempt keeps with
// its flake records, by the job's key and its attempt's id.
test.for(mainE2eRecords.jobs)(
  "the alert job reads $jobKey's $suite suite summary",
  ({ jobKey, suite }) => {
    const [file, jobId = ""] = jobKey.split(":");
    const path = `.depot/workflows/${file}`;
    expect(loadWorkflow(path)).toMatchObject({ name: mainE2eRecords.workflow });
    const records = stepsAsRun(path, jobId).find(
      (step) =>
        step.with?.name === mainE2eRecords.artifact(suite, "${{ steps.attempt.outputs.id }}"),
    );
    // whatever the suite's outcome, once it had a preview to test (preview-os-workflow.test.ts)
    expect(records).toMatchObject({
      if: afterTheDeployedTarget,
      uses: "actions/upload-artifact@v4",
      with: { path: `test-results/flake-records/${suite}` },
    });
    // the finalizer that writes this suite's summary into that folder (scripts/ci/flake-suite-summary.ts)
    const finalizer = stepsAsRun(path, jobId).find((step) =>
      step.run?.includes("scripts/ci/upload-test-telemetry.ts"),
    );
    expect(finalizer?.run).toContain(`--flake-suites ${suite}`);
  },
);

// ── Depot's stock image and Depot Cache (docs/depot-ci.md#setup-on-depots-stock-image) ──
const stockImage = /^depot-ubuntu-24\.04(-(4|8|16|32|64))?$/u;
const setupAction = "./.depot/actions/setup";
const setupActionFile = ".depot/actions/setup/action.yml";

/** Every job of every Depot workflow, its steps as they run (each `parallel:` block's in place). */
const depotJobs = depotWorkflowFiles.flatMap((file) => {
  const workflow = loadWorkflow(file);
  return Object.entries(workflow.jobs).map(([jobId, job]) => ({ file, jobId, workflow, job }));
});

test("every Depot job runs on Depot's stock image, and nothing builds an image", () => {
  const custom = depotJobs
    .filter(({ job }) => typeof job["runs-on"] !== "string" || !stockImage.test(job["runs-on"]))
    .map(({ file, jobId, job }) => `${file} ${jobId}: ${JSON.stringify(job["runs-on"])}`);
  expect(custom).toEqual([]);
  const snapshots = depotJobs.flatMap(({ file, jobId, job }) =>
    (job.steps || [])
      .filter((step) => step.uses?.startsWith("depot/snapshot-action"))
      .map(() => `${file} ${jobId}`),
  );
  expect(snapshots).toEqual([]);
});

// A step that runs pnpm or the Doppler CLI needs the setup before it; one that runs only Node needs
// the toolchain's Node (scripts/ci/toolchain.sh node, or start) or the setup: the stock image's own
// /usr/local/bin/node is Node 22, not .nvmrc's. Preview OS's two scripts that choose the tested
// commit run on it anyway, before the setup, since the PR head they start from may predate it; they
// use nothing but Node's builtins.
test("every job sets up the toolchain its steps run before they run it", () => {
  const uses = (tool: string) => new RegExp(`(^|[\\s;&|($])${tool}\\s`, "mu");
  const missing = depotJobs.flatMap(({ file, jobId, job }) => {
    let node = false;
    let full = false;
    return (job.steps || []).flatMap((step) => {
      const run = step.run || "";
      const problem =
        ((uses("pnpm").test(run) || uses("doppler").test(run)) && !full) ||
        (uses("node").test(run) &&
          !node &&
          !/^node scripts\/ci\/preview-(tested-commit|paths)\.ts( changes)?$/u.test(run));
      if (step.uses === setupAction) node = full = true;
      if (/^bash scripts\/ci\/toolchain\.sh (node|start)$/u.test(run)) node = true;
      return problem ? [`${file} ${jobId}: ${step.name || run}`] : [];
    });
  });
  expect(missing).toEqual([]);
});

// One setup for every job: a job that installed its own toolchain or dependencies beside it would
// skip the store, the pins or both.
test("no job installs a toolchain or the workspace but through the setup action", () => {
  const install =
    /pnpm install|setup-node|action-setup|cli\.doppler\.com|DopplerHQ|doppler setup|corepack|dependencies\.mjs/u;
  const own = depotJobs.flatMap(({ file, jobId, job }) =>
    (job.steps || [])
      .filter((step) => install.test(`${step.run} ${step.uses}`))
      .map((step) => `${file} ${jobId}: ${step.name}`),
  );
  expect(own).toEqual([]);
});

test("the setup action starts the toolchain, restores pnpm's store from Depot Cache while it downloads, then installs", () => {
  const action = readSetupAction();
  const steps = action.runs.steps;

  expect(action.runs).toMatchObject({ using: "composite" });
  // Depot never runs a `parallel:` block inside a composite action
  expect(steps.filter((step) => step.parallel)).toEqual([]);
  expect(steps.map((step) => step.name)).toEqual([
    "Start the toolchain",
    "Restore pnpm's store",
    "Install dependencies",
  ]);
  // pnpm reads its store from `npm_config_store_dir`, which the restore and Test's save name too,
  // and keeps no build outputs in it
  expect(steps[0]?.run).toBe(
    "printf 'NPM_CONFIG_STORE_DIR=/home/runner/.pnpm-store\\nNPM_CONFIG_SIDE_EFFECTS_CACHE=false\\n' >>\"$GITHUB_ENV\"\nbash scripts/ci/toolchain.sh start\n",
  );
  expect(steps[1]).toMatchObject({
    id: "pnpm-store",
    if: "inputs.pnpm-store == 'depot-cache'",
    uses: "actions/cache/restore@v4",
    "continue-on-error": true,
    "timeout-minutes": expect.any(Number),
    with: {
      path: "${{ env.NPM_CONFIG_STORE_DIR }}",
      key: "pnpm-store-${{ hashFiles('pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/**') }}",
      // off main only: main saves what it installed, not an older store and its additions
      "restore-keys": "${{ github.ref != 'refs/heads/main' && 'pnpm-store-' || '' }}",
    },
  });
  expect(steps[2]?.run).toBe(
    "bash scripts/ci/toolchain.sh wait\npnpm install --frozen-lockfile --prefer-offline\n",
  );
  expect(action.inputs?.["pnpm-store"]?.default).toBe("depot-cache");
  expect(action).toMatchObject({
    outputs: {
      "pnpm-store-outcome": expect.objectContaining({ value: "${{ steps.pnpm-store.outcome }}" }),
      "pnpm-store-hit": expect.objectContaining({
        value: "${{ steps.pnpm-store.outputs.cache-hit }}",
      }),
      "pnpm-store-primary-key": expect.objectContaining({
        value: "${{ steps.pnpm-store.outputs.cache-primary-key }}",
      }),
      "pnpm-store-matched-key": expect.objectContaining({
        value: "${{ steps.pnpm-store.outputs.cache-matched-key }}",
      }),
    },
  });
  // pnpm checks what it links from the store against the store's index
  expect(JSON.stringify(action)).not.toMatch(/verify[-_]store[-_]integrity/iu);
});

test("the toolchain is the checkout's own: .nvmrc's Node, packageManager's pnpm and one Doppler CLI release checked against its SHA-256", () => {
  const toolchain = readFileSync(resolve(repoRoot, "scripts/ci/toolchain.sh"), "utf8");

  expect(readFileSync(resolve(repoRoot, ".nvmrc"), "utf8").trim()).toMatch(/^\d+(\.\d+\.\d+)?$/u);
  expect(readPackageJson(".").packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/u);
  expect(toolchain).toMatch(/^DOPPLER_CLI_VERSION=\d+\.\d+\.\d+$/mu);
  expect(toolchain).toMatch(/^DOPPLER_CLI_SHA256=[0-9a-f]{64}$/mu);
  expect(toolchain).toContain(
    'echo "${DOPPLER_CLI_SHA256}  $tools/doppler.tar.gz" | sha256sum --check',
  );
  expect(toolchain).toContain("corepack install");
});

// DEPOT CACHE HAS NO BRANCH SCOPE: a run on any branch can write any key
// (docs/depot-ci.md#depot-cache). So only a main push writes it, main restores the exact key alone,
// and no job that ships to production or holds a token that can write the repository reads it.
test("only main writes Depot Cache, main restores exact keys, and no production deploy or repository writer reads it", () => {
  const setup = readSetupAction().runs.steps;
  const cacheSteps = depotJobs.flatMap(({ file, jobId, workflow, job }) =>
    (job.steps || []).flatMap((step) => {
      const readsStore = step.uses === setupAction && step.with?.["pnpm-store"] !== "none";
      const direct = step.uses?.startsWith("actions/cache");
      if (!readsStore && !direct) return [];
      const restore = readsStore
        ? setup.find((inner) => inner.uses === "actions/cache/restore@v4")!
        : step;
      return [
        { file, jobId, workflow, job, step: restore, name: `${file} ${jobId}: ${step.name}` },
      ];
    }),
  );
  const restores = cacheSteps.filter(({ step }) => step.uses === "actions/cache/restore@v4");
  const saves = cacheSteps.filter(({ step }) => step.uses === "actions/cache/save@v4");

  for (const { name, file, workflow, job, step } of restores) {
    expect(file, name).not.toMatch(/\/(deploy-.+|release)\.yml$/u);
    // an explicit read-only token: a workflow with no `permissions` gets the default one
    const permissions = job.permissions || workflow.permissions;
    expect(permissions, name).toMatchObject({ contents: "read" });
    expect(step["continue-on-error"], name).toBe(true);
    expect(step["timeout-minutes"], name).toEqual(expect.any(Number));
    const restoreKeys = step.with?.["restore-keys"];
    if (restoreKeys !== undefined)
      expect(restoreKeys, name).toMatch(
        /^\$\{\{ github\.ref != 'refs\/heads\/main' && '[a-z-]+-' \|\| '' \}\}$/u,
      );
  }
  expect(saves.map(({ name }) => name).toSorted()).toEqual([
    ".depot/workflows/kit-firmware.yml build-firmware: Save ESP-IDF",
    // one definition, which saves in the specs job alone (`env.SUITE == 'specs'`)
    ".depot/workflows/main-os-e2e.yml e2e: Save Playwright's browser",
    ".depot/workflows/main-os-e2e.yml specs: Save Playwright's browser",
    ".depot/workflows/test.yml test: Save pnpm's store",
  ]);
  for (const { name, job, step } of saves) {
    expect(step.if, name).toContain("github.ref == 'refs/heads/main'");
    expect(step["continue-on-error"], name).toBe(true);
    // the key its restore computed, so the next run finds it
    expect(step.with?.key, name).toMatch(/^\$\{\{ steps\.[a-z-]+\.outputs\.[a-z-]+-key \}\}$/u);
    const restore = (job.steps || []).find(
      (candidate) => candidate.id === /steps\.([a-z-]+)\./u.exec(String(step.with?.key))?.[1],
    );
    // the same path, which is part of the cache's version: another spelling misses
    expect(step.with?.path, name).toBe(
      restore?.uses === setupAction ? "${{ env.NPM_CONFIG_STORE_DIR }}" : restore?.with?.path,
    );
  }
});

// The production deploys and the release install from the npm registry, whose lockfile hashes vouch
// for every package, and never from a store any branch could have written.
test.for([...deploymentWorkflows.map(({ file }) => file), ".depot/workflows/release.yml"])(
  "%s installs from the npm registry alone",
  (file) => {
    const setups = Object.values(loadWorkflow(file).jobs).flatMap((job) =>
      (job.steps || []).filter((step) => step.uses === setupAction),
    );
    expect(setups.length).toBeGreaterThan(0);
    for (const step of setups) expect(step).toMatchObject({ with: { "pnpm-store": "none" } });
  },
);

// Test is the one job every main push runs, so it saves the store every job restores
// (.depot/actions/setup), and its summary says which store its install started from.
test("the Test job saves the setup's store from a main push that missed it, and reports it", () => {
  const workflow = loadWorkflow(".depot/workflows/test.yml");
  const steps = workflow.jobs.test.steps || [];
  const step = (name: string) => steps.find((candidate) => candidate.name === name);

  expect(workflow.jobs.test["runs-on"]).toBe("depot-ubuntu-24.04-8");
  expect(step("Setup")).toMatchObject({ id: "setup", uses: setupAction });
  expect(step("Setup")?.with).toBeUndefined();
  expect(step("Save pnpm's store")).toMatchObject({
    id: "pnpm-store-save",
    if: "${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.setup.outcome == 'success' && steps.setup.outputs.pnpm-store-hit != 'true' }}",
    uses: "actions/cache/save@v4",
    "continue-on-error": true,
    with: {
      path: "${{ env.NPM_CONFIG_STORE_DIR }}",
      key: "${{ steps.setup.outputs.pnpm-store-primary-key }}",
    },
  });
  // which store the install started from, and main's save, in the job's summary whatever
  // happened; the keys as environment variables, since off main the matched one is any a run wrote
  expect(steps.at(-1)).toMatchObject({
    name: "Report pnpm's store",
    if: "always()",
    env: {
      RESTORE_OUTCOME: "${{ steps.setup.outputs.pnpm-store-outcome }}",
      PRIMARY_KEY: "${{ steps.setup.outputs.pnpm-store-primary-key }}",
      MATCHED_KEY: "${{ steps.setup.outputs.pnpm-store-matched-key }}",
      SAVE_OUTCOME: "${{ steps.pnpm-store-save.outcome }}",
    },
    run: 'bash scripts/ci/pnpm-store-report.sh "$RESTORE_OUTCOME" "$PRIMARY_KEY" "$MATCHED_KEY" "$SAVE_OUTCOME"',
  });
});

// The specs' browser, Playwright's headless shell, beside the setup of both suites of Preview OS
// and Main OS e2e; main's specs save it for a lockfile that has none yet.
test.for([".depot/workflows/preview-os.yml", ".depot/workflows/main-os-e2e.yml"])(
  "%s's Browser specs restore Playwright's browser beside their setup",
  (file) => {
    const block = readWorkflow(file).jobs.e2e?.steps?.find((step) =>
      step.parallel?.some((inner) => inner.uses === setupAction),
    );
    expect(block).toMatchObject({
      "fail-fast": false,
      parallel: [
        { name: "Setup", uses: setupAction },
        {
          name: "Restore Playwright's browser",
          id: "playwright",
          // Preview OS's also skips for a PR that changes no preview path, as its setup does
          if: expect.stringMatching(
            /^(steps\.changes\.outputs\.preview != 'false' && )?env\.SUITE == 'specs'$/u,
          ),
          uses: "actions/cache/restore@v4",
          with: {
            path: "~/.cache/ms-playwright",
            key: "ms-playwright-${{ hashFiles('pnpm-lock.yaml') }}",
          },
        },
      ],
    });
  },
);

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
    run: "doppler run --project os --config preview -- pnpm preview reset-parent",
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
    run: "doppler run --project os --config preview -- pnpm preview deploy-parents",
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
    expect(runs, file).toContainEqual(
      "doppler run --project os --config preview -- pnpm preview deploy",
    );
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
// PR's tested merge commit, with the statuses on its head. Main has no PR body, so no suites' lines.
test("Main OS e2e names its checks as Preview OS does and traces them the same way", () => {
  const main = loadWorkflow(".depot/workflows/main-os-e2e.yml");
  const preview = loadWorkflow(".depot/workflows/preview-os.yml");
  const prOnly = ["Record the traced commit", "Write the suites' lines into the PR body"];
  const trace = (workflow: Workflow) => ({
    env: { BASH_ENV: workflow.env?.BASH_ENV, CI_TRACE_ENABLED: workflow.env?.CI_TRACE_ENABLED },
    steps: (workflow.jobs.trace?.steps || []).filter(
      (step) => step.uses !== "actions/checkout@v4" && !prOnly.includes(step.name!),
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

// Why the page is a job of the run it judges: .depot/workflows/main-os-e2e.yml (THE PAGE).
test("Main OS e2e pages from its own alert job once its deploy and both suites have ended, on a push only", () => {
  const main = loadWorkflow(".depot/workflows/main-os-e2e.yml");
  const alert = main.jobs.alert!;
  expect(alert).toMatchObject({
    needs: ["deploy", "e2e", "specs"],
    // a run cancelled by hand is left out, a timed-out job is red, and a dispatch pages nothing
    if: "${{ !cancelled() && github.event_name == 'push' }}",
  });
  const judge = alert.steps?.find((step) => step.run?.includes("health.ts main-e2e"));
  expect(judge?.run).toContain('--ref "${{ github.ref }}"');
  // the trace covers what it waits for, so it neither waits for the page nor times it
  expect(main.jobs.trace?.needs).not.toContain("alert");
});

// Why the two suite jobs share one definition: .depot/workflows/main-os-e2e.yml.
test("Main OS e2e's two suite jobs are one definition, a PR preview's suite steps on its runners", () => {
  const source = readFileSync(resolve(repoRoot, ".depot/workflows/main-os-e2e.yml"), "utf8");
  const main = loadWorkflow(".depot/workflows/main-os-e2e.yml");
  const preview = loadWorkflow(".depot/workflows/preview-os.yml");
  const [e2e, specs] = [main.jobs.e2e!, main.jobs.specs!];
  expect(specs).toMatchObject({
    steps: e2e.steps,
    "timeout-minutes": e2e["timeout-minutes"],
  });
  expect(source.match(/^ {4}steps: \*suite-steps$/gmu)).toHaveLength(1);
  // each on a PR preview's runner for its suite, so main's specs run as a PR's do
  for (const job of ["e2e", "specs"])
    expect(main.jobs[job], job).toMatchObject({
      "runs-on": preview.jobs[job]?.["runs-on"],
      "timeout-minutes": preview.jobs[job]?.["timeout-minutes"],
    });
  // each suite as a PR preview names it; E2E tests runs every row, the slow ones too, which the
  // alert job pages under their own name
  for (const job of ["e2e", "specs"])
    for (const name of ["SUITE", "FLAKE_SUITE", "TEST_TELEMETRY_EXPECTED_WORKSPACES"])
      expect(main.jobs[job]?.env?.[name], `${job} ${name}`).toBe(preview.jobs[job]?.env?.[name]);
  expect(e2e.env).toMatchObject({ E2E_SLOW_ROWS: "run" });
  // started with the run, each waits in its suite step for the deploy every main run makes
  for (const job of [e2e, specs]) expect(job.needs).toBeUndefined();
  expect(e2e.steps?.find((step) => step.id === "suite")?.env).toMatchObject({
    PREVIEW_AWAIT_DEPLOY_JOB: "deploy",
  });

  const mainSteps = e2e.steps || [];
  const previewSteps = preview.jobs.e2e?.steps || [];
  const prOnly = [
    "Require a preview to test",
    "Decide whether the PR changes a preview path",
    "Record the PR head for test telemetry",
    "Check out the PR merged into main",
  ];
  // main saves the specs' browser for the next runs, PRs' included (docs/depot-ci.md#depot-cache)
  const mainOnly = ["Save Playwright's browser"];
  const expected = previewSteps
    .map((step) => step.name!)
    .filter((name) => !prOnly.includes(name))
    .map((name) => (name === "Checkout the tested commit" ? "Checkout main" : name));
  expect(mainSteps.map((step) => step.name).filter((name) => !mainOnly.includes(name!))).toEqual(
    expected,
  );
  for (const step of mainSteps) {
    const twin = previewSteps.find((candidate) => candidate.name === step.name);
    if (twin?.run) expect(step, step.name).toMatchObject({ run: twin.run });
    // the same uploads, their artifacts named for main instead of a preview
    if (twin?.uses)
      expect(
        step.with?.name === undefined
          ? step.with
          : { ...step.with, name: String(step.with.name).replace(/^main-/u, "preview-") },
      ).toEqual(twin.with);
  }
});

// A scheduled run reports on main's head commit, and a push or PR run of a workflow whose job
// only runs on its schedule carries that job as a skipped check. Two workflows run the same jobs
// on every trigger: Kit Firmware, whose daily run re-plans every board so a failed publish is
// repaired without a firmware push, and the real-model suite, which runs a main push to the agents
// runtime as it runs main daily.
test.for(
  depotWorkflowFiles.filter(
    (file) =>
      loadWorkflow(file).on?.schedule &&
      ![".depot/workflows/kit-firmware.yml", ".depot/workflows/os-real-model.yml"].includes(file),
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
  expect(steps[runTests]?.run).toBe("doppler run --project test --config dev -- pnpm test");
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
  // Flake records have their own upload; the raw telemetry and its manifest travel in the whole
  // test evidence folder's.
  const upload = steps.find(
    (step) =>
      step.uses === "actions/upload-artifact@v4" && step.with?.path === testEvidencePaths.root,
  );
  // whatever the suite's outcome; a preview test job's once its suite read its deployed target,
  // since a job that never had a preview has nothing to keep (preview-os-workflow.test.ts)
  const always = expect.toSatisfy(
    (condition: string) => condition === "always()" || condition === afterTheDeployedTarget,
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
    with: expect.objectContaining({ "include-hidden-files": true, "if-no-files-found": "error" }),
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
    // A preview test job's once its suite read its deployed target: one that never had a preview
    // has no folder.
    expect(write).toMatchObject({
      id: "evidence-write",
      if: expect.toSatisfy(
        (condition: string) => condition === "always()" || condition === afterTheDeployedTarget,
      ),
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
    // and the saves to Depot Cache (Test's store, main's specs' browser), which read no evidence
    const uploads = [
      upload,
      ...artifacts,
      ...steps.filter((step) => step.uses === "actions/cache/save@v4"),
    ];
    const block = readWorkflow(file).jobs[jobId]?.steps?.find((step) =>
      step.parallel?.some((inner) => inner.id === "evidence-upload"),
    );
    expect(block?.["fail-fast"]).toBe(false);
    expect(block?.parallel?.map((step) => step.name)).toEqual(uploads.map((step) => step?.name));
    expect(steps.indexOf(write!)).toBeLessThan(steps.indexOf(upload!));
    expect(steps.indexOf(report!)).toBe(steps.indexOf(uploads.at(-1)!) + 1);
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

test("the Test job's summary says which pnpm store its install started from and what main saved, warns on a failed restore or save, and never fails", () => {
  using runner = temporaryDirectory();
  const summary = join(runner.path, "summary.md");
  const report = (restore: string, primary: string, matched: string, save: string) => {
    writeFileSync(summary, "");
    const result = spawnSync(
      "bash",
      [resolve(repoRoot, "scripts/ci/pnpm-store-report.sh"), restore, primary, matched, save],
      { env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary }, encoding: "utf8" },
    );
    return { status: result.status, stdout: result.stdout, summary: readFileSync(summary, "utf8") };
  };
  const key = "pnpm-store-0123";
  const miss =
    "**pnpm's store**: none restored (none saved yet, or the restore could not read Depot Cache: its log says which), and the install fetched every package from the npm registry.";

  // this lockfile's store
  expect(report("success", key, key, "skipped")).toEqual({
    status: 0,
    stdout: "",
    summary: "**pnpm's store**: restored this lockfile's, `pnpm-store-0123`.\n",
  });
  // off main, the newest saved
  expect(report("success", key, "pnpm-store-4567", "skipped")).toEqual({
    status: 0,
    stdout: "",
    summary:
      "**pnpm's store**: none saved for this lockfile (`pnpm-store-0123`), so it restored the newest, `pnpm-store-4567`, and the install fetched the rest.\n",
  });
  // nothing to restore, which is also how actions/cache reports a Depot Cache it could not read
  expect(report("success", key, "", "skipped")).toEqual({
    status: 0,
    stdout: "",
    summary: `${miss}\n`,
  });
  // a main push saving its store
  expect(report("success", key, "", "success")).toEqual({
    status: 0,
    stdout: "",
    summary: `${miss.slice(0, -1)}. Main saved this lockfile's store for the next runs (a store Depot Cache refused is a warning in the save's log).\n`,
  });
  // the restore's timeout
  expect(report("failure", key, "", "skipped")).toEqual({
    status: 0,
    stdout:
      "::warning title=pnpm's store not restored::the restore from Depot Cache failed (its timeout, or its log says why); the install fetched what it lacked from the npm registry\n",
    summary:
      "**pnpm's store**: the restore failed (its timeout, or its log says why), and the install fetched what it lacked from the npm registry.\n",
  });
  // the save's timeout
  expect(report("success", key, "", "failure")).toEqual({
    status: 0,
    stdout:
      "::warning title=pnpm's store not saved::the save to Depot Cache failed (its timeout, or its log says why); runs of this lockfile restore an older store, or none on main, until a main push saves one\n",
    summary: `${miss.slice(0, -1)}. The save failed (its timeout, or its log says why), so runs of this lockfile restore an older store, or none on main, until a main push saves one.\n`,
  });
  // a job cancelled before the restore ran
  expect(report("", "", "", "")).toEqual({
    status: 0,
    stdout: "",
    summary: "**pnpm's store**: none restored (the restore's outcome: none).\n",
  });
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
      if: afterTheDeployedTarget,
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
    packageManager?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

type CompositeAction = {
  inputs?: Record<string, { default?: string }>;
  outputs?: Record<string, { value: string }>;
  runs: { using: string; steps: WorkflowStep[] };
};

function readSetupAction() {
  return parseYaml(readFileSync(resolve(repoRoot, setupActionFile), "utf8")) as CompositeAction;
}
