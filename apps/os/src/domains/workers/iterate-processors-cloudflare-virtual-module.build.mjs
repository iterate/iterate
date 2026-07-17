// Bundles packages/iterate/src/processors/cloudflare.ts for the
// `iterate/processors/cloudflare` virtual module and prints the code to
// stdout. Invoked as a child process by the sibling codegen preset (.cjs):
// the resolver plugin below needs esbuild's async API, and
// eslint-plugin-codegen presets are synchronous.
//
// The plugin rewrites every import of a PURE src/processors module to the
// `iterate/processors` virtual module so the hosting layer and user worker
// code share ONE copy of each class — load-bearing, not cosmetic: the runner
// reaches private fields of user processor instances
// (StreamProcessor.runnerDriver), and private-field access requires the
// instance to be branded by the SAME class object. The live-state engine +
// rpc retention are inlined here (nothing instance-shares them);
// `cloudflare:workers` and `zod` stay external as in every worker bundle.
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const processorsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../packages/iterate/src/processors",
);
const bundled = new Set(
  ["cloudflare.ts", "stream-processor-registry.ts", "durable-object-processor-durability.ts"].map(
    (name) => path.join(processorsDir, name),
  ),
);

const result = await esbuild.build({
  bundle: true,
  conditions: ["workerd", "worker", "import"],
  entryPoints: [path.join(processorsDir, "cloudflare.ts")],
  external: ["cloudflare:workers", "zod"],
  format: "esm",
  legalComments: "none",
  mainFields: ["module", "main"],
  platform: "neutral",
  plugins: [
    {
      name: "share-pure-processors-module",
      setup(build) {
        build.onResolve({ filter: /^\./ }, (args) => {
          const resolved = path.resolve(args.resolveDir, args.path);
          if (resolved.startsWith(processorsDir) && !bundled.has(resolved)) {
            return { path: "iterate/processors", external: true };
          }
          return null;
        });
      },
    },
  ],
  write: false,
});

process.stdout.write(result.outputFiles[0].text);
