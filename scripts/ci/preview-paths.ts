// scripts/ci/preview-paths.ts — THE PATHS A PREVIEW DEPENDS ON, as GitHub `paths` filters list them:
// main's runs that deploy one (main-os-e2e.yml, preview-parents.yml) and a PR's close that deletes
// its deployments (preview-delete.yml) run for these (depot-workflows.test.ts keeps them equal).
// Preview OS itself runs on every pull request, since its E2E tests and Browser specs checks are
// required, and a required check has to report on every pull request: GitHub leaves one "Pending"
// forever when a `paths` filter skips its workflow
// (https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#handling-skipped-but-required-checks).
// Whether a push needs its preview is scripts/ci/preview-inherit.ts's to say.
import { matchesPaths } from "./preview-units.ts";

/**
 * The paths a preview depends on: GitHub `paths` syntax, where the last pattern a file matches
 * decides and a `!` pattern excludes. preview-delete.yml's `paths` are this list and
 * main-os-e2e.yml's push `paths` contain it (depot-workflows.test.ts keeps them so), because a
 * closing pull request deletes the previews it got, and main tests what a pull request's preview
 * would have.
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
  // the setup every preview job runs (docs/depot-ci.md#setup-on-depots-stock-image)
  ".depot/actions/**",
  "scripts/ci/toolchain.sh",
];

/** GitHub's `paths` filter over `previewPaths`: true when any file would have triggered it. */
export function touchesPreview(files: string[]) {
  return files.some((file) => matchesPaths(previewPaths, file));
}
