import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { sourceCommit, startAppWorkerConfig } from "../../scripts/lib/start-app.ts";
import { kit } from "./scripts/app.ts";

export default defineConfig({
  // the installers pin the packages this commit published (@iterate-com/agents, @iterate-com/voice)
  define: { "import.meta.env.VITE_SOURCE_COMMIT": JSON.stringify(sourceCommit()) },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      config: startAppWorkerConfig(kit, process.env.CLOUDFLARE_ENV),
    }),
    tanstackStart({
      router: { addExtensions: true, semicolons: true, quoteStyle: "double" },
      importProtection: { behavior: "error" },
    }),
    viteReact(),
    tailwindcss(),
  ],
});
