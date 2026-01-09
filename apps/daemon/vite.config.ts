import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import devServer from "@hono/vite-dev-server";

export default defineConfig({
  plugins: [
    react(),
    devServer({
      entry: "./index.ts",
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
  appType: "spa",
});
