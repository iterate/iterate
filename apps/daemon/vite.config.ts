import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import viteTsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { cloudflareTunnel } from "@iterate-com/shared/cloudflare-tunnel";

export default defineConfig({
  // Use relative paths for assets so they work when proxied at any base path
  // The proxy injects <base href="..."> which makes relative URLs resolve correctly
  base: "./",
  plugins: [
    cloudflareTunnel(import.meta.dirname),
    devtools(),
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
    tanstackRouter({
      // this plugin generates routeTree.gen.ts while in dev
      target: "react",
      generatedRouteTree: "./client/routeTree.gen.ts",
      routesDirectory: "./client/routes",
      autoCodeSplitting: true,
    }),
    viteReact(),
  ],
  build: {
    outDir: "dist",
  },
  clearScreen: false,
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: `http://localhost:3001`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
