/**
 * The ingress router — the ONLY worker with routes, and deliberately tiny so
 * its cold start is negligible. Every request to an OS hostname lands here
 * and is forwarded whole over a service binding:
 *
 *   MCP hostname        → app worker `/api/mcp`
 *   ingress-rule match  → project worker (rule rides an internal header)
 *   everything else     → the app worker (TanStack dashboard / API)
 *
 * Routing logic lives in workers/shared/router.ts and is shared with the
 * app worker's local-dev path. Keep this file free of heavyweight imports —
 * its entire job is one config parse, at most one D1 lookup, and a forward.
 */
import { RESOLVED_INGRESS_HEADER, routeOsRequest } from "./shared/router.ts";
import { parseConfig } from "~/config.ts";
import { normalizeIngressHost } from "~/ingress/host-headers.ts";
import { MCP_START_MOUNT_PATH } from "~/lib/mcp-base-url.ts";

export default {
  async fetch(inbound: Request, env: Env) {
    // This is the trust boundary: the internal routing headers are only ever
    // set HERE (and by the app worker's own re-route in dev). Strip whatever
    // the outside world sent so downstream workers can rely on them.
    const request = stripInternalHeaders(inbound);

    const config = parseConfig(env);
    const mcpRequest = rewriteMcpHostRequest({ config, request });
    if (mcpRequest) return await env.APP.fetch(mcpRequest);

    const routed = await routeOsRequest({
      config,
      db: env.DB,
      request,
      targets: { PROJECT_HOST: env.PROJECT_HOST },
    });
    if (routed) return routed;

    return await env.APP.fetch(request);
  },
};

export function stripInternalHeaders(request: Request) {
  const headers = new Headers(request.headers);
  headers.delete(RESOLVED_INGRESS_HEADER);
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  headers.delete("x-iterate-ingress-hostname");
  return new Request(request, { headers });
}

export function rewriteMcpHostRequest(input: {
  config: { baseUrl?: string; mcp?: { baseUrl: string } };
  request: Request;
}) {
  if (!input.config.baseUrl || !input.config.mcp?.baseUrl) return null;

  const requestUrl = new URL(input.request.url);
  const mcpUrl = new URL(input.config.mcp.baseUrl);
  if (normalizeIngressHost(requestUrl.hostname) !== normalizeIngressHost(mcpUrl.hostname)) {
    return null;
  }

  const appUrl = new URL(input.config.baseUrl);
  if (normalizeIngressHost(mcpUrl.hostname) === normalizeIngressHost(appUrl.hostname)) return null;

  const pathSuffix = requestUrl.pathname.startsWith(`${MCP_START_MOUNT_PATH}/`)
    ? requestUrl.pathname.slice(MCP_START_MOUNT_PATH.length)
    : requestUrl.pathname === MCP_START_MOUNT_PATH || requestUrl.pathname === "/"
      ? ""
      : requestUrl.pathname;

  requestUrl.protocol = appUrl.protocol;
  requestUrl.host = appUrl.host;
  requestUrl.pathname = `${MCP_START_MOUNT_PATH}${pathSuffix}`;

  return new Request(requestUrl, input.request);
}
