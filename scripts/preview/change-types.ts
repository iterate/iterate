// Last matching type wins. Docs inherit results; Tests run tests; OsNext has
// its own per-PR preview workflow and so needs nothing from this pipeline;
// every other type deploys and tests. Unmatched paths use Default.
const CHANGE_TYPES = {
  Default: ["**/*"],
  Product: ["apps/os/**/*"],
  Scripts: ["**/scripts/**/*"],
  Frontend: ["**/components/**", "**/*.tsx"],
  Mobile: ["apps/mobile/**/*"],
  Tests: [
    "**/*.test.ts",
    "**/test/**",
    "**/*.spec.ts",
    "specs/**/*",
    "**/e2e/**/*",
    "**/*.test.tsx",
    "packages/test-support/**/*",
  ],
  Docs: [
    "README.md",
    "packages/*/README.md",
    "apps/*/README.md",
    "docs/**",
    "tasks/**",
    "explainers/**",
  ],
  CI: [".depot/**", "scripts/ci/**/*"],
  Generated: ["**/*generated*", "*lock*"],
  // Last, so every path inside os-next belongs to os-next, whatever else it
  // looks like: its scripts, components, tests, README and generated files.
  // Only paths .depot/workflows/preview-os-next.yml previews AND no fleet app
  // imports (`tsc --listFilesOnly` over apps/os, auth, docs, dummy-petshop,
  // semaphore, streams-example-app, mobile and specs): the rest of that
  // workflow's paths (packages/shared, packages/ui, the rest of
  // packages/iterate, envs.ts, scripts/lib) still deploy and test the fleet.
  OsNext: [
    "apps/os-next/**/*",
    "apps/dash/**/*",
    "apps/agents/**/*",
    "apps/notes/**/*",
    "apps/voice/**/*",
    "configs-next/**/*",
    // envs.ts imports one type from here; no fleet code runs it.
    "packages/iterate/src/next/**/*",
    "packages/iterate/src/next-node.ts",
    ".depot/workflows/deploy-os-next.yml",
    ".depot/workflows/deploy-notes.yml",
    ".depot/workflows/preview-os-next.yml",
  ],
} as const satisfies Record<string, string[]>;

export type ChangeType = keyof typeof CHANGE_TYPES;
export default CHANGE_TYPES;
