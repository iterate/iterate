import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { expect, test } from "vitest";

// Scope-liveness guard: every `overrides[].files` glob in .oxlintrc.json must
// match at least one tracked file, or the rules it arms silently enforce
// nothing. This has happened twice: PR #1341 removed the legacy `spec/`
// directory (and with it the spec-restricted-syntax scope), and PR #1488
// deleted `apps/os/e2e/vitest/agents.e2e.test.ts` — the single pilot file six
// test-style rules were scoped to — leaving the override block pointing at a
// ghost path for a month. A failing entry here means: fix the glob, re-point
// it at the files that replaced the deleted ones, or delete the override.
test("every overrides[].files glob in .oxlintrc.json matches at least one tracked file", () => {
  const repoRoot = resolve(import.meta.dirname, "..");
  const config = JSON.parse(readFileSync(resolve(repoRoot, ".oxlintrc.json"), "utf8")) as {
    overrides: { files: string[] }[];
  };

  // `git ls-files` is the same universe oxlint lints in CI (tracked files,
  // .gitignore/node_modules excluded for free) and keeps this well under the
  // "fast unit test" bar — no directory walking, no glob library.
  const trackedFiles = execFileSync("git", ["ls-files"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);

  const deadGlobs = config.overrides
    .flatMap((override) => override.files)
    .filter((glob) => !trackedFiles.some((file) => matchesGlob(file, glob)));

  expect(
    deadGlobs,
    "These .oxlintrc.json overrides[].files globs match no tracked file, so their rules enforce nothing",
  ).toEqual([]);
});
