import { defineConfig } from "tsdown";

// One neutral ES module per export. `iterate` (`iterate/agents` included), `zod` and
// `cloudflare:workers` stay imports: a loaded worker binds them to the platform's own modules (core/os
// context/module-resolution.ts), and `pako` loads as this package's dependency. The Markdown the
// worker sends is inlined.
export default defineConfig({
  entry: { index: "src/index.ts", install: "src/install.ts", call: "src/call-client.ts" },
  format: "esm",
  fixedExtension: true,
  platform: "neutral",
  target: "es2022",
  tsconfig: "tsconfig.build.json",
  loader: { ".md": "text" },
  deps: { neverBundle: ["cloudflare:workers", "@cloudflare/workers-types"] },
  dts: true,
  clean: true,
});
