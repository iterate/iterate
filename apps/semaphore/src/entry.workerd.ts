import { env as workerEnv } from "cloudflare:workers";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import handler from "@tanstack/react-start/server-entry";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import type { Env } from "~/env.ts";
import { ResourceCoordinator } from "~/durable-objects/resource-coordinator.ts";

const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: workerEnv as Record<string, unknown>,
});

export async function handleSemaphoreRequest(
  request: Request,
  env: Env,
  executionCtx: ExecutionContext,
) {
  return withEvlog(
    {
      request,
      manifest,
      config,
      executionCtx,
    },
    async ({ log }) => {
      const context: AppContext = {
        manifest,
        config,
        env,
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
