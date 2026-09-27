import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect, test } from "vitest";
import { temporaryDirectory } from "@iterate-com/shared/test-support/temporary-directory";

import { computeReport, getChangedFiles, renderBodySection } from "./loc-report.ts";

test("type-only TypeScript changes remain in Lines but disappear from Significant", () => {
  using repo = createGitRepo();
  const base = repo.commit({
    "src/user.ts": [
      "export interface User {",
      "  id: string",
      "  displayName: string",
      "}",
      "",
    ].join("\n"),
  });
  const head = repo.commit({
    "src/user.ts": ["export interface User {", "  id: string", "  name: string", "}", ""].join(
      "\n",
    ),
  });

  expect(getChangedFiles(base, head, repo.path)).toMatchObject([
    {
      path: "src/user.ts",
      added: 1,
      removed: 1,
      significantAdded: 0,
      significantRemoved: 0,
    },
  ]);
});

test("TypeScript declaration files remain in Lines but contribute no Significant lines", () => {
  using repo = createGitRepo();
  const base = repo.commit({
    "types/index.d.cts": ["export interface User {", "  id: string", "}", ""].join("\n"),
    "types/index.d.mts": ["export interface User {", "  id: string", "}", ""].join("\n"),
    "types/index.d.ts": ["export interface User {", "  id: string", "}", ""].join("\n"),
  });
  const head = repo.commit({
    "types/index.d.cts": [
      "export interface User {",
      "  id: string",
      "  displayName: string",
      "}",
      "",
    ].join("\n"),
    "types/index.d.mts": [
      "export interface User {",
      "  id: string",
      "  displayName: string",
      "}",
      "",
    ].join("\n"),
    "types/index.d.ts": [
      "export interface User {",
      "  id: string",
      "  displayName: string",
      "}",
      "",
    ].join("\n"),
  });

  expect(getChangedFiles(base, head, repo.path)).toMatchObject([
    {
      path: "types/index.d.cts",
      added: 1,
      significantAdded: 0,
      significantRemoved: 0,
    },
    {
      path: "types/index.d.mts",
      added: 1,
      significantAdded: 0,
      significantRemoved: 0,
    },
    {
      path: "types/index.d.ts",
      added: 1,
      significantAdded: 0,
      significantRemoved: 0,
    },
  ]);
});

test("mixed TypeScript changes count only emitted runtime lines as Significant", () => {
  using repo = createGitRepo();
  const base = repo.commit({
    "src/user.tsx": ["export interface User {", "  id: string", "}", ""].join("\n"),
  });
  const head = repo.commit({
    "src/user.tsx": [
      "export interface User {",
      "  id: string",
      "  displayName: string",
      "}",
      "export const Avatar = (user: User) => <span>{user.displayName}</span>",
      "",
    ].join("\n"),
  });

  expect(getChangedFiles(base, head, repo.path)).toMatchObject([
    {
      added: 2,
      removed: 0,
      significantAdded: 1,
      significantRemoved: 0,
    },
  ]);
});

test("a TSX change to JSX text alone (UI copy) is Significant", () => {
  using repo = createGitRepo();
  const page = (copy: string) =>
    [
      "export function Page() {",
      "  return (",
      "    <p>",
      `      ${copy}`,
      "    </p>",
      "  );",
      "}",
      "",
    ].join("\n");
  const base = repo.commit({ "src/page.tsx": page("Sign in to continue") });
  const head = repo.commit({ "src/page.tsx": page("Sign in to Waitrose") });

  expect(getChangedFiles(base, head, repo.path)).toMatchObject([
    { path: "src/page.tsx", added: 1, removed: 1, significantAdded: 1, significantRemoved: 1 },
  ]);
});

test("runtime-emitting TypeScript syntax remains Significant without compiler-line inflation", () => {
  using repo = createGitRepo();
  const base = repo.commit({ "src/direction.ts": "" });
  const head = repo.commit({
    "src/direction.ts": ["enum Direction {", "  Up,", "  Down,", "}", ""].join("\n"),
  });

  expect(getChangedFiles(base, head, repo.path)).toMatchObject([
    {
      added: 4,
      removed: 0,
      significantAdded: 4,
      significantRemoved: 0,
    },
  ]);
});

test("JavaScript comments and non-JavaScript blank lines retain their Significant behavior", () => {
  using repo = createGitRepo();
  const base = repo.commit({ "README.md": "", "src/value.js": "" });
  const head = repo.commit({
    "README.md": ["# Heading", "", "Copy", ""].join("\n"),
    "src/value.js": ["// explain the value", "export const value = 1", ""].join("\n"),
  });

  expect(getChangedFiles(base, head, repo.path)).toMatchObject([
    {
      path: "README.md",
      added: 3,
      significantAdded: 2,
    },
    {
      path: "src/value.js",
      added: 2,
      significantAdded: 1,
    },
  ]);
});

test("the PR report explains the TypeScript runtime-line filter", () => {
  expect(renderBodySection(computeReport([]), "1234567890", "abcdef1234")).toContain(
    "TypeScript lines with no runtime output",
  );
});

test.for([
  { path: "specs/test-support/test.ts", group: "Tests" },
  { path: "specs/setup.ts", group: "Tests" },
  { path: "specs/os/auth.spec.ts", group: "Tests" },
  { path: "apps/os/__workers-tests__/support.ts", group: "Tests" },
  { path: "apps/agents/__workers-tests__/agent-revive.test.ts", group: "Tests" },
  { path: "apps/os/src/stream/memory-budget.test-support.ts", group: "Tests" },
  { path: "apps/os/src/stream/test-support.ts", group: "Tests" },
  { path: "apps/os/src/worker.ts", group: "Product" },
])("$path counts as $group", ({ path, group }) => {
  const file = {
    path,
    previousPath: path,
    added: 1,
    removed: 0,
    significantAdded: 1,
    significantRemoved: 0,
    binary: false,
    generated: false,
  };

  expect(computeReport([file]).rows).toMatchObject([{ name: group, files: 1 }]);
});

function createGitRepo() {
  const directory = temporaryDirectory();
  const { path } = directory;
  execFileSync("git", ["init", "--quiet"], { cwd: path });

  return {
    ...directory,
    commit(files: Record<string, string>) {
      for (const [file, content] of Object.entries(files)) {
        const fullPath = join(path, file);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content);
      }
      execFileSync("git", ["add", "."], { cwd: path });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=LOC Report Test",
          "-c",
          "user.email=loc-report@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "fixture",
        ],
        { cwd: path },
      );
      return execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
    },
  };
}
