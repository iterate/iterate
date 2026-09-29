import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  checkoutPublishedPackageCommit,
  publishedPackageCommit,
  publishPathsOf,
} from "./published-package-commit.ts";

/** pkg-pr-new.yml's own `pull_request.paths`. */
const publishPaths = publishPathsOf(
  readFileSync(
    path.resolve(import.meta.dirname, "../../../.github/workflows/pkg-pr-new.yml"),
    "utf8",
  ),
);
const base = "b".repeat(40);
const head = "h".repeat(40);

test.for([
  {
    name: "a change to a published package pins the source commit",
    changedPaths: ["apps/os/src/worker.ts", "packages/agents/src/install.ts"],
    expected: head,
  },
  {
    name: "a lockfile change alone pins the source commit",
    changedPaths: ["pnpm-lock.yaml"],
    expected: head,
  },
  {
    name: "no change to a published package pins the merge base, which main published",
    changedPaths: ["apps/os/src/worker.ts", "configs/default/worker.ts"],
    expected: base,
  },
])("$name", ({ changedPaths, expected }) => {
  expect(
    publishedPackageCommit({ sourceCommit: head, mergeBaseSha: base, changedPaths, publishPaths }),
  ).toBe(expected);
});

test("a one-way copy of this repo (iterate/os) builds against the commit its HEAD was copied from", () => {
  const origin = "0".repeat(40);
  using copy = gitRepo();
  copy.commit(`Add logout button (iterate/iterate#123)\n\nGitOrigin-RevId: ${origin}\n`);
  // no origin/main to take a merge base with, and no .github/workflows/pkg-pr-new.yml to read
  expect(checkoutPublishedPackageCommit(copy.dir, undefined)).toBe(origin);
});

/** An empty git repository in a temporary folder, removed on dispose. */
function gitRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "published-package-commit-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "--quiet");
  return {
    dir,
    commit: (message: string) =>
      git(
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        message,
      ),
    [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }),
  };
}
