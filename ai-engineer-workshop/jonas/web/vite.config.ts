import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

// Pattern: apps/events (TanStack Start + Vite + Tailwind v4); Nitro for Node prod.
export default defineConfig({
  build: {
    sourcemap: true,
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    host: process.env.HOST ?? "127.0.0.1",
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
  },
  plugins: [
    tanstackStart({
      spa: {
        enabled: true,
      },
    }),
    nitro(),
    viteReact(),
    tailwindcss(),
  ],
});
