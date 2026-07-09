// The one esbuild recipe for the `iterate/sdk` runtime virtual module, shared
// by the generator script and the freshness test so the two can never drift.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Bundle packages/iterate/src/sdk.ts to one self-contained workerd ESM module. */
export async function buildIterateSdkRuntimeModule(): Promise<string> {
  const entry = fileURLToPath(new URL("../../../packages/iterate/src/sdk.ts", import.meta.url));
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    // Match the dynamic-worker build pipeline (materialize.ts): workerd-
    // flavored package entries. Resolves the workspace capnweb (the fork the
    // platform itself runs) rather than whatever npm would serve.
    conditions: ["workerd", "worker", "import"],
    mainFields: ["module", "main"],
    // Runtime modules workerd provides to every dynamic worker.
    external: ["cloudflare:workers"],
    target: "es2022",
    minify: true,
    legalComments: "none",
    sourcemap: false,
  });
  const output = result.outputFiles?.[0]?.text;
  if (output === undefined || output.length === 0) {
    throw new Error("esbuild produced no output for the iterate/sdk runtime bundle");
  }
  return output;
}
