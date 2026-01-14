let localConfig = {};
try {
  localConfig = require("./lint-staged.local.cjs");
} catch {
  // no problem
}

module.exports = {
  "*": ["prettier --write --ignore-unknown"],
  ...localConfig,
};
