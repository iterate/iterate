// server.ts — EVERY APP'S WORKER (dash, agents, notes, voice, kit, admin): its src/server.ts, Start's
// server entry, is `appServerEntry(handler, { … })` with only what the app does differently.
import { env } from "cloudflare:workers";
import { proxyPosthogRequest } from "@iterate-com/shared/posthog";
import { startAppConfigOf, type StartAppConfig } from "@iterate-com/shared/start-app-config";
import { appAuth, appSession } from "iterate/app-server";
import type { BrowserSession } from "iterate/app-session";

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

type AppServer = {
  /** The app's own routes ahead of the sign-in gate; null passes the request on. */
  before?: (request: Request, config: StartAppConfig) => Promise<Response | null>;
} & (
  | {
      proxied?: false;
      /** The name the platform's consent page shows (`/.auth/client.json`, beside
       *  `/client-logo.svg`). Without one the gate names the app by its host. */
      clientName?: string;
      /** What a login that names no `scope` asks for (`appAuth` `scopes`): the app's
       *  `createIterateClient({ scopes })`. */
      scopes?: readonly string[];
      /** Where a signed-in browser landing on `/` goes; the landing page is for signing in. */
      home?: string;
    }
  | {
      /** Served only under a project's hosts, which a config worker fetches it through to (Notes):
       *  the platform answers those hosts' `/.auth/*` and `/api` itself (core/os/src/worker.ts), so
       *  the app has no sign-in gate and no OAuth client of its own. */
      proxied: true;
    }
);

/** The app's own origin signs a person in through the platform's OAuth (`appAuth`) and proxies the
 *  authenticated /api; it works through project ingress too. A `proxied` app skips that gate.
 *  Everything else is TanStack Start's: the built assets, then `pages`. */
export function appServerEntry(
  pages: { fetch(request: Request): Promise<Response> | Response },
  app: AppServer,
) {
  return {
    async fetch(request: Request) {
      // parsed on the first request, /healthz's included: a malformed config fails the deploy's smoke
      const config = startAppConfigOf(env);
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return new Response("ok");
      // posthog-js's `api_host` (packages/ui posthog.tsx): PostHog EU through our own origin
      if (url.pathname.startsWith("/e/"))
        return proxyPosthogRequest({ request, proxyPrefix: "/e" });
      const own = await app.before?.(request, config);
      if (own) return own;
      if (!app.proxied) {
        const auth = await appAuth(request, {
          client: app.clientName
            ? { name: app.clientName, logoUri: "/client-logo.svg" }
            : undefined,
          scopes: app.scopes,
          sessions: env.BROWSER_SESSION,
          issuer: config.urls.os,
          resource: `${config.urls.os}/api`,
          denyZones: config.denyZones,
          api: (request) => fetch(request),
        });
        if (auth) return auth;
        if (app.home && url.pathname === "/" && request.method === "GET") {
          const bearer = await appSession(env.BROWSER_SESSION, request)?.bearer();
          if (bearer)
            return new Response(null, {
              status: 302,
              headers: { Location: app.home, "Cache-Control": "no-store" },
            });
        }
      }
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
      return pages.fetch(request);
    },
  };
}
