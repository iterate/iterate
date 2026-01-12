import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import viteTsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

const config = defineConfig(() => ({
  plugins: [
    devtools(),
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
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
    tanstackStart(),
    viteReact(),
  ],
}));

export default config;
