import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { mountNodeApi } from "@iterate-com/shared/apps/mount-node-api-vite-plugin";
import { defineConfig } from "vite";
import { exampleNodeApi } from "./src/node.ts";

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
    mountNodeApi({
      handler: exampleNodeApi,
    }),
    tanstackStart({
      srcDirectory: "src/frontend",
    }),
    viteReact(),
    tailwindcss(),
  ],
});
