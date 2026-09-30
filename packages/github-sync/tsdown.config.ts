import { defineConfig } from "tsdown";

// One neutral ES module per export. `iterate` and `zod` stay imports: a loaded worker binds them to
// the platform's own modules (core/os context/module-resolution.ts).
export default defineConfig({
  entry: { index: "src/index.ts", install: "src/install.ts" },
  format: "esm",
  fixedExtension: true,
  platform: "neutral",
  target: "es2022",
  deps: { neverBundle: ["cloudflare:workers", "@cloudflare/workers-types"] },
  dts: true,
  clean: true,
});
