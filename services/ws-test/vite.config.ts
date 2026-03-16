import { resolve } from "node:path";
import { defineConfig } from "vite";
import devServer from "@hono/vite-dev-server";
import nodeAdapter from "@hono/vite-dev-server/node";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { viteOrpcWebSocketPlugin } from "./src/server/vite-orpc-websocket-plugin.ts";

const clientBuild = {
  outDir: "dist/client",
  copyPublicDir: true,
  emptyOutDir: true,
  rollupOptions: {
    input: resolve(__dirname, "src/entry-client.tsx"),
    output: {
      entryFileNames: "static/[name].js",
      chunkFileNames: "static/[name]-[hash].js",
      assetFileNames: "static/[name]-[hash][extname]",
    },
  },
  manifest: true,
};

const serverBuild = {
  outDir: "dist/server",
  ssrEmitAssets: false,
  copyPublicDir: false,
  emptyOutDir: false,
  rollupOptions: {
    input: resolve(__dirname, "src/entry-server.ts"),
    output: {
      entryFileNames: "index.js",
      chunkFileNames: "assets/[name]-[hash].js",
      assetFileNames: "assets/[name]-[hash][extname]",
    },
  },
  ssr: true,
};

export default defineConfig(({ command, mode }) => ({
  plugins: [
    ...(command === "serve"
      ? [
          devServer({
            adapter: nodeAdapter,
            entry: "./src/server.ts",
            injectClientScript: false,
          }),
        ]
      : []),
    tanstackRouter({ target: "react" }),
    viteReact(),
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
    ...(command === "serve" ? [viteOrpcWebSocketPlugin()] : []),
  ],
  build: mode === "client" ? clientBuild : serverBuild,
  server: {
    host: true,
    port: process.env.PORT?.trim() ? Number(process.env.PORT) : 0,
    strictPort: Boolean(process.env.PORT?.trim()),
  },
}));
