import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { expect, test } from "vitest";
import { createMainPreview } from "./target.ts";
import { run } from "./preview.ts";

test("a main preview pins its checkout and records state without a PR", async () => {
  using repo = repository();
  const workflow = parseYaml(
    readFileSync(
      resolve(import.meta.dirname, "../../.depot/workflows/cloudflare-main-preview.yml"),
      "utf8",
    ),
  );
  expect(workflow).toMatchObject({
    concurrency: { group: "cloudflare-main-preview", "cancel-in-progress": false },
    on: { push: { branches: ["main"] } },
  });
  expect(workflow.jobs.preview).toBeDefined();
  repo.preview.environment.GITHUB_WORKFLOW = workflow.name;
  const { run, report } = createMainPreview(repo.preview);
  expect(run).toMatchObject({
    headSha: repo.sha,
    branch: "main",
    holder: "main-preview",
    pullRequestNumber: null,
  });
  await report.update((state) => ({ ...state, notice: "Tests failed" }));
  await report.update((state) => ({
    ...state,
    environmentConfigLease: { slug: "preview-8", dopplerConfig: "preview_8" },
    apps: {
      os: {
        appSlug: "os",
        appDisplayName: "OS",
        status: "awaiting-tests",
        updatedAt: new Date().toISOString(),
        headSha: repo.sha,
        publicUrl: "https://os.iterate-preview-8.com",
      },
    },
  }));
  expect(report.state).toMatchObject({ notice: "Tests failed" });
  expect(
    JSON.parse(readFileSync(join(repo.path, "test-results/main-preview-state.json"), "utf8")),
  ).toMatchObject({
    headSha: repo.sha,
    state: { notice: "Tests failed", environmentConfigLease: { slug: "preview-8" } },
  });
  // A separate command must recover the deployment, not start an empty report.
  const resumed = createMainPreview(repo.preview);
  expect(resumed.report.state).toEqual(report.state);
});

test.each([
  { DEPOT_JOB_URL: "https://depot.dev/jobs/next" },
  { GITHUB_RUN_ATTEMPT: "2" },
  { GITHUB_REF_NAME: "ci/validation" },
])("a new workflow identity %j cannot reuse an old report", async (change) => {
  using repo = repository();
  const options = repo.preview;
  await createMainPreview(options).report.update((state) => ({
    ...state,
    notice: "Previous run",
    environmentConfigLease: { slug: "preview-8", dopplerConfig: "preview_8" },
  }));
  const next = createMainPreview({
    ...options,
    environment: { ...options.environment, ...change },
  });
  expect(next.report.state).toEqual({ apps: {}, notice: null, environmentConfigLease: null });
});

test("a different commit or modified checkout cannot be called a pinned main result", () => {
  using repo = repository();
  const options = { ...repo.preview, commit: "a".repeat(40) };
  expect(() => createMainPreview(options)).toThrow(/checked-out commit/);
  writeFileSync(join(repo.path, "source.txt"), "changed");
  expect(() => createMainPreview({ ...options, commit: repo.sha })).toThrow(/uncommitted/);
});

test("a validation dispatch from a branch cannot impersonate main", () => {
  using repo = repository();
  const { run } = createMainPreview({
    ...repo.preview,
    environment: { ...repo.preview.environment, GITHUB_REF_NAME: "ci/test-main-workflow" },
  });
  expect(run).toMatchObject({ branch: "ci/test-main-workflow" });
});

test("local invocation cannot bypass main's workflow lock", () => {
  using repo = repository();
  expect(() =>
    createMainPreview({
      ...repo.preview,
      environment: { GITHUB_REF_NAME: "main" },
    }),
  ).toThrow(/serialized/);
});

test("cleanup can recover its target even if the build modified a tracked file", () => {
  using repo = repository();
  writeFileSync(join(repo.path, "source.txt"), "generated during build");
  const options = repo.preview;
  expect(() => createMainPreview({ ...options, requireCleanCheckout: true })).toThrow(
    /uncommitted/,
  );
  expect(createMainPreview({ ...options, requireCleanCheckout: false }).run).toMatchObject({
    headSha: repo.sha,
    holder: "main-preview",
  });
  // Skipping the clean-tree check never skips the ownership/serialization guard.
  expect(() =>
    createMainPreview({ ...options, requireCleanCheckout: false, environment: {} }),
  ).toThrow(/serialized/);
});

test("ambiguous command sources fail before any GitHub or deployment request", async () => {
  await expect(
    run({ pullRequestNumber: 123, commit: "a".repeat(40), githubToken: "test" }),
  ).rejects.toThrow(/Choose --commit or --pull-request-number/);
});

function repository() {
  const path = mkdtempSync(join(tmpdir(), "main-preview-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: path,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  writeFileSync(join(path, "source.txt"), "original");
  git("add", "source.txt");
  git("-c", "user.email=test@iterate.com", "-c", "user.name=Test", "commit", "-m", "Initial");
  const sha = git("rev-parse", "HEAD");
  return {
    path,
    sha,
    preview: {
      commit: sha,
      requireCleanCheckout: true,
      githubToken: "test",
      repositoryRoot: path,
      environment: {
        DEPOT_JOB_URL: "https://depot.dev/jobs/test",
        GITHUB_WORKFLOW: "Main Preview (Depot CI)",
        GITHUB_JOB: "preview",
        GITHUB_REF_NAME: "main",
      },
    },
    [Symbol.dispose]() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}
