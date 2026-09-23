import { proxyPosthogRequest } from "@iterate-com/shared/posthog";
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
      /** zones a connectable issuer may not live under (the SDK's `issuerOriginOf`) — this deployment's own, comma-separated */
      ITERATE_DENY_ZONES: string;
    },
  ) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    // posthog-js's `api_host` (packages/ui posthog.tsx): PostHog EU through our own origin
    if (url.pathname.startsWith("/e/")) return proxyPosthogRequest({ request, proxyPrefix: "/e" });
    const auth = await appAuth(request, {
      client: { name: "Iterate Notes", logoUri: "/client-logo.svg" },
      sessions: env.BROWSER_SESSION,
      issuer: env.ITERATE_ORIGIN,
      resource: `${env.ITERATE_ORIGIN}/api`,
      denyZones: env.ITERATE_DENY_ZONES.split(",").filter(Boolean),
      api: (request) => fetch(request),
    });
    if (auth) return auth;
    // A signed-in browser landing on `/` goes to its notes (routes/_auth/projects.index.tsx: the first
    // project's page); the landing page is for signing in.
    if (url.pathname === "/" && request.method === "GET") {
      const bearer = await appSession(env.BROWSER_SESSION, request)?.bearer();
      if (bearer)
        return new Response(null, {
          status: 302,
          headers: { Location: "/projects", "Cache-Control": "no-store" },
        });
    }
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    return entry.fetch(request);
  },
};
