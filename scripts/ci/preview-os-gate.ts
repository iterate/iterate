// scripts/ci/preview-os-gate.ts — PREVIEW OS AS ONE CHECK THAT CAN BE REQUIRED: **Preview OS / gate**
// (.depot/workflows/preview-os.yml) is green when this run's preview proved the pull request, and
// green when the pull request touches nothing a preview proves.
//
// Why a gate job instead of requiring deploy and e2e: GitHub leaves a required check "Pending" when
// a `paths` filter skips its workflow, and counts a job skipped by its `if` as passing, so a failed
// deploy would let a skipped e2e through. Its advice: no path filter on a required workflow, and
// `always()` on a required job that needs others
// (https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#handling-skipped-but-required-checks).
// So Preview OS runs on every pull request, the `changes` job decides with `previewPaths` whether
// deploy and e2e run, and the gate runs after them whatever they did.
//
// Two commands, run by node's own type stripping before anything is installed:
//   changes  the files this pull request changes (the run's merge commit against its first parent,
//            main as GitHub merged it), matched against `previewPaths`; writes `preview=true` or
//            `preview=false` to GITHUB_OUTPUT
//   verdict  `previewVerdict` over the event and the needed jobs' results: prints why, and exits 1
//            when Preview OS did not prove what it had to
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import process from "node:process";

/**
 * The paths whose change gets a pull request a preview: GitHub `paths` syntax, where the last
 * pattern a file matches decides and a `!` pattern excludes. preview-delete.yml's `paths` and
 * main-os-e2e.yml's push `paths` are this list (depot-workflows.test.ts keeps them equal), because
 * a closing pull request deletes the preview it got, and main tests what a pull request's preview
 * would have.
 */
export const previewPaths = [
  // A production-workflow change must exercise the isolated deployment: production runs only
  // deploy's non-mutating readiness probes.
  ".depot/workflows/deploy-os.yml",
  ".depot/workflows/deploy-dash.yml",
  ".depot/workflows/deploy-agents.yml",
  ".depot/workflows/deploy-notes.yml",
  ".depot/workflows/deploy-voice.yml",
  ".depot/workflows/deploy-kit.yml",
  ".depot/workflows/preview-os.yml",
  "apps/os/**",
  "configs/**",
  "apps/dash/**",
  "apps/agents/**",
  "apps/notes/**",
  "apps/voice/**",
  "apps/kit/**",
  // Kit's firmware ships as GitHub releases (kit-firmware.yml), never in its Worker.
  "!apps/kit/firmware/**",
  "specs/**",
  "playwright.config.ts",
  // apps/os/e2e/iterate-cli.e2e.test.ts drives the built CLI.
  "packages/cli/**",
  "packages/iterate/**",
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

/**
 * The gate's rules, per event (preview-os-gate.test.ts has the table):
 *   pull_request       green when the pull request touches no preview path, or when deploy and e2e
 *                      both succeeded; red when `changes` could not tell, or either job did not
 *                      succeed
 *   merge_group        green: the pull request's own gate was green before it could join the queue,
 *                      and the queue re-runs Lint and Typecheck and Test on the group
 *                      (docs/depot-ci.md#merge-queue)
 *   workflow_dispatch  green only when the dispatched e2e ran and succeeded. A dispatch posts its checks
 *                      on the dispatched ref's head, where they count toward a pull request's required
 *                      checks like its own run's, so a dispatch that tested nothing (no pull request
 *                      number) is red, never a green gate over a red or unfinished e2e
 * A job result is GitHub's `needs.<job>.result`: success, failure, cancelled or skipped.
 */
export function previewVerdict(input: {
  event: string;
  changes: string;
  touched: string;
  deploy: string;
  e2e: string;
}) {
  const { event, changes, touched, deploy, e2e } = input;
  if (event === "merge_group")
    return {
      ok: true,
      reason:
        "merge group: this pull request's own Preview OS gate was green before it joined the queue; the queue re-runs Lint and Typecheck and Test on the group",
    };
  if (event === "pull_request") {
    if (changes !== "success")
      return {
        ok: false,
        reason: `the changes job ${changes}, so nothing decided whether to deploy`,
      };
    if (touched === "false")
      return { ok: true, reason: "this pull request touches no preview path: nothing to prove" };
    if (deploy === "success" && e2e === "success")
      return { ok: true, reason: "the preview deployed and its e2e suite and specs passed" };
    return { ok: false, reason: `deploy ${deploy}, e2e ${e2e}` };
  }
  if (event === "workflow_dispatch") {
    if (e2e === "success") return { ok: true, reason: "the dispatched e2e run passed" };
    if (deploy === "skipped" && e2e === "skipped")
      return { ok: false, reason: "the dispatch named no pull request, so nothing was tested" };
    return { ok: false, reason: `deploy ${deploy}, e2e ${e2e}` };
  }
  return { ok: false, reason: `Preview OS does not run on ${event}` };
}

function main(command: string | undefined) {
  if (command === "changes") {
    // A pull request's run is GitHub's test merge commit, checked out with its parents
    // (docs/depot-ci.md#which-tree-a-pull-requests-ci-tests): its first parent is main as merged.
    const parents = git("rev-list", "--parents", "-n", "1", "HEAD").split(" ");
    if (parents.length !== 3) throw new Error(`HEAD is not a merge commit: ${parents.join(" ")}`);
    const files = git("diff", "--name-only", "HEAD^1", "HEAD").split("\n").filter(Boolean);
    const preview = touchesPreview(files);
    console.log(
      `${files.length} changed files; ${preview ? "some match" : "none matches"} the preview paths`,
    );
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `preview=${preview}\n`);
    return;
  }
  if (command === "verdict") {
    const verdict = previewVerdict({
      event: process.env.PREVIEW_GATE_EVENT || "",
      changes: process.env.PREVIEW_GATE_CHANGES || "",
      touched: process.env.PREVIEW_GATE_TOUCHED || "",
      deploy: process.env.PREVIEW_GATE_DEPLOY || "",
      e2e: process.env.PREVIEW_GATE_E2E || "",
    });
    console.log(`Preview OS ${verdict.ok ? "passes" : "fails"}: ${verdict.reason}`);
    if (!verdict.ok) process.exitCode = 1;
    return;
  }
  throw new Error("Usage: node scripts/ci/preview-os-gate.ts <changes|verdict>");
}

if (process.argv[1]?.endsWith("preview-os-gate.ts")) {
  try {
    main(process.argv[2]);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function git(...args: string[]) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}
