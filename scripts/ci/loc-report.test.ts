import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { computeReport, getChangedFiles, renderBodySection } from "./loc-report.ts";

test("type-only TypeScript changes remain in Lines but disappear from Significant", () => {
  using repo = createGitRepo();
  const base = repo.commit({
    "src/user.ts": ["export interface User {", "  id: string", "}", ""].join("\n"),
  });
  const head = repo.commit({
    "src/user.ts": [
      "export interface User {",
      "  id: string",
      "  displayName: string",
      "}",
      "",
    ].join("\n"),
  });

  expect(getChangedFiles(base, head, repo.path)).toMatchObject([
    {
      path: "src/user.ts",
      added: 1,
      removed: 0,
      significantAdded: 0,
      significantRemoved: 0,
    },
  ]);
});

test("mixed TypeScript changes count only emitted runtime lines as Significant", () => {
  using repo = createGitRepo();
  const base = repo.commit({
    "src/user.ts": ["export interface User {", "  id: string", "}", ""].join("\n"),
  });
  const head = repo.commit({
    "src/user.ts": [
      "export interface User {",
      "  id: string",
      "  displayName: string",
      "}",
      "export const getDisplayName = (user: User) => user.displayName",
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

function createGitRepo() {
  const path = mkdtempSync(join(tmpdir(), "loc-report-test-"));
  execFileSync("git", ["init", "--quiet"], { cwd: path });

  return {
    path,
    commit(files: Record<string, string>) {
      for (const [file, content] of Object.entries(files)) {
        const fullPath = join(path, file);
        mkdirSync(join(fullPath, ".."), { recursive: true });
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
    [Symbol.dispose]() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}
