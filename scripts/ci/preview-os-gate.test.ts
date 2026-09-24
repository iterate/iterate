import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { previewVerdict, touchesPreview } from "./preview-os-gate.ts";

// GitHub's `paths` semantics: any file whose last matching pattern is a positive one triggers.
test.each([
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
  {
    files: [".depot/workflows/lint-typecheck.yml", "scripts/ci/preview-os-gate.ts"],
    preview: false,
  },
  { files: [], preview: false },
])("a pull request changing $files gets a preview: $preview", ({ files, preview }) => {
  expect(touchesPreview(files)).toBe(preview);
});

test.each([
  // pull requests
  {
    event: "pull_request",
    changes: "success",
    touched: "false",
    deploy: "skipped",
    e2e: "skipped",
    ok: true,
  },
  {
    event: "pull_request",
    changes: "success",
    touched: "true",
    deploy: "success",
    e2e: "success",
    ok: true,
  },
  {
    event: "pull_request",
    changes: "success",
    touched: "true",
    deploy: "failure",
    e2e: "skipped",
    ok: false,
  },
  {
    event: "pull_request",
    changes: "success",
    touched: "true",
    deploy: "success",
    e2e: "failure",
    ok: false,
  },
  {
    event: "pull_request",
    changes: "success",
    touched: "true",
    deploy: "success",
    e2e: "cancelled",
    ok: false,
  },
  // a deploy that did not run although the pull request touches a preview path is not a pass
  {
    event: "pull_request",
    changes: "success",
    touched: "true",
    deploy: "skipped",
    e2e: "skipped",
    ok: false,
  },
  {
    event: "pull_request",
    changes: "failure",
    touched: "",
    deploy: "skipped",
    e2e: "skipped",
    ok: false,
  },
  // merge-queue groups: the pull request's own gate was green to join the queue
  {
    event: "merge_group",
    changes: "skipped",
    touched: "",
    deploy: "skipped",
    e2e: "skipped",
    ok: true,
  },
  // dispatches
  {
    event: "workflow_dispatch",
    changes: "skipped",
    touched: "",
    deploy: "success",
    e2e: "success",
    ok: true,
  },
  {
    event: "workflow_dispatch",
    changes: "skipped",
    touched: "",
    deploy: "skipped",
    e2e: "success",
    ok: true,
  },
  {
    event: "workflow_dispatch",
    changes: "skipped",
    touched: "",
    deploy: "failure",
    e2e: "skipped",
    ok: false,
  },
  {
    event: "workflow_dispatch",
    changes: "skipped",
    touched: "",
    deploy: "skipped",
    e2e: "failure",
    ok: false,
  },
  // a dispatch with no pull request number tests nothing; its gate lands on the dispatched ref's
  // head, where a green one would stand in for that pull request's own
  {
    event: "workflow_dispatch",
    changes: "skipped",
    touched: "",
    deploy: "skipped",
    e2e: "skipped",
    ok: false,
  },
  { event: "push", changes: "skipped", touched: "", deploy: "skipped", e2e: "skipped", ok: false },
])(
  "the gate on $event with changes $changes (preview=$touched), deploy $deploy, e2e $e2e passes: $ok",
  ({ ok, ...input }) => {
    expect(previewVerdict(input)).toMatchObject({ ok, reason: expect.any(String) });
  },
);

// The command the changes job runs, in a scratch repository whose HEAD is a merge commit. A rename
// counts on both sides: moving a file out of apps/os changes apps/os.
test.each([
  { change: "adds", path: "docs/notes.md", preview: "false" },
  { change: "adds", path: "apps/os/src/worker.ts", preview: "true" },
  { change: "moves apps/os/src/moved.ts to", path: "docs/moved.ts", preview: "true" },
])(
  "changes writes preview=$preview when the pull request $change $path",
  ({ change, path, preview }) => {
    const repo = mkdtempSync(join(tmpdir(), "preview-os-gate-"));
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
      git("checkout", "--quiet", "-b", "head");
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      if (change === "adds") writeFileSync(join(repo, path), "change\n");
      else git("mv", "apps/os/src/moved.ts", path);
      git("add", ".");
      git("commit", "--quiet", "-m", "head");
      git("checkout", "--quiet", "main");
      writeFileSync(join(repo, "MAIN.md"), "main moved on\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "main");
      git("merge", "--quiet", "--no-ff", "-m", "merge", "head");

      const run = spawnSync(
        process.execPath,
        [resolve(import.meta.dirname, "preview-os-gate.ts"), "changes"],
        { cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_OUTPUT: output } },
      );
      expect(run).toMatchObject({ status: 0 });
      expect(readFileSync(output, "utf8")).toBe(`preview=${preview}\n`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  },
);
