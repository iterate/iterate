// The expo-updates runtime fingerprint decides which JS updates an installed
// binary will accept. By default it hashes package.json scripts, so editing
// e.g. `update:preview` would bump the runtime and strand every installed
// build on stale JS despite zero native changes (bitten on PR #2410). Scripts
// never ship in the bundle — skip them. Dependencies still count.
/** @type {import('@expo/fingerprint').Config} */
const config = {
  sourceSkips: ["PackageJsonScriptsAll"],
};
module.exports = config;
