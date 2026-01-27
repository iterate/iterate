import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["./iterate.config.ts"],
  bundle: true,
  outfile: "dist/index.js",
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: true,
  external: ["better-sqlite3"], // Native module - don't bundle
  keepNames: true,
});

console.log("Build complete: dist/index.js");
