// mobile.iterate.com — the mobile app's own web surface. Deliberately NOT
// part of apps/os: kernel vs userland, and these phone-scan pages want a
// worker measured in KB (os's bundle rides Cloudflare's startup-CPU limit).
// Zero framework: four routes don't earn a router, and the pages are
// template-literal HTML. Only runtime dependency: the shared snapshot
// schema. apps/os keeps 301s for /m/* so already-printed QR codes survive.
import {
  handleChannelStatusRequest,
  handleInstallManifestRequest,
  handleInstallPageRequest,
  handlePreviewChannelRequest,
} from "./channel-status.ts";

export interface Env {
  STATE_BUCKET: R2Bucket;
  /** Same value as apps/os's APP_CONFIG_ADMIN_API_SECRET (doppler os/prd) —
   * the CI snapshot writers already hold it. */
  APP_CONFIG_ADMIN_API_SECRET: string;
}

/**
 * Universal links: iOS fetches this at app install and opens
 * https://mobile.iterate.com/preview-channel/* directly in the app (the
 * binary carries `applinks:mobile.iterate.com` — app.json
 * ios.associatedDomains). ONLY the preview-channel path: the install and
 * manifest pages must stay web pages — their whole purpose is getting a NEW
 * binary, and opening the old app would hide the Install button. Phones
 * whose binary predates the entitlement fall back to the web interstitial,
 * which bounces to the iterate:// scheme — same destination, one hop more.
 * Team id 5N6A5Q26NT = the EAS-managed Apple team (extracted from the
 * build's embedded.mobileprovision).
 */
const APPLE_APP_SITE_ASSOCIATION = {
  applinks: {
    details: [
      {
        appIDs: ["5N6A5Q26NT.com.iterate.mobile"],
        components: [{ "/": "/preview-channel/*" }],
      },
    ],
  },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.pathname === "/.well-known/apple-app-site-association" ||
      url.pathname === "/apple-app-site-association"
    ) {
      return Response.json(APPLE_APP_SITE_ASSOCIATION, {
        // Apple's CDN refetches periodically; a short cache keeps rollouts
        // of path changes quick without hammering the worker.
        headers: { "cache-control": "public, max-age=300" },
      });
    }
    // Bare paths are canonical (and /preview-channel/* is the universal-link
    // prefix, matching the app's expo-router route exactly); /m/* stays
    // served forever for every QR already printed.
    const match =
      /^(?:\/m)?\/(preview-channel|install|install-manifest|channel-status)\/([^/]+)$/.exec(
        url.pathname,
      );
    if (match) {
      const [, page, channel] = match as unknown as [string, string, string];
      const decoded = decodeURIComponent(channel);
      switch (page) {
        case "preview-channel":
          return handlePreviewChannelRequest({ channel: decoded });
        case "install":
          return handleInstallPageRequest({
            bucket: env.STATE_BUCKET,
            channel: decoded,
            origin: url.origin,
          });
        case "install-manifest":
          return handleInstallManifestRequest({ bucket: env.STATE_BUCKET, channel: decoded });
        case "channel-status":
          return handleChannelStatusRequest({
            bucket: env.STATE_BUCKET,
            channel: decoded,
            adminSecret: env.APP_CONFIG_ADMIN_API_SECRET,
            request,
          });
      }
    }
    if (url.pathname === "/") {
      return new Response("mobile.iterate.com — the Iterate mobile app's web surface", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
