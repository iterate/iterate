import { resolve } from "node:path";
import devServer, { defaultOptions } from "@hono/vite-dev-server";
import nodeAdapter from "@hono/vite-dev-server/node";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

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
    input: resolve(__dirname, "src/entry-server.tsx"),
    output: {
      entryFileNames: "index.js",
      chunkFileNames: "assets/[name]-[hash].js",
      assetFileNames: "assets/[name]-[hash][extname]",
    },
  },
  ssr: true,
};

export default defineConfig(({ mode }) => ({
  plugins: [
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    viteReact(),
    tailwindcss(),
    devServer({
      adapter: nodeAdapter,
      entry: "src/entry-server.tsx",
      injectClientScript: false,
      exclude: [/^\/src\/.+/, ...defaultOptions.exclude],
    }),
  ] as unknown as PluginOption[],
  build: mode === "client" ? clientBuild : serverBuild,
  ssr: {
    external: ["@lydell/node-pty", "@xterm/addon-serialize", "@xterm/headless", "schematch"],
  },
  optimizeDeps: {
    exclude: ["cpu-features", "ssh2", "@docker/node-sdk", "web-vitals"],
    include: ["react", "react-dom", "@tanstack/react-router"],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  server: {
    allowedHosts: true,
    host: "127.0.0.1",
    forwardConsole: true,
    port: process.env.PORT?.trim() ? Number(process.env.PORT) : 0,
    strictPort: Boolean(process.env.PORT?.trim()),
    watch: {
      ignored: ["**/routeTree.gen.ts"],
    },
  },
}));
