// build-docs.mjs — build the framework-free Docs browser page. The processor remains authored in
// examples/docs/processor.ts; esbuild turns that source plus its real Yjs dependency into literal
// worker modules. `processor.js` stays external because the platform injects that SDK at load time.

import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const processor = await build({
  entryPoints: ["examples/docs/processor.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["./processor.js", "./yjs.js"],
  write: false,
});
const yjs = await build({
  entryPoints: ["yjs"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
});
const page = await build({
  entryPoints: ["src/client/docs.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  define: {
    DOCS_PROCESSOR_SOURCE: JSON.stringify(processor.outputFiles[0].text),
    DOCS_YJS_MODULE: JSON.stringify(yjs.outputFiles[0].text),
  },
  write: false,
});
const shell = readFileSync("src/client/docs.html", "utf8");
// Function replacement preserves literal `$&` / `$'` sequences in minified code. Escape the one
// HTML parser sentinel too: a dependency may contain `</script>` inside a string or comment.
const html = shell.replace("__DOCS_BUNDLE__", () =>
  page.outputFiles[0].text.replaceAll("</script", "<\\/script"),
);
let previous;
try {
  previous = readFileSync("public/docs.html", "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (previous !== html) writeFileSync("public/docs.html", html);
console.log(`docs.html: ${(page.outputFiles[0].text.length / 1024).toFixed(1)} KiB`);
