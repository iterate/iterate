let localConfig = {};
try {
  localConfig = require("./lint-staged.local.cjs");
} catch {
  // no problem
}

// Stricter checks for coding agents (Claude Code, OpenCode, Cursor, etc.)
// Agents set AGENT=1 or similar env vars
const isAgent = process.env.AGENT === "1" || process.env.OPENCODE === "1";

const baseConfig = {
  "*": ["prettier --write --ignore-unknown"],
};

const agentConfig = {
  "*": [
    ...(baseConfig["*"] || []),
    // using a function which ignores args (filepaths) means *don't* append the filepaths to the command
    () => "pnpm typecheck",
    // if tests prove slow, we could do smart dependency tracking to only run tests for changed files
    () => "pnpm test",
    "eslint --fix --max-warnings 0",
  ],
};

module.exports = {
  ...baseConfig,
  ...(isAgent && agentConfig),
  ...localConfig,
};
