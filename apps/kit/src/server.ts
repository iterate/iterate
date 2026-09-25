import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { env } from "cloudflare:workers";
import { proxyPosthogRequest } from "@iterate-com/shared/posthog";
import { startAppConfigOf } from "@iterate-com/shared/start-app-config";
import { appAuth, issuerAnswersAt } from "iterate/app-server";
import type { BrowserSession } from "iterate/app-session";
import { deviceClientMetadata } from "./firmware/device-client.ts";
import { proxyFirmwareFile } from "./firmware/firmware-proxy.ts";
import { deviceAuth } from "./device-auth.ts";
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
    // Firmware release files are public: esp-web-tools fetches them from the page (firmware-proxy.ts).
    const firmware = await proxyFirmwareFile(request, fetch);
    if (firmware) return firmware;
    // A device's own OAuth client and sign-in come next.
    const deviceClient = deviceClientMetadata(url);
    if (deviceClient) return deviceClient;
    const deviceLogin = await deviceAuth(
      request,
      { sessions: env.BROWSER_SESSION, defaultIssuer: config.urls.os, denyZones: config.denyZones },
      { issuerAnswersAt },
    );
    if (deviceLogin) return deviceLogin;
    const auth = await appAuth(request, {
      client: { name: "iterate Kit", logoUri: "/favicon.svg" },
      sessions: env.BROWSER_SESSION,
      issuer: config.urls.os,
      resource: `${config.urls.os}/api`,
      denyZones: config.denyZones,
      api: (request) => fetch(request),
    });
    if (auth) return auth;
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    return handler.fetch(request);
  },
});
