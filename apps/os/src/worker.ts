/**
 * The OS worker — the whole product in one script.
 *
 * One fetch handler routes every request that lands on an OS hostname:
 *
 *   MCP hostname          → the dashboard app at `/api/mcp`
 *   itx lanes             → the api pipeline (capnweb surface, e2e fixtures,
 *                           `/prj_<id>` path lane, project platform hosts,
 *                           custom hostnames)
 *   OS host               → the dashboard app (TanStack Start SSR + assets)
 *
 * All Durable Object classes live here too (same-script bindings — no
 * cross-script namespaces, no service bindings, no ingress worker). Worker
 * bindings are not threaded through request context — modules import `env`
 * from "cloudflare:workers" directly:
 * https://developers.cloudflare.com/workers/runtime-apis/bindings/#importing-env-as-a-global
 */
import handler from "@tanstack/react-start/server-entry";
import { newHttpBatchRpcResponse, newWorkersWebSocketRpcResponse } from "capnweb";
import { withEvlog } from "@iterate-com/shared/evlog";
import { trustedInternalAuthContext } from "./auth.ts";
import { e2eFixtureResponse } from "./e2e-fixtures.ts";
import type { Env } from "./env.ts";
import { apiWorkerRequest, decideIngressRoute, type IngressResolvers } from "./ingress.ts";
import { readProjectByHostname, resolveProjectIdBySlug } from "./project-directory.ts";
import { ProjectCollectionRpcTarget, UnauthenticatedItxRpcTarget } from "./rpc-targets.ts";
import { handleCapnwebAdminCookieRequest } from "./auth/admin-auth-cookie.ts";
import { normalizeIngressHost } from "./ingress/host-headers.ts";
import { MCP_START_MOUNT_PATH } from "./lib/mcp-base-url.ts";
import { AppConfig, parseConfig } from "./config.ts";
import type { RequestContext } from "./request-context.ts";

// Every Durable Object class in the product, plus the loopback entrypoints
// (`ctx.exports`) shared by the itx runtime.
export { AgentDurableObject } from "./domains/agents/agent-durable-object.ts";
export { CloudflareSandboxDurableObject } from "./domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts";
export { ItxDurableObject } from "./domains/itx/itx-durable-object.ts";
export { ProjectDurableObject } from "./domains/projects/project-durable-object.ts";
export { RepoDurableObject } from "./domains/repos/repo-durable-object.ts";
export { SecretDurableObject } from "./domains/secrets/secret-durable-object.ts";
export { StatefulWorkerDurableObject } from "./domains/workers/stateful-worker-durable-object.ts";
export { StreamDurableObject } from "./domains/streams/stream-durable-object.ts";
export { ItxEntrypoint } from "./domains/itx/itx-entrypoint.ts";
export { ProjectEgressEntrypoint } from "./domains/projects/egress.ts";

export default {
  async fetch(inbound: Request, env: Env, ctx: ExecutionContext) {
    // This is the trust boundary: the internal routing headers are only ever
    // set by our own routing below. Strip whatever the outside world sent so
    // downstream code can rely on them.
    const request = stripInternalHeaders(inbound);

    // Parse config per request, not at module scope: workerd may reuse an
    // isolate across binding-only deploys, so a module-scope copy can serve
    // stale secrets after a rotation. Parsing is pure and cheap.
    const config = parseConfig(env);

    const mcpRequest = rewriteMcpHostRequest({ config, request });
    if (mcpRequest) return await appFetch(mcpRequest, env, ctx, config);

    const apiRequest = apiWorkerRequest({ config, request });
    if (apiRequest) return await apiFetch(apiRequest, env, ctx, config);

    // Everything else is the OS host (project + custom hostnames all took the
    // api lane above, which owns the 404 for hosts that resolve to nothing).
    return await appFetch(request, env, ctx, config);
  },
};

/**
 * The dashboard app: TanStack Start SSR, server functions, and the remaining
 * /api routes (inbound MCP, health). Every request emits one structured
 * "wide event" log line.
 */
async function appFetch(request: Request, _env: Env, ctx: ExecutionContext, config: AppConfig) {
  return withEvlog(
    { request, app: { name: "@iterate-com/os", slug: "os" }, config, executionCtx: ctx },
    async ({ log }) => {
      // When baseUrl is not configured (for example workers.dev previews),
      // the request origin is the app's own URL. After this, baseUrl is
      // always set.
      const requestConfig: AppConfig = config.baseUrl
        ? config
        : { ...config, baseUrl: new URL(request.url).origin as AppConfig["baseUrl"] };

      const context: RequestContext = {
        config: requestConfig,
        log,
        rawRequest: request,
        waitUntil: (promise) => ctx.waitUntil(promise),
      };

      return await handler.fetch(request, { context });
    },
  );
}

/**
 * The itx api pipeline: the capnweb surface at `/api/itx`, the
 * `/api/itx/admin-cookie` browser auth bridge, worker-hosted e2e fixtures,
 * and project ingress — every lane `decideIngressRoute` (src/ingress.ts) can
 * resolve.
 */
async function apiFetch(request: Request, env: Env, ctx: ExecutionContext, config: AppConfig) {
  const url = new URL(request.url);

  const fixtureResponse = await e2eFixtureResponse(request);
  if (fixtureResponse !== null) return fixtureResponse;

  const route = await decideIngressRoute({
    config,
    headers: request.headers,
    method: request.method,
    resolvers: directoryResolvers(config, env),
    url: request.url,
  });

  if (route.lane === "project") {
    const project = await new ProjectCollectionRpcTarget({
      auth: trustedInternalAuthContext(),
      ctx,
    }).get(route.resolved.projectId);
    const init: RequestInit = {
      body: request.body,
      headers: route.fetch.headers,
      method: route.fetch.method,
      redirect: request.redirect,
    };
    if (request.body !== null) {
      (init as RequestInit & { duplex: "half" }).duplex = "half";
    }
    return await project.worker.fetch(new Request(route.fetch.url, init));
  }

  if (route.lane === "notFound") {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  if (url.pathname === "/api/itx/admin-cookie") {
    return await handleCapnwebAdminCookieRequest({ config, request });
  }

  if (url.pathname !== "/api/itx") return Response.json({ error: "not found" }, { status: 404 });
  const unauthenticated = new UnauthenticatedItxRpcTarget({
    config,
    ctx,
    headers: request.headers,
    requestUrl: request.url,
  });
  if (request.method === "POST") {
    return newHttpBatchRpcResponse(request, unauthenticated);
  }
  return newWorkersWebSocketRpcResponse(request, unauthenticated);
}

function directoryResolvers(config: AppConfig, env: Env): IngressResolvers {
  return {
    projectIdBySlug: (identifier) =>
      resolveProjectIdBySlug({ config, directory: env.PROJECT_DIRECTORY, identifier }),
    projectByHostname: async (host) => {
      const found = await readProjectByHostname(env.PROJECT_DIRECTORY, host);
      return found ? { appSlug: found.appSlug, projectId: found.record.id } : null;
    },
  };
}

export function stripInternalHeaders(request: Request) {
  const headers = new Headers(request.headers);
  headers.delete("x-iterate-resolved-ingress");
  headers.delete("x-iterate-app");
  headers.delete("x-itx-project-id");
  headers.delete("x-iterate-url-prefix");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  headers.delete("x-iterate-ingress-hostname");
  return new Request(request, { headers });
}

/**
 * When the MCP host is a dedicated hostname (distinct from the app host),
 * rewrite requests on it onto the app's `/api/mcp` mount path.
 */
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
