import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import alchemy from "alchemy/cloudflare/tanstack-start";
import { defineConfig } from "vite";

const host = process.env.HOST ?? "::";

export default defineConfig({
  build: {
    sourcemap: true,
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    // Bind dual-stack by default so both localhost (::1) and 127.0.0.1 work.
    host,
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
  },
  plugins: [
    devtools(), // must be first
    // Thin Cloudflare plugin that picks up `.alchemy/local/wrangler.jsonc` from `alchemy.run.ts`
    alchemy(),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
    // Temporarily disabled: PostHog source map upload fails in this worktree
    // layout because the CLI cannot determine the current git branch.
  ],
});
