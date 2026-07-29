import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { writeWranglerConfig } from "./scripts/generate-wrangler-config.ts";

writeWranglerConfig();

export default defineConfig({
  server: {
    allowedHosts: true,
  },
  preview: {
    allowedHosts: true,
  },
  plugins: [
    tailwindcss(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({
      router: {
        routeTreeFileHeader: [
          "/* eslint-disable */",
          "// @ts-nocheck",
          "// noinspection JSUnusedGlobalSymbols",
          "// TanStack Router generates the `as any` route-update assertions below because",
          "// the route IDs are registered by the later FileRoutesByPath declaration; the",
          "// generated declaration makes those otherwise-unrepresentable assertions safe.",
        ],
      },
    }),
    viteReact(),
  ],
});
