const fs = require("node:fs");
const path = require("node:path");

/**
 * Lint-codegen preset (see iterate-sdk-virtual-module.generated.ts): compiles
 * packages/iterate/src/sdk.ts to plain JavaScript — the bundler loads virtual
 * modules with esbuild's "js" loader, so TS syntax cannot ride along — and
 * embeds it as the string worker-loader.ts injects into every dynamic worker
 * build. Drift between the sdk source and the embed is a fixable
 * `codegen/codegen` lint error.
 */
exports.iterateSdkVirtualModule = ({ meta }) => {
  const sdkPath = path.resolve(
    path.dirname(meta.filename),
    "../../../../../packages/iterate/src/sdk.ts",
  );
  const source = fs.readFileSync(sdkPath, "utf8");
  const esbuild = require("esbuild");
  const { code } = esbuild.transformSync(source, { format: "esm", loader: "ts" });
  return `export const ITERATE_SDK_VIRTUAL_MODULE = ${JSON.stringify(code)};`;
};
