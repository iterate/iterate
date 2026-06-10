/**
 * Cloudflare Worker entry for semaphore: a TanStack Start app (SSR + oRPC API)
 * fronting the resource-leasing durable object.
 */
import { env as workerEnv } from "cloudflare:workers";
import handler from "@tanstack/react-start/server-entry";
import { withEvlog } from "@iterate-com/shared/evlog";
import { parseConfig } from "~/config.ts";
import type { RequestContext } from "~/request-context.ts";
import type { Env } from "~/env.ts";
import { ResourceCoordinator } from "~/durable-objects/resource-coordinator.ts";

const config = parseConfig(workerEnv);

export async function handleSemaphoreRequest(
  request: Request,
  env: Env,
  executionCtx: ExecutionContext,
) {
  return withEvlog(
    { request, app: { name: "@iterate-com/semaphore", slug: "semaphore" }, config, executionCtx },
    async ({ log }) => {
      const context: RequestContext = {
        config,
        rawRequest: request,
        db: env.DB,
        log,
      };
      return handler.fetch(request, { context });
    },
  );
}

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
    return handleSemaphoreRequest(request, env, executionCtx);
  },
};

export { ResourceCoordinator };
