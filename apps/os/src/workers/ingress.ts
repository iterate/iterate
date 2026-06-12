/**
 * The ingress router — the ONLY worker with routes, and deliberately tiny so
 * its cold start is negligible. Every request to an OS hostname lands here
 * and is forwarded whole over a service binding:
 *
 *   MCP hostname        → MCP worker
 *   ingress-rule match  → project worker (rule rides an internal header)
 *   everything else     → the app worker (TanStack dashboard / API)
 *
 * Routing logic lives in workers/shared/router.ts and is shared with the
 * app worker's local-dev path. Keep this file free of heavyweight imports —
 * its entire job is one config parse, at most one D1 lookup, and a forward.
 */
import { RESOLVED_INGRESS_HEADER, ROUTED_LANE_HEADER, routeOsRequest } from "./shared/router.ts";
import { parseConfig } from "~/config.ts";

export default {
  async fetch(inbound: Request, env: Env) {
    // This is the trust boundary: the internal routing headers are only ever
    // set HERE (and by the app worker's own re-route in dev). Strip whatever
    // the outside world sent so downstream workers can rely on them.
    const request = stripInternalHeaders(inbound);

    const config = parseConfig(env);
    const routed = await routeOsRequest({
      config,
      db: env.DB,
      request,
      targets: { MCP: env.MCP, PROJECT_HOST: env.PROJECT_HOST },
    });
    if (routed) return routed;

    // App lane. Mark the request as already routed so the app worker skips
    // repeating the ingress-rule lookup.
    const headers = new Headers(request.headers);
    headers.set(ROUTED_LANE_HEADER, "app");
    return await env.APP.fetch(new Request(request, { headers }));
  },
};

function stripInternalHeaders(request: Request) {
  if (!request.headers.has(RESOLVED_INGRESS_HEADER) && !request.headers.has(ROUTED_LANE_HEADER)) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.delete(RESOLVED_INGRESS_HEADER);
  headers.delete(ROUTED_LANE_HEADER);
  return new Request(request, { headers });
}
