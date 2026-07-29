import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { writeWranglerConfig } from "./scripts/generate-wrangler-config.ts";

// wrangler.jsonc is generated and gitignored. Refresh it before the Cloudflare
// plugin reads it so local dev and deploy builds always agree with envs.ts.
writeWranglerConfig();

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    tailwindcss(),
    viteReact(),
  ],
});
