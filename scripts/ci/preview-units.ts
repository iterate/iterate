// scripts/ci/preview-units.ts — WHAT A PREVIEW'S PARTS DEPEND ON, pure. A per-commit deployment
// (envs.ts `previewDeployment`) has seven units, apps/os and the six apps on top, and two suites
// test it. Preview OS uses this to skip work a push did not change:
//   - a suite whose inputs the PR head has not changed since a green head inherits that verdict
//     (scripts/ci/preview-inherit.ts)
//   - a unit the tested commit has not changed since an earlier full deployment's is reused from it
//     (apps/os/scripts/preview-reuse.ts)
//
// A unit's product is exactly what deploys it to prd: its `deploy-<unit>.yml` push `paths:`
// (preview-units.test.ts keeps them equal). The preview's own machinery is every unit's product: a
// change to how previews deploy has to deploy one. A suite's inputs are the product of the units it
// tests, the machinery, and its own test files.
//
// Node runs this by its own type stripping before anything is installed (preview-paths.ts), so it
// imports nothing.
import { matchesGlob } from "node:path";

/** apps/os, then the apps on top in envs.ts `PREVIEW_DEPLOYMENT_APPS` order. */
export const PREVIEW_UNITS = ["os", "dash", "agents", "notes", "admin", "voice", "kit"] as const;
export type PreviewUnit = (typeof PREVIEW_UNITS)[number];

/** Each unit's `deploy-<unit>.yml` push `paths:`, verbatim (that file says why each is there). */
export const unitProductPaths: Record<PreviewUnit, string[]> = {
  os: [
    ".depot/workflows/deploy-os.yml",
    "apps/os/**",
    "apps/os/src/**/.generated/**",
    "!apps/os/*.md",
    "!apps/os/docs/**",
    "!apps/os/e2e/**",
    "!apps/os/**/*.test.ts",
    "!apps/os/__workers-tests__/**",
    "!apps/os/bench/**",
    "!apps/os/perf/**",
    "!apps/os/scripts/preview*.ts",
    "!apps/os/scripts/e2e-soak.ts",
    "configs/**",
    "packages/iterate/**",
    "envs.ts",
    "scripts/lib/**",
    "packages/shared/**",
    "packages/ui/**",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ],
  dash: [
    ".depot/workflows/deploy-dash.yml",
    "apps/dash/**",
    "envs.ts",
    "scripts/lib/**",
    "packages/iterate/**",
    "packages/ui/**",
    "packages/shared/**",
    "packages/agents/**",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ],
  agents: [
    ".depot/workflows/deploy-agents.yml",
    "apps/agents/**",
    "envs.ts",
    "scripts/lib/**",
    "configs/**",
    "packages/agents/**",
    "packages/voice/**",
    "packages/iterate/**",
    "packages/ui/**",
    "packages/shared/**",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ],
  notes: [
    ".depot/workflows/deploy-notes.yml",
    "apps/notes/**",
    "envs.ts",
    "scripts/lib/**",
    "packages/iterate/**",
    "packages/ui/**",
    "packages/shared/**",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ],
  admin: [
    ".depot/workflows/deploy-admin.yml",
    "apps/admin/**",
    "envs.ts",
    "scripts/lib/**",
    "packages/iterate/**",
    "packages/ui/**",
    "packages/shared/**",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ],
  voice: [
    ".depot/workflows/deploy-voice.yml",
    "apps/voice/**",
    "packages/agents/**",
    "packages/voice/**",
    "envs.ts",
    "scripts/lib/**",
    "packages/iterate/**",
    "packages/ui/**",
    "packages/shared/**",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ],
  kit: [
    ".depot/workflows/deploy-kit.yml",
    "envs.ts",
    "scripts/lib/**",
    "apps/kit/**",
    "!apps/kit/firmware/**",
    "packages/ui/**",
    "packages/shared/**",
    "packages/agents/**",
    "packages/voice/**",
    "packages/iterate/**",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "patches/**",
  ],
};

/** How a preview is deployed and tested, which no prd deploy runs: every unit's product. */
export const previewMachineryPaths = [
  ".depot/workflows/preview-os.yml",
  ".depot/actions/**",
  "scripts/ci/toolchain.sh",
  "apps/os/scripts/preview*.ts",
];

export type PreviewSuite = "e2e" | "specs";

/** The units each suite tests and its own test files. E2E tests is the vitest e2e suite against
 *  apps/os alone: its rows and their support, the agents rows (apps/agents/e2e, which install
 *  packages/agents and packages/voice into projects) and the CLI rows. Browser specs signs in to
 *  every app on top. */
export const previewSuites: Record<PreviewSuite, { units: PreviewUnit[]; tests: string[] }> = {
  e2e: {
    units: ["os"],
    tests: [
      "apps/os/e2e/**",
      "apps/agents/**",
      "packages/agents/**",
      "packages/voice/**",
      "packages/cli/**",
    ],
  },
  specs: { units: [...PREVIEW_UNITS], tests: ["specs/**", "playwright.config.ts"] },
};

/** The units whose product `files` touches; the machinery touches every one. */
export function changedUnits(files: string[]): PreviewUnit[] {
  if (files.some((file) => matchesPaths(previewMachineryPaths, file))) return [...PREVIEW_UNITS];
  return PREVIEW_UNITS.filter((unit) =>
    files.some((file) => matchesPaths(unitProductPaths[unit], file)),
  );
}

/** Whether `files` touches anything `suite` depends on: its units' product (the machinery
 *  included) or its own tests. */
export function touchesSuite(suite: PreviewSuite, files: string[]) {
  const { units, tests } = previewSuites[suite];
  return (
    changedUnits(files).some((unit) => units.includes(unit)) ||
    files.some((file) => matchesPaths(tests, file))
  );
}

/** Whether GitHub's `paths` filter `patterns` takes `file`: the last pattern it matches decides, and
 *  a `!` pattern excludes. */
export function matchesPaths(patterns: string[], file: string) {
  let included = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    if (matchesGlob(file, negated ? pattern.slice(1) : pattern)) included = !negated;
  }
  return included;
}
