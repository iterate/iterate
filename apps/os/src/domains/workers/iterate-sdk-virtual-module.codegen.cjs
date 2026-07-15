const path = require("node:path");

/**
 * Lint-codegen preset (see iterate-sdk-virtual-module.generated.ts): compiles
 * packages/iterate/src/sdk.ts and its runtime dependencies to plain JavaScript
 * — the dynamic-worker bundler loads virtual modules with esbuild's "js"
 * loader, so TS syntax and relative imports cannot ride along — and embeds it
 * as the string worker-loader.ts injects into every dynamic worker build.
 * Drift between the SDK source and the embed is a fixable `codegen/codegen`
 * lint error.
 */
exports.iterateSdkVirtualModule = ({ meta }) => {
  const sdkPath = path.resolve(
    path.dirname(meta.filename),
    "../../../../../packages/iterate/src/sdk.ts",
  );
  const esbuild = require("esbuild");
  const result = esbuild.buildSync({
    entryPoints: [sdkPath],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "import"],
    mainFields: ["module", "main"],
    external: ["cloudflare:workers"],
    target: "es2022",
    minify: true,
    legalComments: "none",
    sourcemap: false,
  });
  const code = result.outputFiles[0].text;
  return `export const ITERATE_SDK_VIRTUAL_MODULE = ${JSON.stringify(code)};`;
};
