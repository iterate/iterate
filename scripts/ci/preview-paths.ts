// scripts/ci/preview-paths.ts — WHICH PULL REQUESTS GET A PREVIEW. Preview OS (.depot/workflows/preview-os.yml)
// runs on every pull request, because its E2E tests and Browser specs checks are required and a
// required check has to report on every pull request: GitHub leaves one "Pending" forever when a
// `paths` filter skips its workflow, and counts a job skipped by its `if` as passing
// (https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#handling-skipped-but-required-checks).
// So the Deploy preview job's first step decides instead of a `paths` filter: a pull request that
// changes none of `previewPaths` deploys nothing, and both test jobs skip, which passes.
//
//   node scripts/ci/preview-paths.ts changes
//
// runs by node's own type stripping before anything is installed, on the tested commit that
// scripts/ci/preview-tested-commit.ts checked out: the pull request merged into main, whose first
// parent is main as merged. It writes `preview=true` or `preview=false` to GITHUB_OUTPUT, and
// `true` whenever it cannot tell (the head alone, or main's commit could not be fetched): a preview
// that was not needed costs a few minutes, a skipped one would pass untested code.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import process from "node:process";

/**
 * The paths whose change gets a pull request a preview: GitHub `paths` syntax, where the last
 * pattern a file matches decides and a `!` pattern excludes. preview-delete.yml's `paths` are this
 * list and main-os-e2e.yml's push `paths` contain it (depot-workflows.test.ts keeps them so),
 * because a closing pull request deletes the preview it got, and main tests what a pull request's
 * preview would have.
 */
export const previewPaths = [
  // A production-workflow change must exercise the isolated deployment: production runs only
  // deploy's non-mutating readiness probes.
  ".depot/workflows/deploy-os.yml",
  ".depot/workflows/deploy-dash.yml",
  ".depot/workflows/deploy-agents.yml",
  ".depot/workflows/deploy-notes.yml",
  ".depot/workflows/deploy-admin.yml",
  ".depot/workflows/deploy-voice.yml",
  ".depot/workflows/deploy-kit.yml",
  ".depot/workflows/preview-os.yml",
  "apps/os/**",
  "configs/**",
  "apps/dash/**",
  "apps/agents/**",
  "apps/notes/**",
  "apps/admin/**",
  "apps/voice/**",
  "apps/kit/**",
  // Kit's firmware ships as GitHub releases (kit-firmware.yml), never in its Worker.
  "!apps/kit/firmware/**",
  "specs/**",
  "playwright.config.ts",
  // apps/os/e2e/iterate-cli.e2e.test.ts drives the built CLI.
  "packages/cli/**",
  "packages/iterate/**",
  // the agents and voice rows install these (apps/agents/e2e)
  "packages/agents/**",
  "packages/voice/**",
  "packages/shared/**",
  "packages/ui/**",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "envs.ts",
  "scripts/lib/**",
  "scripts/depot-ci/**",
];

/** GitHub's `paths` filter over `previewPaths`: true when any file would have triggered it. */
export function touchesPreview(files: string[]) {
  return files.some((file) => {
    let included = false;
    for (const pattern of previewPaths) {
      const negated = pattern.startsWith("!");
      if (matchesGlob(file, negated ? pattern.slice(1) : pattern)) included = !negated;
    }
    return included;
  });
}

/** Whether the checked-out commit, a merge into main, changes a preview path, or why it cannot
 *  tell. The raw commit object names its parents even in a depth-1 checkout; main's commit is
 *  fetched at depth 1 when it is not there, which transfers only what differs from the merge. */
function changesPreview(): { preview: boolean; reason: string } {
  const parents = [...git("cat-file", "-p", "HEAD").matchAll(/^parent (\w+)$/gm)].map(
    (match) => match[1]!,
  );
  const main = parents[0];
  if (parents.length !== 2 || !main)
    return { preview: true, reason: "the tested commit is not a merge into main" };
  if (spawnSync("git", ["cat-file", "-e", `${main}^{commit}`]).status !== 0) {
    const fetched = spawnSync("git", ["fetch", "--quiet", "--depth=1", "origin", main], {
      encoding: "utf8",
    });
    if (fetched.status !== 0)
      return {
        preview: true,
        reason: `main's ${main} could not be fetched: ${fetched.stderr.trim()}`,
      };
  }
  // --no-renames lists a rename's old path and its new one: moving a file out of apps/os changes
  // apps/os.
  const files = git("diff", "--name-only", "--no-renames", main, "HEAD")
    .split("\n")
    .filter(Boolean);
  const preview = touchesPreview(files);
  return {
    preview,
    reason: `${files.length} changed files; ${preview ? "some match" : "none matches"} the preview paths`,
  };
}

function git(...args: string[]) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

if (process.argv[1]?.endsWith("preview-paths.ts")) {
  if (process.argv[2] !== "changes") {
    console.error("Usage: node scripts/ci/preview-paths.ts changes");
    process.exit(1);
  }
  const { preview, reason } = changesPreview();
  console.log(`${reason}: ${preview ? "deploying the preview" : "no preview to deploy or test"}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `preview=${preview}\n`);
}
