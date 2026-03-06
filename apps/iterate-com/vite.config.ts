import { defineConfig } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  server: {
    port: 3000,
    strictPort: false,
  },
  plugins: [
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    reactRouter(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
  ],
});
