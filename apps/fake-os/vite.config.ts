import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.HOST ?? "127.0.0.1";
const port = process.env.PORT ? Number(process.env.PORT) : 3100;

export default defineConfig({
  build: {
    sourcemap: true,
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    host,
    port,
    allowedHosts: true,
    watch: {
      ignored: ["**/routeTree.gen.ts"],
    },
  },
  plugins: [devtools(), tanstackStart(), viteReact(), tailwindcss()],
  optimizeDeps: {
    exclude: ["cpu-features", "ssh2", "@docker/node-sdk"],
  },
  ssr: {
    external: ["@docker/node-sdk", "ssh2", "cpu-features"],
  },
});
