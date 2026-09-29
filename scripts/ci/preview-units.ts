// scripts/ci/preview-units.ts — WHAT A PREVIEW'S PARTS DEPEND ON, pure. A per-commit deployment
// (envs.ts `previewDeployment`) has seven units, apps/os and the six apps on top, and two suites
// test it. Preview OS uses this to skip work a push did not change:
//   - a suite whose inputs the head has not changed since an ancestor's green inherits that verdict
//     (scripts/ci/preview-inherit.ts)
//   - a unit the head has not changed since an ancestor's full deployment is reused from it
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

/** The files of `files` that `suite` depends on: its units' product (the machinery included) and
 *  its own tests. */
export function suiteInputFiles(suite: PreviewSuite, files: string[]) {
  const { units, tests } = previewSuites[suite];
  return files.filter(
    (file) =>
      changedUnits([file]).some((unit) => units.includes(unit)) || matchesPaths(tests, file),
  );
}

/** Whether `file` is a test itself, an e2e row's or a spec's, which no other file depends on. */
export function isTestFile(file: string) {
  return (
    matchesPaths(E2E_TEST_FILES, file) ||
    SPEC_DIRECTORIES.some(({ files }) => matchesPaths(files, file))
  );
}

/** The e2e rows' own files: a change to nothing but some of them reruns only those. */
const E2E_TEST_FILES = ["apps/os/e2e/**/*.e2e.test.ts", "apps/agents/e2e/**/*.e2e.test.ts"];

/** Browser specs' projects (playwright.config.ts) by the directory their specs live in. The suite's
 *  own specs (the flake sentinel, the harness's) are the `suite` project. */
const SPEC_DIRECTORIES: { directory: string; files: string[]; projects: string[] }[] = [
  { directory: "specs/os/", files: ["specs/os/**/*.spec.ts"], projects: ["os", "os-phone"] },
  { directory: "specs/dash/", files: ["specs/dash/**/*.spec.ts"], projects: ["dash"] },
  { directory: "specs/notes/", files: ["specs/notes/**/*.spec.ts"], projects: ["notes"] },
  { directory: "specs/voice/", files: ["specs/voice/**/*.spec.ts"], projects: ["voice"] },
  { directory: "specs/admin/", files: ["specs/admin/**/*.spec.ts"], projects: ["admin"] },
  {
    directory: "specs/test-support/",
    files: ["specs/test-support/*.spec.ts", "specs/flake-sentinel.spec.ts"],
    projects: ["suite"],
  },
];

/** The spec directories an app unit's change reruns: its own, and for the Dash, every app's, since
 *  each app's specs sign in and out through it. os, agents and kit rerun every spec. */
const UNIT_SPECS: Partial<Record<PreviewUnit, string[]>> = {
  dash: ["specs/dash/", "specs/notes/", "specs/voice/", "specs/admin/"],
  notes: ["specs/notes/"],
  voice: ["specs/voice/"],
  admin: ["specs/admin/"],
};

/** THE PART OF A SUITE A RUN NEEDS, given `inputs`, the files it depends on that changed since its
 *  last green: the arguments that select it for the suite's runner, or undefined for the whole suite.
 *  - E2E tests: when every one is an e2e row's file, those files; anything else (os, the rows'
 *    support, the packages they install) reruns every row.
 *  - Browser specs: a changed spec file reruns that file, in the projects that hold it; a changed
 *    app reruns its projects (UNIT_SPECS). Anything else (os, agents, kit, the setup, the shared
 *    helpers, the Playwright config) reruns every spec.
 *  The rest of the suite passed at the green run and nothing it depends on changed since. */
export function suiteSelection(
  suite: PreviewSuite,
  inputs: string[],
): { args: string[]; summary: string } | undefined {
  if (suite === "e2e") {
    if (!inputs.every((file) => matchesPaths(E2E_TEST_FILES, file))) return undefined;
    return { args: inputs, summary: `only ${inputs.join(", ")}` };
  }
  const filters = new Set<string>();
  const projects = new Set<string>();
  const select = (filter: string, directory: string) => {
    filters.add(filter);
    for (const project of SPEC_DIRECTORIES.find((spec) => spec.directory === directory)!.projects)
      projects.add(project);
  };
  for (const file of inputs) {
    const spec = SPEC_DIRECTORIES.find(({ files }) => matchesPaths(files, file));
    if (spec) {
      select(file, spec.directory);
      continue;
    }
    const units = changedUnits([file]);
    if (units.length === 0) return undefined;
    for (const unit of units) {
      const directories = UNIT_SPECS[unit];
      if (!directories) return undefined;
      for (const directory of directories) select(directory, directory);
    }
  }
  return {
    args: [...filters, ...[...projects].flatMap((project) => ["--project", project])],
    summary: `only the ${[...projects].join(", ")} project(s)`,
  };
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
