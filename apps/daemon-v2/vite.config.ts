import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { posthogSourcemaps } from "@iterate-com/shared/posthog/vite-plugin";
import { defineConfig } from "vite";
import manifest from "./src/app.ts";

const host = process.env.HOST ?? "localhost";
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
  },
  plugins: [
    devtools(), // must be first
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
    await posthogSourcemaps({
      apiKey: process.env.POSTHOG_PERSONAL_API_KEY,
      projectId: process.env.POSTHOG_PROJECT_ID,
      releaseName: manifest.slug,
      releaseVersion: "latest",
    }),
  ],
});
