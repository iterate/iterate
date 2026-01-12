import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import viteTsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

const config = defineConfig({
  base: "./",
  server: {
    strictPort: false,
  },
  plugins: [
    devtools({
      eventBusConfig: {
        port: 42070,
      },
    }),
    nitro({
      preset: "node-server",
      serverDir: "server",
      output: {
        dir: "dist",
      },
      features: {
        websocket: true,
      },
    }),
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});

export default config;
