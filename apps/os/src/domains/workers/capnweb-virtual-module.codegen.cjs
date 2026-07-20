const path = require("node:path");

/** Bundle Cap'n Web's workerd export into the platform module supplied to
 * dynamic Workers. This keeps project builds network-free. */
exports.capnwebVirtualModule = ({ meta }) => {
  const esbuild = require("esbuild");
  const result = esbuild.buildSync({
    bundle: true,
    conditions: ["workerd", "worker", "import"],
    external: ["cloudflare:workers"],
    format: "esm",
    legalComments: "none",
    mainFields: ["module", "main"],
    platform: "neutral",
    stdin: {
      contents: 'export * from "@iterate-com/capnweb";',
      resolveDir: path.dirname(meta.filename),
      sourcefile: "capnweb-virtual-module.ts",
    },
    write: false,
  });
  const code = result.outputFiles[0].text;
  return `export const CAPNWEB_VIRTUAL_MODULE = ${JSON.stringify(code)};`;
};
