const path = require("node:path");

/**
 * Lint-codegen preset (see iterate-processors-virtual-module.generated.ts):
 * bundles packages/iterate/src/processors/index.ts — the stream-processor
 * machinery and its in-package imports (live-state engine, rpc retention) —
 * into ONE plain-JS
 * module, embedded as the string worker-loader.ts injects into every dynamic
 * worker build as `virtualModules["iterate/processors"]`. Unlike the sdk
 * embed (a single dependency-free file, transform only), this is a real
 * esbuild bundle. Platform-owned implementation stays embedded; identity
 * boundaries stay external: the platform's shared Cap'n Web module, the
 * worker's declared zod dependency, and workerd-provided modules. Keeping zod
 * external gives worker-authored schemas and the SDK one class identity. Drift
 * between the package source and the embed is a fixable codegen lint error.
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
    external: ["@iterate-com/capnweb", "cloudflare:workers", "zod"],
    format: "esm",
    legalComments: "none",
    mainFields: ["module", "main"],
    platform: "neutral",
    write: false,
  });
  const code = result.outputFiles[0].text;
  return `export const ITERATE_PROCESSORS_VIRTUAL_MODULE = ${JSON.stringify(code)};`;
};
