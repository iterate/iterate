import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { publishedPackageCommit, publishPathsOf } from "./published-package-commit.ts";

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
