/**
 * The OS worker — the whole product in one script.
 *
 * One fetch handler routes every request that lands on an OS hostname:
 *
 *   MCP hostname          → the dashboard app at `/api/mcp`
 *   itx lanes             → the api pipeline (capnweb surface, `/prj_<id>`
 *                           path lane, project platform hosts, custom hostnames)
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
import type { Env } from "./env.ts";
import { decideIngressRoute, type IngressResolvers } from "./ingress.ts";
import { readProjectByHostname } from "./project-hostname-directory.ts";
import { readProjectById, readProjectBySlug, resolveProjectIdBySlug } from "./project-directory.ts";
import {
  WORKER_FETCH_DISPATCH_HEADER,
  workerBuildStatusResponse,
} from "./domains/workers/worker-fetch-dispatch.ts";
import { applyProjectWorkerOverlay } from "./domains/workers/worker-serve-overlay.ts";
import { DynamicWorkerRunner } from "./domains/workers/worker-runner.ts";
import {
  deploymentItxForInternal,
  itxForScope,
  UnauthenticatedOsRpcTarget,
} from "./rpc-targets.ts";
import { streamDeliveryAuthContext } from "./auth.ts";
import { configureStreamSubscriberAuthorityRoot } from "./domains/streams/stream-durable-object.ts";
import { defaultProjectWorkerRef } from "./domains/repos/utils.ts";
import { handleIntegrationWebhookApiRequest } from "./domains/integrations/integration-webhook-api.ts";
import { handleInboundEmail } from "./domains/email/email-ingress.ts";
import { FILES_APP_SLUG, serveProjectFileRequest } from "./domains/files/project-files.ts";
import { handleOperatorSessionRequest } from "./auth/operator-session.ts";
import { rewriteMcpHostRequest } from "./ingress/mcp-host-rewrite.ts";
import { AppConfig, parseConfig } from "./config.ts";
import type { RequestContext } from "./request-context.ts";
import {
  handleEventQueueBatch,
  isWorkerEventsQueue,
} from "./domains/events/event-queue-entrypoint.ts";
import { runHttpWideLog } from "./observability/operation.ts";
import { wideLogger } from "./observability/wide-log.ts";
import { createItxRpcSessionOptions } from "./itx/itx-observability.ts";

configureStreamSubscriberAuthorityRoot(({ ctx, projectId }) => {
  const auth = streamDeliveryAuthContext();
  const root =
    projectId === null
      ? deploymentItxForInternal({ auth, ctx })
      : itxForScope({
          auth,
          ctx,
          path: "/",
          projectId,
        });
  return {
    root,
    // This host constructs a local server-side RpcTarget, so acquiring it
    // creates no client reference to release. The explicit lease keeps that
    // ownership decision at the host boundary instead of making the stream
    // infer it from the root's shape.
    [Symbol.dispose]() {},
  };
});

/** Long enough for warm-cache loads and quick bundles; past it, show the page. */
const PROJECT_HOST_BUILD_BUDGET_MS = 15_000;

// Every Durable Object class in the product, plus the loopback entrypoints
// (`ctx.exports`) shared by the itx runtime.
export { AgentDurableObject } from "./domains/agents/agent-durable-object.ts";
export { CapabilityHostDurableObject } from "./domains/capability-host/capability-host-durable-object.ts";
// One sandbox container class per instance type — see src/domains/sandboxes/instance-types.ts.
export {
  SandboxBasicDurableObject,
  SandboxLiteDurableObject,
  SandboxStandard1DurableObject,
  SandboxStandard2DurableObject,
  SandboxStandard3DurableObject,
  SandboxStandard4DurableObject,
} from "./domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts";
export { ProjectDurableObject } from "./domains/projects/project-durable-object.ts";
export { RepoDurableObject } from "./domains/repos/repo-durable-object.ts";
export { SchedulerDurableObject } from "./domains/scheduler/scheduler-durable-object.ts";
export { SecretDurableObject } from "./domains/secrets/secret-durable-object.ts";
export { StatefulWorkerDurableObject } from "./domains/workers/stateful-worker-durable-object.ts";
export { StreamDurableObject } from "./domains/streams/stream-durable-object.ts";
export { WorkspaceDurableObject } from "./domains/workspaces/workspace-durable-object.ts";
export { ItxEntrypoint } from "./domains/itx/itx-entrypoint.ts";
export { ProjectEgressEntrypoint } from "./domains/projects/egress.ts";
// The container-outbound gateway. The container runtime dials it through
// `ctx.exports.ContainerProxy` to route intercepted sandbox egress; every
// sandbox container's outbound HTTP(S) reaches it before anything leaves the
// account (see the sandbox classes' `outbound` handlers). Re-export
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
    return await runHttpWideLog(() => fetchWithoutWideLog(request, env, ctx));
  },

  async queue(batch: MessageBatch, env: Env) {
    if (isWorkerEventsQueue(batch.queue, env)) {
      await handleEventQueueBatch(batch, env);
      return;
    }

    console.warn(`[os] received queue batch from unhandled queue ${batch.queue}`);
  },

  // Inbound project email: Cloudflare Email Routing's catch-all rule for each
  // project hostname base (e.g. `*@iterate.app`) delivers here. setReject is
  // the permanent-failure channel; a thrown error is a temporary failure the
  // sending MTA retries — so infra errors deliberately propagate.
  async email(message: ForwardableEmailMessage) {
    await handleInboundEmail(message);
  },
};

