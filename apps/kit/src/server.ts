import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { env } from "cloudflare:workers";
import { appAuth } from "iterate/next/app-server";
import type { BrowserSession } from "iterate/next/app-session";
import { deviceClientMetadata } from "./firmware/device-client.ts";
import { deviceAuth } from "./device-auth.ts";
export { BrowserSession } from "iterate/next/app-session";

declare global {
  namespace Cloudflare {
    /** The bindings every app's Worker config gives it (startAppWorkerConfig, scripts/lib/start-app.ts). */
    interface Env {
      ASSETS: Fetcher;
      BROWSER_SESSION: DurableObjectNamespace<BrowserSession>;
      ITERATE_ORIGIN: string;
      /** zones a connectable issuer may not live under (the SDK's `issuerOriginOf`) — this deployment's own, comma-separated */
      ITERATE_DENY_ZONES: string;
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
    // A device's own OAuth client and sign-in come first; the synced firmware binaries are assets.
    const deviceClient = deviceClientMetadata(url);
    if (deviceClient) return deviceClient;
    const deviceLogin = await deviceAuth(request, env);
    if (deviceLogin) return deviceLogin;
    const auth = await appAuth(request, {
      client: { name: "Iterate Kit", logoUri: "/favicon.svg" },
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
