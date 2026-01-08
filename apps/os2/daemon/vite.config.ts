// todo: consider deleting this/consolidating into apps/os2/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import devServer from "@hono/vite-dev-server";

export default defineConfig({
  plugins: [
    react(),
    devServer({
      entry: "./index.ts",
      exclude: [
        // Only let Hono handle /agents, /platform, /edge - exclude everything else
        /^\/(?!agents|platform|edge).*/,
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
