import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { startAppVitePlugins } from "../../scripts/lib/start-app-vite.ts";
import { admin } from "./scripts/app.ts";

export default defineConfig({
  plugins: startAppVitePlugins(admin, { cloudflare, tanstackStart, viteReact, tailwindcss }),
});
