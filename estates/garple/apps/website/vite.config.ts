import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  build: {
    target: "esnext",
  },
  server: {
    port: 3500,
  },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
    }),
  ],
});
