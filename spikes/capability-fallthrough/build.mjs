// Bundle the workers into self-contained ESM modules workerd can run. capnweb's
// workers build imports only `cloudflare:workers` (a workerd built-in) — keep it external;
// everything else (capnweb, capability-host.mjs, graph.mjs) inlines.

import esbuild from "esbuild";

const common = {
  bundle: true,
  format: "esm",
  platform: "browser",
  conditions: ["workerd", "worker", "browser", "import", "default"],
  external: ["cloudflare:workers"],
  logLevel: "warning",
};

await esbuild.build({ ...common, entryPoints: ["gateway.mjs"], outfile: ".built/gateway.js" });
await esbuild.build({ ...common, entryPoints: ["peer.mjs"], outfile: ".built/peer.js" });
console.log("built .built/gateway.js + .built/peer.js");
