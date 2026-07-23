import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import captunVite from "captun/vite";

export default defineConfig({
  server: {
    // The vessel is served through reverse proxies (a project's config
    // worker, a captun tunnel) whose Host headers vite's default allowlist
    // (localhost / *.localhost / IPs) would 403 — which breaks dev-mode
    // hydration in ways that look like TanStack bugs. Do NOT set
    // server.origin here: it would bake loopback asset URLs into pages
    // viewed from another host.
    allowedHosts: true,
  },
  preview: {
    allowedHosts: true,
  },
  plugins: [
    // Public local URL (HTTP + WS) when CAPTUN_TUNNEL_NAME is set — see the
    // "Developing your app against a live project" section of the platform's
    // remote-apps guide: point a production project's proxy at the tunnel via
    // itx.kv and develop this app against real data.
    ...(process.env.CAPTUN_TUNNEL_NAME?.trim()
      ? [
          captunVite({
            gateway: process.env.CAPTUN_GATEWAY?.trim() || "https://tunnels.iterate.com",
            name: process.env.CAPTUN_TUNNEL_NAME.trim(),
            token: process.env.CAPTUN_TOKEN?.trim() || undefined,
          }),
        ]
      : []),
    // The worker (src/worker.ts, with its TasksBoardDurableObject) runs in
    // workerd during dev; wrangler.jsonc declares the BOARD binding.
    tailwindcss(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    viteReact(),
  ],
});
