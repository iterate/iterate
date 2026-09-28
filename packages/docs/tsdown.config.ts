import { defineConfig } from "tsdown";

// One neutral ES module per export. `iterate` and `zod` stay imports: a loaded worker binds them to
// the platform's own modules (apps/os context/module-resolution.ts); yjs and the diffs are the
// package's npm dependencies, which the loader resolves.
export default defineConfig({
  entry: { index: "src/index.ts", install: "src/install.ts", frames: "src/frames.ts" },
  format: "esm",
  fixedExtension: true,
  platform: "neutral",
  target: "es2022",
  deps: { neverBundle: ["cloudflare:workers", "@cloudflare/workers-types"] },
  dts: true,
  clean: true,
});
