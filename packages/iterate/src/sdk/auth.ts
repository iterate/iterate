import { z } from "zod";
import { isSameOriginBrowserRequest } from "../lib.ts";
import { ITX_PRINCIPAL_HEADER } from "../principal.ts";

const Principal = z.object({ actor: z.string().min(1), email: z.string().optional() });

/** Project ingress strips public identity headers and stamps the verified caller.
 * This guard runs locally in the config worker, before it proxies an app.
 *
 * A WebSocket upgrade is treated like a write: it must come from this origin (or carry no Origin, a
 * non-browser client), and signed out it gets a 401, since a socket cannot follow the sign-in
 * redirect. The handshake is a GET, but it opens a two-way channel, and the app session cookie is
 * `SameSite=Lax`: every `<app>--<project>.iterate.app` host is same-site with every other, so a page
 * on another project's host could otherwise open a socket to this app with the visitor's cookie. */
export const auth = {
  require(request: Request): Response | null {
    const url = new URL(request.url);
    const isWebSocketUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    const isRead = ["GET", "HEAD", "OPTIONS"].includes(request.method) && !isWebSocketUpgrade;
    if (!isRead && !isSameOriginBrowserRequest(request))
      return new Response("Cross-site request refused", { status: 403 });
    const principal = request.headers.get(ITX_PRINCIPAL_HEADER);
    if (principal) {
      Principal.parse(JSON.parse(principal)); // Platform-owned stamp; malformed means a defect.
      return null;
    }
    if (isWebSocketUpgrade || !["GET", "HEAD"].includes(request.method))
      return new Response("Sign in first", { status: 401 });
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/.auth/login?next=${encodeURIComponent(url.pathname + url.search)}`,
        "Cache-Control": "no-store",
      },
    });
  },
};
