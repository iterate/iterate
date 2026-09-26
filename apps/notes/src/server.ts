import { createServerEntry } from "@tanstack/react-start/server-entry";
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { proxyPosthogRequest } from "@iterate-com/shared/posthog";
import { startAppConfigOf } from "@iterate-com/shared/start-app-config";
import { appAuth, appSession } from "iterate/app-server";
import type { BrowserSession } from "iterate/app-session";
import { basePathOf } from "./base-path.ts";
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

/** TanStack Start's pages, their scripts and stylesheets under the request's base path
 *  (base-path.ts) — per request, since a proxied page names its own. */
const pages = createStartHandler({
  handler: defaultStreamHandler,
  transformAssets: {
    createTransform: (context) => {
      const basePath = context.warmup ? "" : basePathOf(context.request.headers);
      return ({ url }) => `${basePath}${url}`;
    },
    cache: false,
  },
});

/** The app's own origin signs a person in through the platform's OAuth (`appAuth`) and proxies
 *  the authenticated /api; it works through project ingress too, under the base path the edge
 *  says (base-path.ts). Everything else is TanStack Start's: the built assets, then its pages. */
export default createServerEntry({
  async fetch(request) {
    // parsed on the first request, /healthz's included: a malformed config fails the deploy's smoke
    const config = startAppConfigOf(env);
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    // posthog-js's `api_host` (packages/ui posthog.tsx): PostHog EU through our own origin
    if (url.pathname.startsWith("/e/")) return proxyPosthogRequest({ request, proxyPrefix: "/e" });
    const auth = await appAuth(request, {
      client: { name: "iterate Notes", logoUri: "/client-logo.svg" },
      sessions: env.BROWSER_SESSION,
      issuer: config.urls.os,
      resource: `${config.urls.os}/api`,
      denyZones: config.denyZones,
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
    // A page renders at the URL the browser addressed, its base path back on: at the stripped URL
    // the router would redirect to its canonical one, the base path on, which the edge strips
    // again. A server function is Start's `/_serverFn/<id>`, served as it came.
    const basePath = basePathOf(request.headers);
    if (!basePath || url.pathname.startsWith("/_serverFn/")) return pages(request);
    const addressed = new URL(url);
    addressed.pathname = `${basePath}${addressed.pathname}`;
    return pages(new Request(addressed, request));
  },
});
