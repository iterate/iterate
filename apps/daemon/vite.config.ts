// todo: consider deleting this/consolidating into apps/os2/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import devServer from "@hono/vite-dev-server";

export default defineConfig({
  plugins: [
    react(),
    devServer({
      // Use the new agent-wrapper backend
      entry: "./index-new.ts",
      exclude: [
        // Only let Hono handle /agents, /platform, /edge, /streams - exclude everything else
        /^\/(?!agents|platform|edge|streams).*/,
        /^\/@.+$/,
      ],
    }),
  ],
  build: {
    target: "esnext",
    outDir: "dist",
  },
  // SPA fallback for /ui/* routes
  appType: "spa",
});
