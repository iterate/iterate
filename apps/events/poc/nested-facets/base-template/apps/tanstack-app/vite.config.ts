import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), tanstackStart(), react()],
});
