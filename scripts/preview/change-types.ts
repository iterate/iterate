// Last matching type wins. Docs inherit results; Tests run tests;
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
} as const satisfies Record<string, string[]>;

export type ChangeType = keyof typeof CHANGE_TYPES;
export default CHANGE_TYPES;
