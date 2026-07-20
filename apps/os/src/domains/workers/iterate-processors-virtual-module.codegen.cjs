const path = require("node:path");

/**
 * Lint-codegen preset (see iterate-processors-virtual-module.generated.ts):
 * bundles packages/iterate/src/processors/index.ts — the stream-processor
 * machinery, its in-package imports (live-state engine, rpc retention), and
 * zod — into ONE plain-JS
 * module, embedded as the string worker-loader.ts injects into every dynamic
 * worker build as `virtualModules["iterate/processors"]`. Unlike the sdk
 * embed (a single dependency-free file, transform only), this is a real
 * esbuild bundle. This platform module is self-contained regardless of the
 * project's package.json: every dependency is embedded except the platform's
 * shared Cap'n Web module and workerd-provided modules. Drift between the
 * package source and the embed is a fixable codegen lint error.
 */
exports.iterateProcessorsVirtualModule = ({ meta }) => {
  const entry = path.resolve(
    path.dirname(meta.filename),
    "../../../../../packages/iterate/src/processors/index.ts",
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
  return `export const ITERATE_PROCESSORS_VIRTUAL_MODULE = ${JSON.stringify(code)};`;
};
