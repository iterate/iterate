import type { Plugin } from "vite";

/**
 * Vite plugin for VITE_PUBLIC_URL support:
 * 1. Adds the public URL hostname to allowedHosts
 * 2. Redirects requests to VITE_PUBLIC_URL when the request host doesn't match
 * Useful when running behind a tunnel/proxy.
 */
export function vitePublicUrl(): Plugin {
  return {
    name: "vite-public-url",
    config() {
      const publicURL = process.env.VITE_PUBLIC_URL;
      if (!publicURL) return;
      try {
        const hostname = new URL(publicURL).hostname;
        return { server: { allowedHosts: [hostname] } };
      } catch {
        return;
      }
    },
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

/** @deprecated Use vitePublicUrl instead */
export const forceVitePublicUrl = vitePublicUrl;
