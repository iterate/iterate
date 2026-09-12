import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { writeWranglerConfig } from "./scripts/generate-wrangler-config.ts";

writeWranglerConfig();
export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    {
      name: "notes:emitted-wrangler-config",
      closeBundle() {
        const path = "dist/server/wrangler.json";
        if (!existsSync(path)) return;
        // Vite's older Wrangler still emits the removed default field.
        const { legacy_env: _removed, ...config } = JSON.parse(readFileSync(path, "utf8"));
        writeFileSync(path, JSON.stringify(config));
      },
    },
    tanstackStart({
      router: { addExtensions: true, semicolons: true, quoteStyle: "double" },
      importProtection: { behavior: "error" },
    }),
    viteReact(),
  ],
});
