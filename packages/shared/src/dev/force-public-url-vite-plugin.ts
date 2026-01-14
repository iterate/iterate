import type { Plugin } from "vite";

/**
 * Vite plugin that redirects requests to VITE_PUBLIC_URL when the request host doesn't match.
 * Useful when running behind a tunnel/proxy and you want to ensure users access via the public URL.
 */
export function forceVitePublicUrl(): Plugin {
  return {
    name: "force-vite-public-url",
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
  };
}
