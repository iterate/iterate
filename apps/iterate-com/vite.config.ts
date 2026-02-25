import { defineConfig } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

const allowedHosts = [
  "host.docker.internal",
  ".localhost",
  ".iterate.localhost",
  ".local.iterate.town",
  ".iterate.com",
  ".iterate.app",
  ".iterate-dev.com",
  ".iterate-dev.app",
];

export default defineConfig({
  server: {
    port: 3000,
    strictPort: false,
    allowedHosts,
  },
  preview: {
    allowedHosts,
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
