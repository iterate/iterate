const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

// Server presets come from the monorepo's canonical envs.ts. Metro otherwise
// refuses to resolve a source file outside apps/mobile.
config.watchFolders = [path.resolve(projectRoot, "../..")];

module.exports = config;
