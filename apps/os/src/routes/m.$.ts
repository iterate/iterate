import { createFileRoute } from "@tanstack/react-router";

/**
 * The mobile app's web surface (/m/preview-channel, /m/install,
 * /m/install-manifest, /m/channel-status) moved to its own worker at
 * mobile.iterate.com (apps/mobile/website — kernel vs userland). QR codes
 * already printed in PR bodies and commit comments encode os.iterate.com
 * URLs, so this permanent redirect must outlive the move.
 *
 * Hardcoded rather than imported from envs.ts (`mobileWebsiteEnvs`) — os
 * worker code deliberately never bundles the root env map.
 */
const MOBILE_WEBSITE_BASE_URL = "https://mobile.iterate.com";

export const Route = createFileRoute("/m/$")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const url = new URL(request.url);
        return Response.redirect(`${MOBILE_WEBSITE_BASE_URL}${url.pathname}${url.search}`, 301);
      },
    },
  },
});
