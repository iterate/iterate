import { defineConfig } from "tsdown";

// One neutral ES module per export. `iterate`, `zod` and `cloudflare:workers` stay imports: a loaded
// worker binds them to the platform's own modules (apps/os context/module-resolution.ts), and
// `@iterate-com/agents` and `pako` load as this package's dependencies. The Markdown the worker
// sends and the workspace-only `@iterate-com/shared` are inlined.
export default defineConfig({
  entry: { index: "src/index.ts", install: "src/install.ts" },
  format: "esm",
  fixedExtension: true,
  platform: "neutral",
  target: "es2022",
  loader: { ".md": "text" },
  deps: { neverBundle: ["cloudflare:workers", "@cloudflare/workers-types"] },
  dts: true,
  clean: true,
});
