import { defineConfig } from "tsdown";

// One neutral ES module per export. `iterate`, `zod` and `cloudflare:workers` stay imports: a loaded
// worker binds them to the platform's own modules (apps/os context/module-resolution.ts).
export default defineConfig({
  entry: {
    index: "src/index.ts",
    install: "src/install.ts",
    contract: "src/contract.ts",
    processor: "src/processor.ts",
    "codemode-format": "src/codemode-format.ts",
    "system-prompt": "src/system-prompt.ts",
    "ai-transport-source": "src/ai-transport-source.ts",
  },
  format: "esm",
  fixedExtension: true,
  platform: "neutral",
  target: "es2022",
  deps: { neverBundle: ["cloudflare:workers", "@cloudflare/workers-types"] },
  dts: true,
  clean: true,
});
