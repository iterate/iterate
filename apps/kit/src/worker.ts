import { appAuth, appSession } from "iterate/next/app-server";
import type { BrowserSession } from "iterate/next/app-session";
import entry from "@tanstack/react-start/server-entry";
import { deviceClientMetadata } from "./firmware/device-client.ts";
import { DEFAULT_DEVICE_ID, DEFAULT_FIRMWARE_VERSION } from "./firmware/catalog.ts";
export { BrowserSession } from "iterate/next/app-session";

/** The installer's own origin signs the person in through os-next's OAuth and proxies
 * the authenticated /api; the synced firmware binaries are static assets. */
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
    const deviceClient = deviceClientMetadata(url);
    if (deviceClient) return deviceClient;
    const auth = await appAuth(request, {
      sessions: env.BROWSER_SESSION,
      issuer: env.ITERATE_ORIGIN,
      resource: `${env.ITERATE_ORIGIN}/api`,
      api: (request) => fetch(request),
    });
    if (auth) return auth;
    // Like Dash and Notes, signed-in visitors skip the public sign-in page.
    if (url.pathname === "/" && request.method === "GET") {
      const bearer = await appSession(env.BROWSER_SESSION, request)?.bearer();
      if (bearer)
        return new Response(null, {
          status: 302,
          headers: {
            Location: `/devices/${DEFAULT_DEVICE_ID}/firmware/${DEFAULT_FIRMWARE_VERSION}`,
            "Cache-Control": "no-store",
          },
        });
    }
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    return entry.fetch(request);
  },
};
