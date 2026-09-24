import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteWranglerConfig } from "./scripts/generate-wrangler-config.ts";

export default defineConfig(({ command }) => ({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      config: viteWranglerConfig(process.env.OS_NEXT_ENV, {
        localDev: command === "serve",
        // scripts/dev.ts sets it from the `--port` it forwards to `vite dev`, which overrides
        // `server.port` below.
        port: process.env.OS_NEXT_DEV_PORT || "8788",
      }),
    }),
    tanstackStart({
      router: { addExtensions: true, semicolons: true, quoteStyle: "double" },
      importProtection: { behavior: "error" },
    }),
    viteReact(),
    tailwindcss(),
  ],
  server: { port: 8788, strictPort: true },
}));
