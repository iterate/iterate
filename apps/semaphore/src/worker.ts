/**
 * Cloudflare Worker entry for semaphore: a TanStack Start app (SSR + oRPC API)
 * fronting the resource-leasing durable object.
 */
import handler from "@tanstack/react-start/server-entry";
import { withEvlog } from "@iterate-com/shared/evlog";
import { parseConfig } from "~/config.ts";
import type { RequestContext } from "~/request-context.ts";
import type { Env } from "~/env.ts";
import { ResourceCoordinator } from "~/durable-objects/resource-coordinator.ts";

export async function handleSemaphoreRequest(
  request: Request,
  env: Env,
  executionCtx: ExecutionContext,
) {
  // Parsed per request, NOT at module scope (matching apps/os): a fresh
  // DO-class worker's first deploy is a secrets-less bootstrap (see
  // scripts/lib/deploy-helpers.ts), and a module-scope parse would fail
  // Cloudflare's startup validation on that version before the secrets land.
  const config = parseConfig(env);
  return withEvlog(
    { request, app: { name: "@iterate-com/semaphore", slug: "semaphore" }, config, executionCtx },
    async ({ log }) => {
      const context: RequestContext = {
        config,
        rawRequest: request,
        db: env.DB,
        log,
      };
      const response = await handler.fetch(request, { context });
      if (new URL(request.url).pathname !== "/api/__internal/health") return response;

      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      headers.set("x-iterate-worker-version", env.CF_VERSION_METADATA.id);
      return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      });
    },
  );
}

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
    return handleSemaphoreRequest(request, env, executionCtx);
  },
};

export { ResourceCoordinator };
