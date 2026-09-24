let localConfig = {};
try {
  localConfig = require("./lint-staged.local.cjs");
} catch {
  // no problem
}

// Stricter checks for coding agents. The one list of agent markers is the iterate CLI's; Node loads
// the .ts file with its built-in type stripping.
const { isCodingAgent } = require("./packages/cli/src/coding-agent.ts");
const isAgent = isCodingAgent(process.env);

/** @type {import('lint-staged').Configuration} */
const baseConfig = {
  "*": ["oxfmt --no-error-on-unmatched-pattern"],
};

/**
 * `command` without the environment git exports to a commit's hooks (GIT_DIR, GIT_INDEX_FILE,
 * GIT_AUTHOR_DATE, …). Tests that build a scratch repository (Kit's firmware-release, the LOC report,
 * the grandfather rule) otherwise run their `git init`/`add`/`commit` against the committing
 * worktree's git directory and index: 32 of their rows failed in every agent commit's hook
 * ("invalid object … Error building trees") and passed everywhere else (2026-09-24).
 */
const withoutCommitEnvironment = (command) =>
  [
    "env",
    ...[
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_PREFIX",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_AUTHOR_DATE",
      "GIT_CONFIG_PARAMETERS",
    ].flatMap((name) => ["-u", name]),
    command,
  ].join(" ");

/** @type {import('lint-staged').Configuration} */
const agentConfig = {
  "*": [
    ...(baseConfig["*"] || []),
    // using a function which ignores args (filepaths) means *don't* append the filepaths to the command
    () => "pnpm typecheck",
    // if tests prove slow, we could do smart dependency tracking to only run tests for changed files
    () => withoutCommitEnvironment("pnpm test"),
    // applies fixes, then fails on any warning or unused disable directive left, as CI's `pnpm lint` does
    () => "pnpm lint:fix --deny-warnings --report-unused-disable-directives-severity error",
  ],
};

module.exports = {
  ...baseConfig,
  ...(isAgent && agentConfig),
  ...localConfig,
};
