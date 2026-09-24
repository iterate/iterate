import { z } from "zod";
import { isSameOriginBrowserRequest } from "../lib.ts";
import { ITX_PRINCIPAL_HEADER } from "../principal.ts";

const Principal = z.object({ actor: z.string().min(1), email: z.string().optional() });

/** Project ingress strips public identity headers and stamps `x-itx-principal` for a project member
 *  only: a visitor signed out, signed in without this project, or riding a session cookie on a
 *  cross-site write arrives without one. This guard runs in the config worker, before it proxies an
 *  app.
 *
 *  Signed out, every request gets `401` with `WWW-Authenticate: Bearer realm="iterate"`: the
 *  platform's edge turns that answer into the sign-in for a page load (or into "sign in again with
 *  this project" for someone signed in without it), whatever path the app is served under, and hands
 *  a fetch, a write or a WebSocket upgrade the 401 itself. Any app can ask for a signed-in visitor
 *  the same way:
 *
 *  ```js
 *  if (!request.headers.get("x-itx-principal"))
 *    return new Response("Sign in\n", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="iterate"' } });
 *  ```
 *
 *  A write or a WebSocket upgrade must also come from this origin (or carry no Origin, a non-browser
 *  client), else 403. The edge already sends such a cookie request on anonymous; this repeats the
 *  check where the app runs. The handshake is a GET, but it opens a two-way channel, and the app
 *  session cookie is `SameSite=Lax`: every `<routingSlug>--<project>.iterate.app` host is same-site with
 *  every other, so a page on another project's host could otherwise open a socket to this app with
 *  the visitor's cookie. */
export const auth = {
  require(request: Request): Response | null {
    const isWebSocketUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    const isRead = ["GET", "HEAD", "OPTIONS"].includes(request.method) && !isWebSocketUpgrade;
    if (!isRead && !isSameOriginBrowserRequest(request))
      return new Response("Cross-site request refused", { status: 403 });
    const principal = request.headers.get(ITX_PRINCIPAL_HEADER);
    if (principal) {
      Principal.parse(JSON.parse(principal)); // Platform-owned stamp; malformed means a defect.
      return null;
    }
    return new Response("Sign in\n", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="iterate"', "Cache-Control": "no-store" },
    });
  },
};
