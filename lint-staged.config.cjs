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
  "*.{ts,tsx,mts,cts}": [() => "pnpm typecheck", "eslint --fix --max-warnings 0"],
  "*.{js,jsx,mjs,cjs}": ["eslint --fix --max-warnings 0"],
};

module.exports = {
  ...baseConfig,
  ...(isAgent && agentConfig),
  ...localConfig,
};
