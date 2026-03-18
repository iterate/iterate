import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart({
      spa: { enabled: true },
      vite: { installDevServerMiddleware: true },
    }),
    viteReact(),
  ],
  optimizeDeps: {
    exclude: ["cpu-features", "ssh2", "@docker/node-sdk"],
  },
  server: {
    allowedHosts: true,
    watch: {
      ignored: ["**/routeTree.gen.ts"],
    },
  },
});
