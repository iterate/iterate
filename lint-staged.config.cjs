let localConfig = {};
try {
  localConfig = require("./lint-staged.local.cjs");
} catch {
  // no problem
}

// Stricter checks for coding agents (Claude Code, OpenCode, Cursor, etc.)
// Check all known agent env vars for robustness
const isAgent =
  process.env.AGENT === "1" ||
  process.env.OPENCODE === "1" ||
  !!process.env.OPENCODE_SESSION ||
  !!process.env.CLAUDE_CODE;

/** @type {import('lint-staged').Configuration} */
const baseConfig = {
  "*": ["prettier --write --ignore-unknown"],
  "skills/**": [
    () => "pnpm -C apps/iterate-com skills:generate",
    "git add apps/iterate-com/backend/generated/skills-registry.ts",
  ],
};

/** @type {import('lint-staged').Configuration} */
const agentConfig = {
  "*": [
    ...(baseConfig["*"] || []),
    // using a function which ignores args (filepaths) means *don't* append the filepaths to the command
    () => "pnpm typecheck",
    // if tests prove slow, we could do smart dependency tracking to only run tests for changed files
    () => "pnpm test",
    "eslint --fix --max-warnings 0 --no-warn-ignored", // suppress warnings for ignored files
  ],
};

module.exports = {
  ...baseConfig,
  ...(isAgent && agentConfig),
  ...localConfig,
};
