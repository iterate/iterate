import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { touchesPreview } from "./preview-paths.ts";

// GitHub's `paths` semantics: any file whose last matching pattern is a positive one triggers.
test.for([
  { files: ["apps/os/src/worker.ts"], preview: true },
  { files: ["configs/default/AGENTS.md"], preview: true },
  { files: ["package.json"], preview: true },
  { files: [".depot/workflows/preview-os.yml"], preview: true },
  // the root manifest only: an app's own package.json is inside its app's pattern
  { files: ["apps/spa/package.json"], preview: false },
  { files: ["docs/depot-ci.md", "lint/rules/no-describe.ts"], preview: false },
  // firmware ships as GitHub releases, never in Kit's Worker
  { files: ["apps/kit/firmware/main/main.c"], preview: false },
  { files: ["apps/kit/firmware/main/main.c", "apps/kit/src/server.ts"], preview: true },
  { files: [".depot/workflows/lint-typecheck.yml", "scripts/ci/preview-paths.ts"], preview: false },
  { files: [], preview: false },
])("a pull request changing $files gets a preview: $preview", ({ files, preview }) => {
  expect(touchesPreview(files)).toBe(preview);
});

// The command the Deploy preview job runs, in a scratch repository whose HEAD is the pull request
// merged into main. A rename counts on both sides: moving a file out of apps/os changes apps/os.
// A HEAD that is no merge (the head alone, when the pull request conflicts) cannot tell, so it
// deploys.
test.for([
  { change: "adds", path: "docs/notes.md", preview: "false" },
  { change: "adds", path: "apps/os/src/worker.ts", preview: "true" },
  { change: "moves apps/os/src/moved.ts to", path: "docs/moved.ts", preview: "true" },
  { change: "is not merged but adds", path: "docs/notes.md", preview: "true" },
])(
  "changes writes preview=$preview when the pull request $change $path",
  ({ change, path, preview }) => {
    const repo = mkdtempSync(join(tmpdir(), "preview-paths-"));
    const output = join(repo, "github-output");
    try {
      const git = (...args: string[]) => {
        const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
          cwd: repo,
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: repo },
        });
        expect(result).toMatchObject({ status: 0 });
      };
      git("init", "--quiet", "--initial-branch=main");
      mkdirSync(join(repo, "apps/os/src"), { recursive: true });
      writeFileSync(join(repo, "apps/os/src/moved.ts"), "export const moved = 1;\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "base");
      git("checkout", "--quiet", "-b", "pr-head");
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      if (change.startsWith("moves")) git("mv", "apps/os/src/moved.ts", path);
      else writeFileSync(join(repo, path), "change\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "head");
      if (!change.startsWith("is not merged")) {
        git("checkout", "--quiet", "main");
        writeFileSync(join(repo, "MAIN.md"), "main moved on\n");
        git("add", ".");
        git("commit", "--quiet", "-m", "main");
        git("merge", "--quiet", "--no-ff", "-m", "merge", "pr-head");
      }

      const run = spawnSync(
        process.execPath,
        [resolve(import.meta.dirname, "preview-paths.ts"), "changes"],
        { cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_OUTPUT: output } },
      );
      expect(run).toMatchObject({ status: 0 });
      expect(readFileSync(output, "utf8")).toBe(`preview=${preview}\n`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  },
);
