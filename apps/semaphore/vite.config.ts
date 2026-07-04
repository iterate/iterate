import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { writeWranglerConfig } from "./scripts/generate-wrangler-config.ts";

// wrangler.jsonc is generated (gitignored) — refresh it from envs.ts before
// the cloudflare plugin reads it, so dev and build can never see stale config.
writeWranglerConfig();

const host = process.env.HOST ?? "127.0.0.1";
const port = process.env.PORT ? Number(process.env.PORT) : 5173;

export default defineConfig({
  build: {
    sourcemap: true,
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    host,
    port,
    allowedHosts: true,
  },
  plugins: [
    devtools(), // must be first
    // The worker (src/worker.ts) runs in workerd during dev; wrangler.jsonc
    // (generated from the root envs.ts) declares its bindings, and the keys
    // in its `secrets.required` load straight from process.env — which is
    // why `doppler run -- vite dev` needs no .dev.vars file.
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
  ],
});
