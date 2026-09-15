import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createMainRunContext } from "./run-context.ts";

test("a main preview pins its checkout and records state without a PR", async () => {
  using repo = repository();
  const context = createMainRunContext({
    commit: repo.sha,
    githubToken: "test",
    repositoryRoot: repo.path,
    environment: { GITHUB_REF_NAME: "main" },
  });
  expect(context).toMatchObject({
    headSha: repo.sha,
    branch: "main",
    holder: "main-preview",
    pullRequest: null,
  });
  await context.updateState((state) => ({ ...state, notice: "Tests failed" }));
  expect(await context.readState()).toMatchObject({ state: { notice: "Tests failed" } });
  expect(
    JSON.parse(readFileSync(join(repo.path, "test-results/main-preview-state.json"), "utf8")),
  ).toMatchObject({ headSha: repo.sha, state: { notice: "Tests failed" } });
});

test("a different commit or modified checkout cannot be called a pinned main result", () => {
  using repo = repository();
  const options = {
    commit: "a".repeat(40),
    githubToken: "test",
    repositoryRoot: repo.path,
    environment: { GITHUB_REF_NAME: "main" },
  };
  expect(() => createMainRunContext(options)).toThrow(/checked-out commit/);
  writeFileSync(join(repo.path, "source.txt"), "changed");
  expect(() => createMainRunContext({ ...options, commit: repo.sha })).toThrow(/uncommitted/);
});

test("a validation dispatch from a branch cannot impersonate main", () => {
  using repo = repository();
  const context = createMainRunContext({
    commit: repo.sha,
    githubToken: "test",
    repositoryRoot: repo.path,
    environment: { GITHUB_REF_NAME: "ci/test-main-workflow" },
  });
  expect(context).toMatchObject({ branch: "ci/test-main-workflow" });
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
