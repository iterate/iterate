import { defineConfig } from "tsdown";

// One neutral ES module per export. `iterate` and `zod` stay imports: a loaded worker binds them to
// the platform's own modules (core/os context/module-resolution.ts); yjs and diff are the package's
// npm dependencies, which the loader fetches from esm.sh. node-diff3 is bundled: esm.sh builds it
// from its `browser` export, an IIFE, whose only export is `default` (no `diff3Merge`).
export default defineConfig({
  entry: {
    index: "src/index.ts",
    install: "src/install.ts",
    frames: "src/frames.ts",
    comments: "src/comments.ts",
    anchor: "src/anchor.ts",
  },
  format: "esm",
  fixedExtension: true,
  platform: "neutral",
  target: "es2022",
  deps: {
    neverBundle: ["cloudflare:workers", "@cloudflare/workers-types"],
    alwaysBundle: ["node-diff3"],
  },
  dts: true,
  clean: true,
});
