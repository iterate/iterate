import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import alchemy from "alchemy/cloudflare/tanstack-start";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { devtools } from "@tanstack/devtools-vite";
import { vitePublicUrl } from "@iterate-com/shared/force-public-url-vite-plugin";
import viteTsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  build: {
    sourcemap: true,
    minify: "terser",
    terserOptions: {
      mangle: false,
    },
  },
  server: {
    cors: false,
    strictPort: false,
    allowedHosts: ["host.docker.internal"],
  },
  plugins: [
    {
      name: "iterate-os-banner",
      configureServer(server) {
        const _printUrls = server.printUrls;
        server.printUrls = () => {
          server.config.logger.info("\n  iterate os server ready\n");
          _printUrls();
        };
      },
    },
    vitePublicUrl(),
    devtools({
      eventBusConfig: {
        // Port 0 enables auto-assigned port (default behavior)
        port: 0,
      },
    }),
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    alchemy(),
    tailwindcss(),
    tanstackStart({
      srcDirectory: "./app",
      router: {
        addExtensions: true,
        virtualRouteConfig: "./app/routes.ts",
      },
    }),
    viteReact(),
  ],
  define: {
    "import.meta.vitest": "undefined",
  },
});
