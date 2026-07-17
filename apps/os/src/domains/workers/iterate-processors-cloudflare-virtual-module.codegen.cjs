const { execFileSync } = require("node:child_process");
const path = require("node:path");

/**
 * Lint-codegen preset (see the .generated.ts twin): embeds the
 * `iterate/processors/cloudflare` virtual module — the Durable-Object hosting
 * layer (registry + DO durability) bundled with pure-machinery imports
 * rewritten to the `iterate/processors` virtual module. The bundling itself
 * lives in the sibling .build.mjs (it needs esbuild's async plugin API;
 * codegen presets are synchronous), run here as a child process.
 */
exports.iterateProcessorsCloudflareVirtualModule = ({ meta }) => {
  const script = path.resolve(
    path.dirname(meta.filename),
    "./iterate-processors-cloudflare-virtual-module.build.mjs",
  );
  const code = execFileSync(process.execPath, [script], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return `export const ITERATE_PROCESSORS_CLOUDFLARE_VIRTUAL_MODULE = ${JSON.stringify(code)};`;
};
