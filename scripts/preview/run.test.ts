import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { expect, test } from "vitest";
import { createMainPreview } from "./run.ts";

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
  const { run, report } = createMainPreview({
    commit: repo.sha,
    githubToken: "test",
    repositoryRoot: repo.path,
    environment: {
      DEPOT_JOB_URL: "https://depot.dev/jobs/test",
      GITHUB_WORKFLOW: workflow.name,
      GITHUB_JOB: "preview",
      GITHUB_REF_NAME: "main",
    },
  });
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
  }));
  expect(report.state).toMatchObject({ notice: "Tests failed" });
  expect(
    JSON.parse(readFileSync(join(repo.path, "test-results/main-preview-state.json"), "utf8")),
  ).toMatchObject({
    headSha: repo.sha,
    state: { notice: "Tests failed", environmentConfigLease: { slug: "preview-8" } },
  });
});

test("a different commit or modified checkout cannot be called a pinned main result", () => {
  using repo = repository();
  const options = {
    commit: "a".repeat(40),
    githubToken: "test",
    repositoryRoot: repo.path,
    environment: {
      DEPOT_JOB_URL: "https://depot.dev/jobs/test",
      GITHUB_WORKFLOW: "Main Preview (Depot CI)",
      GITHUB_JOB: "preview",
      GITHUB_REF_NAME: "main",
    },
  };
  expect(() => createMainPreview(options)).toThrow(/checked-out commit/);
  writeFileSync(join(repo.path, "source.txt"), "changed");
  expect(() => createMainPreview({ ...options, commit: repo.sha })).toThrow(/uncommitted/);
});

test("a validation dispatch from a branch cannot impersonate main", () => {
  using repo = repository();
  const { run } = createMainPreview({
    commit: repo.sha,
    githubToken: "test",
    repositoryRoot: repo.path,
    environment: {
      DEPOT_JOB_URL: "https://depot.dev/jobs/test",
      GITHUB_WORKFLOW: "Main Preview (Depot CI)",
      GITHUB_JOB: "preview",
      GITHUB_REF_NAME: "ci/test-main-workflow",
    },
  });
  expect(run).toMatchObject({ branch: "ci/test-main-workflow" });
});

test("local invocation cannot bypass main's workflow lock", () => {
  using repo = repository();
  expect(() =>
    createMainPreview({
      commit: repo.sha,
      githubToken: "test",
      repositoryRoot: repo.path,
      environment: { GITHUB_REF_NAME: "main" },
    }),
  ).toThrow(/serialized/);
});

test.each([
  ["run", "--pull-request-number"],
  ["run-main", "--commit"],
])("the %s CLI loads with Node's native TypeScript support", (command, option) => {
  const help = execFileSync("pnpm", ["preview", command, "--help"], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(help).toContain(option);
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
  return {
    path,
    sha: git("rev-parse", "HEAD"),
    [Symbol.dispose]() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}
