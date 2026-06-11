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
import { ROUTED_LANE_HEADER, routeOsRequest } from "./shared/router.ts";
import { parseConfig } from "~/config.ts";

export default {
  async fetch(request: Request, env: Env) {
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
