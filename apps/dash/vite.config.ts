import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { startAppWorkerConfig } from "../../scripts/lib/start-app.ts";
import { dash } from "./scripts/app.ts";

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      config: startAppWorkerConfig(dash, process.env.CLOUDFLARE_ENV),
    }),
    tanstackStart({
      router: { addExtensions: true, semicolons: true, quoteStyle: "double" },
      importProtection: { behavior: "error" },
    }),
    viteReact(),
    tailwindcss(),
  ],
});
