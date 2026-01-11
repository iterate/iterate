import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import viteTsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

const config = defineConfig({
  server: {
    strictPort: false,
  },
  plugins: [
    devtools({
      eventBusConfig: {
        // Port 0 enables auto-assigned port (default behavior)
        port: 0,
      },
    }),
    nitro({
      preset: "node_server",
      output: {
        dir: "dist",
      },
    }),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});

export default config;
