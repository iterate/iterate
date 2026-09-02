import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import captunVite from "captun/vite";
import { writeWranglerConfig } from "./scripts/generate-wrangler-config.ts";

writeWranglerConfig();

// Local development against a real project: the project's config worker can
// only proxy to an HTTPS origin, so CAPTUN_TUNNEL_NAME exposes this dev
// server as https://<name>.tunnels.iterate.com (HTTP and WebSockets, HMR
// included) — the same plugin and knobs as apps/os. Point the project at it
// with the docs-app-origin KV key (docs/remote-apps.md).
const captunGateway = process.env.CAPTUN_GATEWAY?.trim() || "https://tunnels.iterate.com";
const captunName = process.env.CAPTUN_TUNNEL_NAME?.trim();

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
    ...(captunName
      ? [
          captunVite({
            gateway: captunGateway,
            name: captunName,
            token: process.env.CAPTUN_TOKEN?.trim() || undefined,
          }),
        ]
      : []),
  ],
});
