// Bundle the public LiveState runtime as the `iterate/live-state` virtual
// module injected into every dynamic worker.
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const liveStateEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../packages/iterate/src/live-state.ts",
);

const result = await esbuild.build({
  bundle: true,
  conditions: ["workerd", "worker", "import"],
  entryPoints: [liveStateEntry],
  external: ["cloudflare:workers"],
  format: "esm",
  legalComments: "none",
  mainFields: ["module", "main"],
  platform: "neutral",
  write: false,
});

process.stdout.write(result.outputFiles[0].text);