async function fetchWithoutWideLog(request: Request, env: Env, ctx: ExecutionContext) {
  // Parse config per request, not at module scope: workerd may reuse an
  // isolate across binding-only deploys, so a module-scope copy can serve
  // stale secrets after a rotation. Parsing is pure and cheap.
  const config = parseConfig(env);

  const mcpRequest = rewriteMcpHostRequest({ config, request });
  if (mcpRequest) {
    wideLogger.set({ ingress: { lane: "mcp" } });
    return await appFetch(mcpRequest, ctx, config, { isEventDocsHost: false });
  }

  const route = await decideIngressRoute({
    config,
    headers: request.headers,
    method: request.method,
    resolvers: directoryResolvers(env),
    url: request.url,
  });
  wideLogger.set(ingressLogFields(request, route));
  if (route.lane !== "os") return await apiFetch(request, env, ctx, config, route);

  return await appFetch(request, ctx, config, {
    isEventDocsHost: route.hostKind === "eventDocs",
  });
}

/**
 * The dashboard app: TanStack Start SSR, server functions, and the remaining
 * /api routes (inbound MCP, health). Every request emits one structured
 * "wide event" log line.
 */
async function appFetch(
  request: Request,
  ctx: ExecutionContext,
  config: AppConfig,
  host: { isEventDocsHost: boolean },
) {
  // When baseUrl is not configured (for example workers.dev previews),
  // the request origin is the app's own URL. After this, baseUrl is
  // always set.
  const requestConfig: AppConfig = config.baseUrl
    ? config
    : { ...config, baseUrl: new URL(request.url).origin as AppConfig["baseUrl"] };

  const context: RequestContext = {
    config: requestConfig,
    executionCtx: ctx,
    isEventDocsHost: host.isEventDocsHost,
    log: wideLogger,
    rawRequest: request,
    waitUntil: (promise) => ctx.waitUntil(promise),
  };

  return await handler.fetch(request, { context });
}

/**
 * The api pipeline: the capnweb surface at `/api`, the
 * operator-session browser auth, Slack webhooks, and project ingress
 * — every lane `decideIngressRoute` (src/ingress.ts) can resolve.
 */
