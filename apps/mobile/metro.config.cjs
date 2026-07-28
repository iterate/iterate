const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

// Watchman's cookie synchronization can time out for this monorepo, delaying
// every start/export by 60 seconds before Metro falls back to its Node crawler.
config.resolver.useWatchman = false;

// Server presets come from the monorepo's canonical envs.ts. Metro otherwise
// refuses to resolve a source file outside apps/mobile.
config.watchFolders = [path.resolve(projectRoot, "../..")];

// Workspace packages are source-linked. Without an explicit singleton rule,
// Metro resolves their development React/TanStack dependencies from the
// package's own node_modules and bundles a second React renderer (currently
// 19.2 beside Expo 54's 19.1). Resolve hook runtimes from the app regardless of
// which workspace source file imported them.
const singletonPackages = new Map(
  ["react", "@tanstack/react-query"].map((name) => [
    name,
    path.dirname(require.resolve(`${name}/package.json`, { paths: [projectRoot] })),
  ]),
);
config.resolver.resolveRequest = (context, moduleName, platform) => {
  for (const [name, directory] of singletonPackages) {
    if (moduleName === name || moduleName.startsWith(`${name}/`)) {
      const subpath = moduleName.slice(name.length).replace(/^\//, "");
      return context.resolveRequest(context, path.join(directory, subpath), platform);
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
