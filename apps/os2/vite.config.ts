import { defineConfig, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import alchemy from "alchemy/cloudflare/tanstack-start";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { devtools } from "@tanstack/devtools-vite";
import cloudflareTunnel from "vite-plugin-cloudflare-tunnel";

const tunnelHost = process.env.CLOUDFLARE_TUNNEL_HOST;

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
    cors: false,
  },
  preview: {
    port: 5174,
  },
  plugins: [
    tunnelHost
      ? cloudflareTunnel({
          hostname: tunnelHost,
          apiToken: process.env.CLOUDFLARE_API_TOKEN,
          port: 5173,
          tunnelName: `os2-${tunnelHost.split(".")[0]}`,
        })
      : null,
    devtools(),
    daemonPlugin(),
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

function daemonPlugin(): Plugin {
  return {
    name: "os2:daemon",
    apply: "serve",
    async configureServer(server) {
      const { getRequestListener } = await import("@hono/node-server");
      const { default: daemonApp } = await import("./daemon/index.ts");

      const honoListener = getRequestListener(daemonApp.fetch);

      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";

        if (!url.startsWith("/daemon")) {
          return next();
        }

        const rewrittenUrl = url.replace(/^\/daemon/, "") || "/";

        const isDaemonUiRoute =
          rewrittenUrl === "/" || rewrittenUrl === "/ui" || rewrittenUrl.startsWith("/ui/");

        if (isDaemonUiRoute) {
          const isStaticAsset = rewrittenUrl.match(/\.[jt]sx?$/);
          if (isStaticAsset) {
            req.url = "/daemon" + rewrittenUrl;
            return next();
          }
          try {
            const fs = await import("node:fs");
            const html = await server.transformIndexHtml(
              url,
              fs.readFileSync(new URL("./daemon/index.html", import.meta.url), "utf-8"),
            );
            res.setHeader("Content-Type", "text/html");
            res.end(html);
            return;
          } catch {
            return next();
          }
        }

        req.url = rewrittenUrl;
        honoListener(req, res);
      });
    },
  };
}
