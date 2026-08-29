// The expo-updates runtime fingerprint decides which JS updates an installed
// binary will accept. By default it hashes package.json scripts, so editing
// e.g. `update:preview` would bump the runtime and strand every installed
// build on stale JS despite zero native changes (bitten on PR #2410). Scripts
// never ship in the bundle — skip them. Dependencies still count.
//
// eas.json is ignored outright. CI bakes a PR's update channel into its native
// build by writing the build profile's `channel` before calling `eas build`
// (eas-cli 21.0.1 has no --channel flag, and the channel has to reach the
// binary), and eas.json is otherwise a plain fingerprint source — so without
// this, a PR's build would get its own runtime version and would refuse the
// very updates that PR publishes. Verified: with this ignore, changing a
// profile's channel leaves the fingerprint byte-identical; without it, it
// moves (fdfdff89 -> 793605ca).
//
// The trade is that eas.json's other fields (distribution, developmentClient,
// simulator) stop bumping the runtime too. Those shape which BINARY you get,
// not which JS a binary can run, and each already lives in its own profile on
// its own channel — so nothing that decides update compatibility is lost.
/** @type {import('@expo/fingerprint').Config} */
const config = {
  sourceSkips: ["PackageJsonScriptsAll"],
  ignorePaths: ["eas.json"],
};
module.exports = config;
