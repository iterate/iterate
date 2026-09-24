let localConfig = {};
try {
  localConfig = require("./lint-staged.local.cjs");
} catch {
  // no problem
}

// Stricter checks for coding agents. The one list of agent markers is the iterate CLI's; Node loads
// the .ts file with its built-in type stripping.
const { isCodingAgent } = require("./packages/iterate/src/coding-agent.ts");
const isAgent = isCodingAgent(process.env);

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
    // applies fixes, then fails on any warning or unused disable directive left, as CI's `pnpm lint` does
    () => "pnpm lint:fix --deny-warnings --report-unused-disable-directives-severity error",
  ],
};

module.exports = {
  ...baseConfig,
  ...(isAgent && agentConfig),
  ...localConfig,
};