async function apiFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: AppConfig,
  route: Exclude<Awaited<ReturnType<typeof decideIngressRoute>>, { lane: "os" }>,
) {
  const url = new URL(request.url);

  if (route.lane === "project") {
    // The reserved `iterate-files` platform app never reaches the project
    // worker: signed project-file URLs are served straight from R2 here.
    if (route.resolved.appSlug === FILES_APP_SLUG) {
      return await serveProjectFileRequest({
        projectId: route.resolved.projectId,
        request: new Request(route.fetch.url, {
          headers: route.fetch.headers,
          method: route.fetch.method,
        }),
      });
    }
    const init: RequestInit = {
      body: request.body,
      headers: route.fetch.headers,
      method: route.fetch.method,
      redirect: request.redirect,
    };
    if (request.body !== null) {
      (init as RequestInit & { duplex: "half" }).duplex = "half";
    }
    // Project-app HTTP is ONE transport: the fetch-native worker lane. Pages,
    // APIs, streaming bodies, and WebSocket upgrades all ride real fetch()
    // hops into the root project worker (and onward — its router re-dispatches
    // per app through `env.ITX.fetch`). Method-shaped access to the same
    // worker (`itx.worker.*`) stays on RPC dispatch; HTTP never does.
    const ref = defaultProjectWorkerRef();
    const runner = new DynamicWorkerRunner({
      exports: ctx.exports,
      projectId: route.resolved.projectId,
      scopePath: ref.path,
      waitUntil: (promise) => ctx.waitUntil(promise),
    });
    try {
      const response = await runner.fetch({
        buildBudgetMs: PROJECT_HOST_BUILD_BUDGET_MS,
        ref,
        request: new Request(route.fetch.url, init),
        traceRole: "project_config",
      });
      // HTML documents get the @iterate overlay (build status in the corner)
      // injected from the serve header the runner just stamped.
      return applyProjectWorkerOverlay(request, response);
    } catch (error) {
      // A first-ever build shows the polling "building" page rather than
      // hanging the request (the build keeps running in the builder worker);
      // a failed first-ever build shows the builder's error. Both self-heal —
      // once a good build exists, the runner serves it stale instead of
      // landing here.
      const buildStatus = workerBuildStatusResponse(error);
      if (buildStatus !== null) return buildStatus;
      throw error;
    }
  }

  if (route.lane === "notFound") {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  if (
    url.pathname === "/api/operator-sessions" ||
    url.pathname.startsWith("/api/operator-sessions/")
  ) {
    return await handleOperatorSessionRequest({
      config,
      request,
      resolveProject: async (reference) =>
        reference.startsWith("prj_")
          ? await readProjectById(env.PROJECT_DIRECTORY, reference)
          : await readProjectBySlug(env.PROJECT_DIRECTORY, reference),
    });
  }

  // Integration webhook ingress (Slack, GitHub, …) lives here (not the app
  // lane): this pipeline has the engine bindings, so a signed event routes
  // straight into the claiming project's stream without a capnweb round trip.
  const webhookResponse = await handleIntegrationWebhookApiRequest({ config, request });
  if (webhookResponse !== null) return webhookResponse;

  if (url.pathname !== "/api") return Response.json({ error: "not found" }, { status: 404 });
  const unauthenticated = new UnauthenticatedOsRpcTarget({
    config,
    ctx,
    headers: request.headers,
    requestUrl: request.url,
  });
  const itxObservability = (transport: "http" | "websocket") => {
    const sessionId = `itx_session_${crypto.randomUUID().replaceAll("-", "")}`;
    wideLogger.set({ itx: { sessionId } });
    return createItxRpcSessionOptions({
      transport,
      sessionId,
      parentLogId: wideLogger.id(),
    });
  };
  if (request.method === "POST") {
    return newHttpBatchRpcResponse(request, unauthenticated, itxObservability("http"));
  }
  return newWorkersWebSocketRpcResponse(request, unauthenticated, itxObservability("websocket"));
}

function ingressLogFields(request: Request, route: Awaited<ReturnType<typeof decideIngressRoute>>) {
  const path = new URL(request.url).pathname;
  return {
    ingress: {
      lane: route.lane,
      ...((route.lane === "api" && path === "/api") || route.lane === "project"
        ? {
            transport:
              request.headers.get("upgrade")?.toLowerCase() === "websocket"
                ? ("websocket" as const)
                : ("http" as const),
          }
        : {}),
      ...(route.lane === "project"
        ? {
            projectId: route.resolved.projectId,
            appSlug: route.resolved.appSlug ?? undefined,
          }
        : {}),
    },
  };
}

function directoryResolvers(env: Env): IngressResolvers {
  return {
    projectIdBySlug: (identifier) =>
      resolveProjectIdBySlug({ directory: env.PROJECT_DIRECTORY, identifier }),
    projectByHostname: async (host) => {
      const found = await readProjectByHostname(env.PROJECT_DIRECTORY, host);
      return found ? { appSlug: found.appSlug, projectId: found.record.id } : null;
    },
  };
}

function stripInternalHeaders(request: Request) {
  const headers = new Headers(request.headers);
  headers.delete("x-iterate-app");
  headers.delete("x-iterate-host-kind");
  headers.delete("x-itx-project-id");
  headers.delete("x-iterate-url-prefix");
  headers.delete(WORKER_FETCH_DISPATCH_HEADER);
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  return new Request(request, { headers });
}
