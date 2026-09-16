import { appAuth } from "os-next/app-server";
import type { BrowserSession } from "os-next/app-session";
import entry from "@tanstack/react-start/server-entry";
export { BrowserSession } from "os-next/app-session";

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
    if (new URL(request.url).pathname === "/healthz") return new Response("ok");
    const auth = await appAuth(request, {
      sessions: env.BROWSER_SESSION,
      issuer: env.ITERATE_ORIGIN,
      resource: `${env.ITERATE_ORIGIN}/api`,
      api: (request) => fetch(request),
    });
    if (auth) return auth;
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    return entry.fetch(request);
  },
};
