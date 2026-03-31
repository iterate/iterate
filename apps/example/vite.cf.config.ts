import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import alchemy from "alchemy/cloudflare/tanstack-start";
import { defineConfig } from "vite";

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
  },
  plugins: [
    devtools(), // must be first
    // Temporarily disabled: PostHog source map upload fails in this worktree
    // layout because the CLI cannot determine the current git branch.
    alchemy(),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
  ],
});
