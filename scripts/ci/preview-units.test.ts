import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { PREVIEW_DEPLOYMENT_APPS } from "../../envs.ts";
import { touchesPreview } from "./preview-paths.ts";
import {
  changedUnits,
  matchesPaths,
  PREVIEW_UNITS,
  previewMachineryPaths,
  previewSuites,
  suiteInputFiles,
  unitProductPaths,
} from "./preview-units.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

test.for([
  { files: ["docs/depot-ci.md"], units: [], e2e: false, specs: false },
  {
    files: ["apps/os/docs/integrations.md", "apps/os/README.md"],
    units: [],
    e2e: false,
    specs: false,
  },
  { files: ["apps/os/src/worker.test.ts"], units: [], e2e: false, specs: false },
  { files: ["apps/os/src/worker.ts"], units: ["os"], e2e: true, specs: true },
  { files: ["apps/os/e2e/fetch.e2e.test.ts"], units: [], e2e: true, specs: false },
  { files: ["packages/cli/src/index.ts"], units: [], e2e: true, specs: false },
  { files: ["specs/notes/notes.spec.ts"], units: [], e2e: false, specs: true },
  { files: ["apps/notes/src/routes/index.tsx"], units: ["notes"], e2e: false, specs: true },
  { files: [".depot/workflows/deploy-notes.yml"], units: ["notes"], e2e: false, specs: true },
  { files: ["apps/kit/firmware/main/main.c"], units: [], e2e: false, specs: false },
  {
    files: ["packages/agents/src/install.ts"],
    units: ["dash", "agents", "voice", "kit"],
    e2e: true,
    specs: true,
  },
  { files: ["packages/ui/src/button.tsx"], units: [...PREVIEW_UNITS], e2e: true, specs: true },
  { files: ["pnpm-lock.yaml"], units: [...PREVIEW_UNITS], e2e: true, specs: true },
  { files: [".depot/workflows/preview-os.yml"], units: [...PREVIEW_UNITS], e2e: true, specs: true },
  { files: ["apps/os/scripts/preview.ts"], units: [...PREVIEW_UNITS], e2e: true, specs: true },
])(
  "$files changes $units; E2E tests' inputs: $e2e, Browser specs': $specs",
  ({ files, units, e2e, specs }) => {
    expect({
      units: changedUnits(files),
      e2e: suiteInputFiles("e2e", files).length > 0,
      specs: suiteInputFiles("specs", files).length > 0,
    }).toEqual({ units, e2e, specs });
  },
);

test("a unit's product is what deploys it to prd: its deploy workflow's push paths", () => {
  for (const unit of PREVIEW_UNITS) {
    const workflow = parseYaml(
      readFileSync(resolve(repoRoot, `.depot/workflows/deploy-${unit}.yml`), "utf8"),
    );
    expect({ unit, paths: unitProductPaths[unit] }).toEqual({
      unit,
      paths: workflow.on.push.paths,
    });
  }
  expect(PREVIEW_UNITS).toEqual(["os", ...PREVIEW_DEPLOYMENT_APPS]);
});

// A file a preview runs for but no suite depends on: a change to it alone lets both suites inherit.
// Anything else in `previewPaths` has to be some unit's or suite's input, or a push changing it
// would inherit a verdict that never saw it.
const noSuiteDependsOn = [
  "apps/os/*.md",
  "apps/os/docs/**",
  "apps/os/**/*.test.ts",
  "!apps/os/e2e/**",
  "apps/os/__workers-tests__/**",
  "apps/os/bench/**",
  "apps/os/perf/**",
  "apps/os/scripts/e2e-soak.ts",
];

test("every file a preview runs for is an input of a unit or a suite, or one no suite depends on", () => {
  const files = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter((file) => file && touchesPreview([file]));
  expect(files.length).toBeGreaterThan(500);
  const escaped = files.filter(
    (file) =>
      suiteInputFiles("e2e", [file]).length === 0 &&
      suiteInputFiles("specs", [file]).length === 0 &&
      !matchesPaths(noSuiteDependsOn, file),
  );
  expect(escaped).toEqual([]);
  // and the machinery the list names still exists
  for (const pattern of previewMachineryPaths)
    expect(
      files.some((file) => matchesPaths([pattern], file)),
      pattern,
    ).toBe(true);
  expect(previewSuites.specs).toMatchObject({ units: [...PREVIEW_UNITS] });
});
