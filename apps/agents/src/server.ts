import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { env } from "cloudflare:workers";
import { proxyPosthogRequest } from "@iterate-com/shared/posthog";
import { appAuth } from "iterate/app-server";
import type { BrowserSession } from "iterate/app-session";
export { BrowserSession } from "iterate/app-session";

declare global {
  namespace Cloudflare {
    /** The bindings every app's Worker config gives it (startAppWorkerConfig, scripts/lib/start-app.ts). */
    interface Env {
      ASSETS: Fetcher;
      BROWSER_SESSION: DurableObjectNamespace<BrowserSession>;
      ITERATE_ORIGIN: string;
      /** zones a connectable issuer may not live under (the SDK's `issuerOriginOf`) — this deployment's own, comma-separated */
      ITERATE_DENY_ZONES: string;
      /** PostHog's project key (envs.ts, prd only); unset ⇒ no PostHog */
      POSTHOG_PROJECT_KEY?: string;
    }
  }
}

/** The app's own origin signs a person in through the platform's OAuth (`appAuth`) and proxies
 *  the authenticated /api; it works through project ingress too.
 *  Everything else is TanStack Start's: the built assets, then its pages. */
export default createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    // posthog-js's `api_host` (packages/ui posthog.tsx): PostHog EU through our own origin
    if (url.pathname.startsWith("/e/")) return proxyPosthogRequest({ request, proxyPrefix: "/e" });
    const auth = await appAuth(request, {
      client: { name: "iterate Agents", logoUri: "/client-logo.svg" },
      sessions: env.BROWSER_SESSION,
      issuer: env.ITERATE_ORIGIN,
      resource: `${env.ITERATE_ORIGIN}/api`,
      denyZones: env.ITERATE_DENY_ZONES.split(",").filter(Boolean),
      api: (request) => fetch(request),
    });
    if (auth) return auth;
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    return handler.fetch(request);
  },
});
