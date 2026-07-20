const path = require("node:path");

exports.iterateLiveStateVirtualModule = ({ meta }) => {
  const entry = path.resolve(
    path.dirname(meta.filename),
    "../../../../../packages/iterate/src/live-state.ts",
  );
  const esbuild = require("esbuild");
  const result = esbuild.buildSync({
    alias: { capnweb: "@iterate-com/capnweb" },
    bundle: true,
    conditions: ["workerd", "worker", "import"],
    entryPoints: [entry],
    external: ["@iterate-com/capnweb", "cloudflare:workers"],
    format: "esm",
    legalComments: "none",
    mainFields: ["module", "main"],
    platform: "neutral",
    write: false,
  });
  const code = result.outputFiles[0].text;
  return `export const ITERATE_LIVE_STATE_VIRTUAL_MODULE = ${JSON.stringify(code)};`;
};
