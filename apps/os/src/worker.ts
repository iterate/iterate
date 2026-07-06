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
import { decideIngressRoute, type IngressResolvers } from "./ingress.ts";
import { readProjectByHostname, resolveProjectIdBySlug } from "./project-directory.ts";
import { isWorkerBuildInProgressError } from "./domains/workers/worker-loader.ts";
import {
  defaultProjectWorkerRef,
  ProjectCollectionRpcTarget,
  UnauthenticatedOsRpcTarget,
} from "./rpc-targets.ts";
import type { ProjectWorker } from "./domains/workers/schemas.ts";
import { handleSlackWebhookApiRequest } from "./domains/integrations/slack-webhook-api.ts";
import { handleCapnwebAdminCookieRequest } from "./auth/admin-auth-cookie.ts";
import { rewriteMcpHostRequest } from "./ingress/mcp-host-rewrite.ts";
import { AppConfig, parseConfig } from "./config.ts";
import type { RequestContext } from "./request-context.ts";

/** Long enough for warm-cache loads and quick bundles; past it, show the page. */
const PROJECT_HOST_BUILD_BUDGET_MS = 15_000;

function workerBuildingResponse(): Response {
  return new Response(
    `<!doctype html>
      <html>
        <head>
          <meta http-equiv="refresh" content="3" />
          <title>Building…</title>
        </head>
        <body>
          <main>
            <p>Your worker is building — this page retries automatically.</p>
          </main>
        </body>
      </html>`,
    {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", "retry-after": "3" },
    },
  );
}

// Every Durable Object class in the product, plus the loopback entrypoints
// (`ctx.exports`) shared by the itx runtime.
export { AgentDurableObject } from "./domains/agents/agent-durable-object.ts";
export { CapabilityHostDurableObject } from "./domains/capability-host/capability-host-durable-object.ts";
export { CloudflareSandboxDurableObject } from "./domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts";
export { ProjectDurableObject } from "./domains/projects/project-durable-object.ts";
export { RepoDurableObject } from "./domains/repos/repo-durable-object.ts";
export { SecretDurableObject } from "./domains/secrets/secret-durable-object.ts";
export { StatefulWorkerDurableObject } from "./domains/workers/stateful-worker-durable-object.ts";
export { StreamDurableObject } from "./domains/streams/stream-durable-object.ts";
export { ItxEntrypoint } from "./domains/itx/itx-entrypoint.ts";
export { ProjectEgressEntrypoint } from "./domains/projects/egress.ts";
// The container-outbound gateway. The container runtime dials it through
// `ctx.exports.ContainerProxy` to route intercepted sandbox egress; every
// sandbox container's outbound HTTP(S) reaches it before anything leaves the
// account (see CloudflareSandboxDurableObject's `outbound` handler). Re-export
// the `@cloudflare/sandbox` build of it (a subclass of the containers one) so
// the DO's Container base and this gateway share one outbound-handler registry
// and its SDK-internal mount routing stays intact.
export { ContainerProxy } from "@cloudflare/sandbox";

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
    if (mcpRequest) return await appFetch(mcpRequest, ctx, config);

    const route = await decideIngressRoute({
      config,
      headers: request.headers,
      method: request.method,
      resolvers: directoryResolvers(config, env),
      url: request.url,
    });
    if (route.lane !== "os") return await apiFetch(request, ctx, config, route);

    return await appFetch(request, ctx, config);
  },
};

/**
 * The dashboard app: TanStack Start SSR, server functions, and the remaining
 * /api routes (inbound MCP, health). Every request emits one structured
 * "wide event" log line.
 */
async function appFetch(request: Request, ctx: ExecutionContext, config: AppConfig) {
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
 * The api pipeline: the capnweb surface at `/api`, the
 * `/api/admin-cookie` browser auth bridge, worker-hosted e2e fixtures,
 * and project ingress — every lane `decideIngressRoute` (src/ingress.ts) can
 * resolve.
 */
async function apiFetch(
  request: Request,
  ctx: ExecutionContext,
  config: AppConfig,
  route: Exclude<Awaited<ReturnType<typeof decideIngressRoute>>, { lane: "os" }>,
) {
  const url = new URL(request.url);

  const fixtureResponse = await e2eFixtureResponse(request);
  if (fixtureResponse !== null) return fixtureResponse;

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
    // Browser-facing lane: a cold build (first use after a commit) should
    // show a refreshing "building" page rather than hang the request. The
    // budgeted worker stub throws a named error past the budget while the
    // build finishes into the artifact cache; refreshes then hit it.
    const worker = project.workers.get<ProjectWorker>(defaultProjectWorkerRef(), {
      buildBudgetMs: PROJECT_HOST_BUILD_BUDGET_MS,
      flattenNestedPaths: true,
    });
    try {
      return await worker.fetch(new Request(route.fetch.url, init));
    } catch (error) {
      if (!isWorkerBuildInProgressError(error)) throw error;
      return workerBuildingResponse();
    }
  }

  if (route.lane === "notFound") {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  if (url.pathname === "/api/admin-cookie") {
    return await handleCapnwebAdminCookieRequest({ config, request });
  }

  // Slack webhook ingress lives here (not the app lane): this pipeline has
  // the engine bindings, so a signed event routes straight into the claiming
  // project's stream without a capnweb round trip.
  const slackWebhookResponse = await handleSlackWebhookApiRequest({ config, request });
  if (slackWebhookResponse !== null) return slackWebhookResponse;

  if (url.pathname !== "/api") return Response.json({ error: "not found" }, { status: 404 });
  const unauthenticated = new UnauthenticatedOsRpcTarget({
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

function stripInternalHeaders(request: Request) {
  const headers = new Headers(request.headers);
  headers.delete("x-iterate-app");
  headers.delete("x-itx-project-id");
  headers.delete("x-iterate-url-prefix");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  return new Request(request, { headers });
}
