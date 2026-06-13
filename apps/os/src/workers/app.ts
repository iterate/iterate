/**
 * The app worker: the OS dashboard — TanStack Start (SSR + server functions),
 * static assets, debug routes, stream RPC, and app-host itx.
 *
 * In the per-DO worker topology (docs/worker-topology.md) this worker has no
 * routes and no Durable Objects: the ingress worker forwards app-host
 * traffic here, and every DO namespace binding is cross-script. In local
 * dev the browser talks to vite — i.e. to this worker directly — so the
 * shared router runs here first and forwards project-host/MCP traffic over
 * the same service bindings the ingress worker uses in production.
 *
 * Worker bindings are intentionally not threaded through request context —
 * modules import `env` from "cloudflare:workers" directly:
 * https://developers.cloudflare.com/workers/runtime-apis/bindings/#importing-env-as-a-global
 */
import handler from "@tanstack/react-start/server-entry";
import { withEvlog } from "@iterate-com/shared/evlog";
import { createD1Client } from "sqlfu";
import { ROUTED_LANE_HEADER, routeOsRequest } from "./shared/router.ts";
import { AppConfig, parseConfig } from "~/config.ts";
import type { RequestContext } from "~/request-context.ts";
import { handleDebugRoutes, handleDurableObjectDebugFetch } from "~/debug-routes.ts";
import { handleAdminStreamRpcFetch } from "~/domains/streams/admin-stream-rpc.ts";
import { handleProjectStreamRpcFetch } from "~/domains/streams/project-stream-rpc.ts";
import { handleItxFetch } from "~/itx/fetch.ts";
import { handleDocsMarkdownFetch } from "~/lib/docs-markdown.ts";

export * from "./shared/loopback-exports.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Parse config per request, not at module scope: workerd may reuse an
    // isolate across binding-only deploys, so a module-scope copy can serve
    // stale secrets after a rotation. Parsing is pure and cheap.
    // https://developers.cloudflare.com/workers/runtime-apis/bindings/#how-bindings-work
    const config = parseConfig(env);

    const earlyResponse = await handleDebugRoutes({ request, env, config });
    if (earlyResponse) return earlyResponse;

    // Everything below emits one structured "wide event" log line per request.
    return withEvlog(
      { request, app: { name: "@iterate-com/os", slug: "os" }, config, executionCtx: ctx },
      async ({ log }) => {
        // Deployed, the ingress worker has already classified the request
        // (ROUTED_LANE_HEADER) — this re-route only runs when the browser
        // talks to this worker directly (local dev, workers.dev previews),
        // forwarding project-host/MCP traffic exactly like ingress would.
        if (!request.headers.get(ROUTED_LANE_HEADER)) {
          const routed = await routeOsRequest({
            config,
            db: env.DB,
            request,
            targets: { MCP: env.MCP, PROJECT_HOST: env.PROJECT_HOST },
          });
          if (routed) return routed;
        }

        // When baseUrl is not configured (dev tunnels, previews), the request
        // origin is the app's own URL. After this, baseUrl is always set.
        const requestConfig: AppConfig = config.baseUrl
          ? config
          : { ...config, baseUrl: new URL(request.url).origin as AppConfig["baseUrl"] };

        const docsMarkdownResponse = handleDocsMarkdownFetch({
          appBaseUrl: requestConfig.baseUrl,
          request,
        });
        if (docsMarkdownResponse) return docsMarkdownResponse;

        const db = createD1Client(env.DB);
        const context: RequestContext = {
          config: requestConfig,
          db,
          log,
          rawRequest: request,
          waitUntil: (promise) => ctx.waitUntil(promise),
          workerExports: ctx.exports,
        };

        const streamRpcResponse = await handleProjectStreamRpcFetch({ context, env, request });
        if (streamRpcResponse) return streamRpcResponse;

        const adminStreamRpcResponse = await handleAdminStreamRpcFetch({
          config: requestConfig,
          context,
          env,
          request,
        });
        if (adminStreamRpcResponse) return adminStreamRpcResponse;

        const itxResponse = await handleItxFetch({ config, context, env, request });
        if (itxResponse) return itxResponse;

        const durableObjectDebugResponse = await handleDurableObjectDebugFetch({
          request,
          env,
          config,
        });
        if (durableObjectDebugResponse) return durableObjectDebugResponse;

        // The TanStack Start app: SSR routes and server functions, plus the
        // remaining /api routes (integration callbacks, health). `context`
        // becomes the Start request context (see src/request-context.ts for the
        // Register augmentation).
        return await handler.fetch(request, { context });
      },
    );
  },
};
