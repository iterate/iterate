import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { sourceCommit } from "../../scripts/lib/start-app.ts";
import { startAppVitePlugins } from "../../scripts/lib/start-app-vite.ts";
import { docs } from "./scripts/app.ts";

export default defineConfig({
  // a doc's processors run the @iterate-com/docs this commit published
  define: { "import.meta.env.VITE_SOURCE_COMMIT": JSON.stringify(sourceCommit()) },
  plugins: startAppVitePlugins(
    docs,
    { cloudflare, tanstackStart, viteReact, tailwindcss },
    // The router's paths never carry Vite's `base`: Docs routes under the page's base path itself
    // (packages/ui/src/apps/base-path.ts), and a dev server's `--base` (README.md) moves only its module URLs and its
    // HMR socket.
    { basepath: "" },
  ),
  experimental: {
    // A chunk's preloaded dependencies resolve beside it, not at the origin's root: a proxied Docs
    // serves its chunks under a base path (packages/ui/src/apps/base-path.ts). Only the browser's scripts: a `?url`
    // stays a root path that the page prefixes itself, the same in the server render and the browser.
    renderBuiltUrl: (filename, { hostType, ssr }) =>
      !ssr && hostType === "js" && filename.endsWith(".js") ? { relative: true } : undefined,
  },
});
