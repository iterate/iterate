let localConfig = {};
try {
  localConfig = require("./lint-staged.local.cjs");
} catch {
  // no problem
}

module.exports = {
  "*": localConfig["*"] ?? ["prettier --write --ignore-unknown"],
  ...localConfig,
};
