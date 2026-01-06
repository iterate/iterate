import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import alchemy from "alchemy/cloudflare/tanstack-start";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { devtools } from "@tanstack/devtools-vite";

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
    allowedHosts: [".dev.iterate.com"],
  },
  preview: {
    port: 5174,
  },
  plugins: [
    devtools(),
    {
      name: "os2:force-vite-public-url",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const publicURL = process.env.VITE_PUBLIC_URL;
          if (!publicURL || !req.headers.host) return next();
          const targetURL = new URL(publicURL);
          if (
            req.headers.host.split(":")[0] !== targetURL.hostname &&
            !targetURL.host.startsWith("localhost")
          ) {
            const redirectURL = `${targetURL.origin}${req.url}`;
            res.writeHead(302, { Location: redirectURL });
            res.end();
            return;
          }
          return next();
        });
      },
    },
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
