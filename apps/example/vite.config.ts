import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import alchemy from "alchemy/cloudflare/tanstack-start";
import { defineConfig } from "vite";

// Bind dual-stack by default so both localhost (::1) and 127.0.0.1 work.
const host = process.env.HOST ?? "::";
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
    // Just a thinly wrapped cloudflare plugin that picks up the
    // .alchemy/local/wrangler.jsonc that alchemy.run.ts made
    alchemy(),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
    // this has a bug where it doesn't work in git worktrees - will sort later
    // await posthogSourcemaps({
    //   apiKey: process.env.POSTHOG_PERSONAL_API_KEY,
    //   projectId: process.env.POSTHOG_PROJECT_ID,
    //   releaseName: manifest.slug,
    //   releaseVersion: "latest",
    // }),
  ],
});
