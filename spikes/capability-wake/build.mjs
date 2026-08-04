import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["do.mjs"],
  bundle: true,
  format: "esm",
  platform: "browser",
  conditions: ["workerd", "worker", "browser", "import", "default"],
  external: ["cloudflare:workers"],
  outfile: ".built/do.js",
  logLevel: "warning",
});
console.log("built .built/do.js");
