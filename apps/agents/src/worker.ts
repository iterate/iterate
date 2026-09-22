import { appAuth } from "iterate/next/app-server";
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
    if (new URL(request.url).pathname === "/healthz") return new Response("ok");
    const auth = await appAuth(request, {
      client: { name: "Iterate Agents", logoUri: "/client-logo.svg" },
      sessions: env.BROWSER_SESSION,
      issuer: env.ITERATE_ORIGIN,
      resource: `${env.ITERATE_ORIGIN}/api`,
      denyZones: env.ITERATE_DENY_ZONES.split(",").filter(Boolean),
      api: (request) => fetch(request),
    });
    if (auth) return auth;
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    return entry.fetch(request);
  },
};
