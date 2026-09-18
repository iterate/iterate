import { appAuth, appSession } from "iterate/next/app-server";
import type { BrowserSession } from "iterate/next/app-session";
import entry from "@tanstack/react-start/server-entry";
export { BrowserSession } from "iterate/next/app-session";

/** The public shell works both on this origin and through project ingress.
 * On its own origin the same SDK provides OAuth and the authenticated /api proxy. */
export default {
  async fetch(
    request: Request,
    env: {
      ASSETS: Fetcher;
      BROWSER_SESSION: DurableObjectNamespace<BrowserSession>;
      ITERATE_ORIGIN: string;
    },
  ) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    const auth = await appAuth(request, {
      sessions: env.BROWSER_SESSION,
      issuer: env.ITERATE_ORIGIN,
      resource: `${env.ITERATE_ORIGIN}/api`,
      api: (request) => fetch(request),
    });
    if (auth) return auth;
    // A signed-in browser landing on `/` goes to its notes; the landing page is for signing in.
    if (url.pathname === "/" && request.method === "GET") {
      const bearer = await appSession(env.BROWSER_SESSION, request)?.bearer();
      if (bearer)
        return new Response(null, {
          status: 302,
          headers: { Location: "/notes", "Cache-Control": "no-store" },
        });
    }
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    return entry.fetch(request);
  },
};
