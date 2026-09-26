import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { startAppWorkerConfig } from "../../scripts/lib/start-app.ts";
import { notes } from "./scripts/app.ts";

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      config: startAppWorkerConfig(notes, process.env.CLOUDFLARE_ENV),
    }),
    tanstackStart({
      router: { addExtensions: true, semicolons: true, quoteStyle: "double" },
      importProtection: { behavior: "error" },
    }),
    viteReact(),
    tailwindcss(),
  ],
  experimental: {
    // A chunk's preloaded dependencies resolve beside it, not at the origin's root: a proxied Notes
    // serves its chunks under a base path (src/base-path.ts). Only the browser's scripts: a `?url`
    // stays a root path that the page prefixes itself, the same in the server render and the browser.
    renderBuiltUrl: (filename, { hostType, ssr }) =>
      !ssr && hostType === "js" && filename.endsWith(".js") ? { relative: true } : undefined,
  },
});
