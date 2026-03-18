import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { embeddedNodeAppVitePlugin } from "@iterate-com/shared/apps/embedded-node-app-vite-plugin";
import { defineConfig } from "vite";
import { createExampleNodeApp } from "./src/node/create-app.ts";

export default defineConfig({
  // new in vite 8 - replaces vite-tsconfig-paths
  resolve: {
    tsconfigPaths: true,
  },
  // new in vite 8 - prints browser errors in server stdout
  server: {
    forwardConsole: true,
  },
  plugins: [
    embeddedNodeAppVitePlugin({
      createApp: createExampleNodeApp,
    }),
    tanstackStart({
      srcDirectory: "src/frontend",
    }),
    viteReact(),
    tailwindcss(),
  ],
});
