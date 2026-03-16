import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { viteHonoFallthroughPlugin } from "./src/server/vite-plugin.ts";

export default defineConfig({
  plugins: [
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
    viteHonoFallthroughPlugin(),
    tanstackStart({
      spa: { enabled: true },
    }),
    tailwindcss(),
    viteReact(),
  ],
  server: {
    host: true,
    port: process.env.PORT?.trim() ? Number(process.env.PORT) : 0,
    strictPort: Boolean(process.env.PORT?.trim()),
  },
});
