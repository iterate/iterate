import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { env } from "cloudflare:workers";
import { proxyPosthogRequest } from "@iterate-com/shared/posthog";
import { startAppConfigOf } from "@iterate-com/shared/start-app-config";
import { appAuth, appSession } from "iterate/app-server";
import type { BrowserSession } from "iterate/app-session";
export { BrowserSession } from "iterate/app-session";

declare global {
  namespace Cloudflare {
    /** The bindings every app's Worker config gives it (startAppWorkerConfig, scripts/lib/start-app.ts). */
    interface Env {
      ASSETS: Fetcher;
      BROWSER_SESSION: DurableObjectNamespace<BrowserSession>;
      /** THE APP'S CONFIGURATION, JSON (@iterate-com/shared/start-app-config): its platform, the
       *  other apps' origins, our own zones and its PostHog key — from envs.ts (startAppWorkerConfig) */
      APP_CONFIG: string;
    }
  }
}

/** The app's own origin signs a person in through the platform's OAuth (`appAuth`) and proxies
 *  the authenticated /api; it works through project ingress too.
 *  Everything else is TanStack Start's: the built assets, then its pages. */
export default createServerEntry({
  async fetch(request) {
    // parsed on the first request, /healthz's included: a malformed config fails the deploy's smoke
    const config = startAppConfigOf(env);
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    // posthog-js's `api_host` (packages/ui posthog.tsx): PostHog EU through our own origin
    if (url.pathname.startsWith("/e/")) return proxyPosthogRequest({ request, proxyPrefix: "/e" });
    const auth = await appAuth(request, {
      client: { name: "iterate Voice", logoUri: "/client-logo.svg" },
      sessions: env.BROWSER_SESSION,
      issuer: config.urls.os,
      resource: `${config.urls.os}/api`,
      denyZones: config.denyZones,
      api: (request) => fetch(request),
    });
    if (auth) return auth;
    // A signed-in browser landing on `/` goes to the phone (routes/_auth/projects.index.tsx: the first
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
    return handler.fetch(request);
  },
});
