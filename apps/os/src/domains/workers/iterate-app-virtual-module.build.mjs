// Bundle the worker-side `iterate/app` primitives (Cap'n Web hosting plus
// LiveState) into the virtual module injected into every dynamic worker.
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const appEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../packages/iterate/src/app.ts",
);

const result = await esbuild.build({
  bundle: true,
  conditions: ["workerd", "worker", "import"],
  entryPoints: [appEntry],
  external: ["cloudflare:workers"],
  format: "esm",
  legalComments: "none",
  mainFields: ["module", "main"],
  platform: "neutral",
  plugins: [
    {
      name: "externalize-capnweb-fork",
      setup(build) {
        build.onResolve({ filter: /^capnweb$/ }, () => ({
          external: true,
          path: "@iterate-com/capnweb",
        }));
      },
    },
  ],
  write: false,
});

process.stdout.write(result.outputFiles[0].text);
