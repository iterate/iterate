import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

// Bind dual-stack by default so both localhost (::1) and 127.0.0.1 work.
const host = process.env.HOST ?? "::";
const port = process.env.PORT ? Number(process.env.PORT) : 5173;

export default defineConfig({
  build: {
    sourcemap: true,
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    host,
    port,
    allowedHosts: true,
    // TanStack Router rewrites this generated file during dev; ignoring it here
    // avoids Vite reacting to the generator's own writes.
    watch: {
      ignored: ["**/routeTree.gen.ts"],
    },
  },
  plugins: [
    devtools(), // must be first
    // Nitro needs websocket support enabled in Node dev so routes returning
    // NitroWebSocketResponse actually upgrade instead of hanging.
    nitro({
      features: {
        websocket: true,
      },
    }),
    tanstackStart({
      server: {
        entry: "./entry.node.ts",
      },
    }),
    viteReact(),
    tailwindcss(),
    // this has a bug where it doesn't work in git worktrees - will sort later
    // await posthogSourcemaps({
    //   apiKey: process.env.POSTHOG_PERSONAL_API_KEY,
    //   projectId: process.env.POSTHOG_PROJECT_ID,
    //   releaseName: manifest.slug,
    //   releaseVersion: "latest",
    // }),
  ],
});
