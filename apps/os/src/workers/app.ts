/**
 * The app worker: the OS dashboard — TanStack Start (SSR + server functions)
 * and static assets.
 *
 * In the per-worker topology (docs/worker-topology.md) this worker has no
 * routes and no Durable Objects: the ingress worker forwards app-host
 * traffic here. In local dev the browser talks to vite — i.e. to this worker
 * directly — so the shared itx routing decision runs here first and
 * forwards engine/project-host traffic over the same ITX_API service
 * binding the ingress worker uses in production.
 *
 * Worker bindings are intentionally not threaded through request context —
 * modules import `env` from "cloudflare:workers" directly:
 * https://developers.cloudflare.com/workers/runtime-apis/bindings/#importing-env-as-a-global
 */
import handler from "@tanstack/react-start/server-entry";
import { withEvlog } from "@iterate-com/shared/evlog";
import { AppConfig, parseConfig } from "~/config.ts";
import type { RequestContext } from "~/request-context.ts";
import { apiWorkerRequest } from "~/ingress.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Parse config per request, not at module scope: workerd may reuse an
    // isolate across binding-only deploys, so a module-scope copy can serve
    // stale secrets after a rotation. Parsing is pure and cheap.
    // https://developers.cloudflare.com/workers/runtime-apis/bindings/#how-bindings-work
    const config = parseConfig(env);

    // Itx lanes (local dev talks to this worker directly, so the
    // forward lives here as well as in the ingress worker): the capnweb
    // surface + fixtures + `/prj_` path lanes, and project platform hosts.
    const nextRequest = apiWorkerRequest({ config, request });
    if (nextRequest) return await env.ITX_API.fetch(nextRequest);

    // Everything below emits one structured "wide event" log line per request.
    return withEvlog(
      { request, app: { name: "@iterate-com/os", slug: "os" }, config, executionCtx: ctx },
      async ({ log }) => {
        // When baseUrl is not configured (for example workers.dev previews),
        // the request origin is the app's own URL. After this, baseUrl is always set.
        const requestConfig: AppConfig = config.baseUrl
          ? config
          : { ...config, baseUrl: new URL(request.url).origin as AppConfig["baseUrl"] };

        const context: RequestContext = {
          config: requestConfig,
          log,
          rawRequest: request,
          waitUntil: (promise) => ctx.waitUntil(promise),
        };

        // The TanStack Start app: SSR routes and server functions, plus the
        // remaining /api routes (inbound MCP, health). `context` becomes the
        // Start request context (see src/request-context.ts for the Register
        // augmentation).
        return await handler.fetch(request, { context });
      },
    );
  },
};
