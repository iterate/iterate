import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  build: { sourcemap: true },
  resolve: { tsconfigPaths: true },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      experimental: { newConfig: true },
    }),
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
    tailwindcss(),
  ],
});
