let localConfig = {};
try {
  localConfig = require("./lint-staged.local.cjs");
} catch {
  // no problem
}

/**
 * The pre-commit hook formats the staged files and nothing else, for people and coding agents
 * alike. Typecheck, lint and tests run in CI and on demand: run on every agent commit, they ran each
 * parallel agent's whole suite at once on one machine.
 *
 * @type {import('lint-staged').Configuration}
 */
module.exports = {
  "*": ["oxfmt --no-error-on-unmatched-pattern"],
  ...localConfig,
};
