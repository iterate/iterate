import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { publishedPackageCommit, publishPathsOf } from "./published-package-commit.ts";

const publishPaths = ["packages/agents/**", "packages/iterate/**", "pnpm-lock.yaml"];
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
  { name: "a main commit is its own merge base", changedPaths: [], expected: base },
])("$name", ({ changedPaths, expected }) => {
  expect(
    publishedPackageCommit({ sourceCommit: head, mergeBaseSha: base, changedPaths, publishPaths }),
  ).toBe(expected);
});

test("the publish paths are pkg-pr-new.yml's pull_request.paths", () => {
  const workflow = readFileSync(
    path.resolve(import.meta.dirname, "../../../.github/workflows/pkg-pr-new.yml"),
    "utf8",
  );
  expect(publishPathsOf(workflow)).toEqual(
    expect.arrayContaining(["packages/agents/**", "packages/iterate/**", "pnpm-lock.yaml"]),
  );
  expect(publishPathsOf(workflow)).not.toContain("main");
});
