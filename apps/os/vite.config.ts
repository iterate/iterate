import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import alchemy from "alchemy/cloudflare/react-router";

export default defineConfig({
  build: {
    sourcemap: true,
  },
  server: {
    allowedHosts: [".dev.iterate.com"],
  },
  preview: {
    port: 5173,
  },
  plugins: [
    // This is needed because github apps oauth is dumb and broken
    // Even if you set redirect_uri to point to your ngrok host,
    // github will still redirect back to you using whatever the first URL in the app
    // callback URLs is set to
    // https://github.com/orgs/community/discussions/64705
    // Since a bunch of us also use localhost:5173 in their browser in development but ALSO
    // want to receive slack webhooks on their ngrok host, we NEVER redirect _to_ localhost
    // (as slack's webhook service wouldn't be able to follow that redirect)
    {
      name: "iterate:force-vite-public-url",
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
    reactRouter(),
    tsconfigPaths(),
  ],
});
