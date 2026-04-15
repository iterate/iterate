import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import alchemy from "alchemy/cloudflare/tanstack-start";
import { defineConfig } from "vite";

const host = process.env.HOST ?? "::";

export default defineConfig({
  build: {
    sourcemap: true,
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    host,
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    allowedHosts: true,
  },
  plugins: [devtools(), alchemy(), tanstackStart(), viteReact(), tailwindcss()],
});
