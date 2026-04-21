import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Bind dual-stack by default so both localhost (::1) and 127.0.0.1 work.
const host = process.env.HOST ?? "::";
const port = process.env.PORT ? Number(process.env.PORT) : 5173;

// alchemy.run.ts writes the wrangler.jsonc describing all bindings (AI, DOs,
// services, worker loaders, vars). We point the stock Cloudflare Vite plugin at
// that file so local dev uses upstream Cloudflare/Miniflare's remote-bindings
// pipeline (which handles AI correctly) instead of Alchemy's custom proxy.
const appRoot = path.dirname(fileURLToPath(import.meta.url));
const workerConfigPath = path.join(appRoot, ".alchemy", "local", "wrangler.jsonc");
const miniflarePersistPath = path.join(appRoot, "..", "..", ".alchemy", "miniflare");

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
    watch: {
      ignored: ["**/.alchemy/**"],
    },
  },
  plugins: [
    devtools(), // must be first
    cloudflare({
      configPath: workerConfigPath,
      persistState: { path: miniflarePersistPath },
      viteEnvironment: { name: "ssr" },
    }),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
    // Temporarily disabled: PostHog source map upload fails in this worktree
    // layout because the CLI cannot determine the current git branch.
  ],
});
