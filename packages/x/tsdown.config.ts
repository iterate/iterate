import { defineConfig } from "tsdown";

// One neutral ES module per export. `iterate` and `zod` stay imports: a loaded worker binds them to
// the platform's own modules (apps/os context/module-resolution.ts).
export default defineConfig({
  entry: { client: "src/client.ts", bot: "src/bot.ts", install: "src/install.ts" },
  format: "esm",
  fixedExtension: true,
  platform: "neutral",
  target: "es2022",
  deps: { neverBundle: ["cloudflare:workers", "@cloudflare/workers-types"] },
  dts: true,
  clean: true,
});
