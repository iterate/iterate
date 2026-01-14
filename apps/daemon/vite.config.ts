import path from "node:path";
import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import viteTsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import cloudflareTunnel from "vite-plugin-cloudflare-tunnel";

const appName = path.basename(process.cwd());
const stage =
  process.env.STAGE ?? (process.env.ITERATE_USER ? `dev-${process.env.ITERATE_USER}` : undefined);
const cloudflareTunnelHostname =
  process.env.DEV_TUNNEL && stage ? `${stage}-${appName}.dev.iterate.com` : null;

export default defineConfig({
  // Use relative paths for assets so they work when proxied at any base path
  // The proxy injects <base href="..."> which makes relative URLs resolve correctly
  base: "./",
  plugins: [
    cloudflareTunnel({
      enabled: !!cloudflareTunnelHostname,
      hostname: cloudflareTunnelHostname ?? "",
      tunnelName: `${stage}-${appName}`,
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      ssl: "*.dev.iterate.com",
      cleanup: { autoCleanup: false },
    }),
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
    allowedHosts: [".dev.iterate.com"],
    proxy: {
      "/api": {
        target: `http://localhost:3001`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
