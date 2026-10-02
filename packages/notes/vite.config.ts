import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { startAppVitePlugins } from "../../scripts/lib/start-app-vite.ts";
import { notes } from "./scripts/app.ts";

export default defineConfig({
  plugins: startAppVitePlugins(
    notes,
    { cloudflare, tanstackStart, viteReact, tailwindcss },
    // The router's paths never carry Vite's `base`: Notes routes under the page's base path itself
    // (packages/ui/src/apps/base-path.ts), and a dev server's `--base` (README) moves only its module URLs and its
    // HMR socket.
    { basepath: "" },
  ),
  experimental: {
    // A chunk's preloaded dependencies resolve beside it, not at the origin's root: a proxied Notes
    // serves its chunks under a base path (packages/ui/src/apps/base-path.ts). Only the browser's scripts: a `?url`
    // stays a root path that the page prefixes itself, the same in the server render and the browser.
    renderBuiltUrl: (filename, { hostType, ssr }) =>
      !ssr && hostType === "js" && filename.endsWith(".js") ? { relative: true } : undefined,
  },
});
