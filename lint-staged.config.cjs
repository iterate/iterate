let localConfig = {};
try {
  localConfig = require("./lint-staged.local.cjs");
} catch {
  // no problem
}

// Stricter checks for coding agents (Claude Code, OpenCode, Cursor, etc.)
// Check all known agent env vars for robustness. Claude Code sets `CLAUDECODE=1` (and a family of
// `CLAUDE_CODE_*` vars) — NOT a bare `CLAUDE_CODE`, so keep both spellings or the strict checks
// silently stop running under Claude Code.
const isAgent =
  process.env.AGENT === "1" ||
  process.env.OPENCODE === "1" ||
  !!process.env.OPENCODE_SESSION ||
  !!process.env.CLAUDE_CODE ||
  !!process.env.CLAUDECODE;

/** @type {import('lint-staged').Configuration} */
const baseConfig = {
  "*": ["oxfmt --no-error-on-unmatched-pattern"],
};

/** @type {import('lint-staged').Configuration} */
const agentConfig = {
  "*": [
    ...(baseConfig["*"] || []),
    // using a function which ignores args (filepaths) means *don't* append the filepaths to the command
    () => "pnpm typecheck",
    // if tests prove slow, we could do smart dependency tracking to only run tests for changed files
    () => "pnpm test",
    () => "pnpm lint:fix",
  ],
};

module.exports = {
  ...baseConfig,
  ...(isAgent && agentConfig),
  ...localConfig,
};
