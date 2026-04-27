import { env as workerEnv } from "cloudflare:workers";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import handler from "@tanstack/react-start/server-entry";
import { createD1Client } from "sqlfu";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import { DynamicWorkerEgressGateway } from "~/dynamic-worker-egress-gateway.ts";
import { StreamDurableObject } from "~/durable-objects/stream.ts";

const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: workerEnv,
});

export default {
  async fetch(request: Request, env: Env, cfCtx: ExecutionContext) {
    return withEvlog(
      {
        request,
        manifest,
        config,
        executionCtx: cfCtx,
      },
      async ({ log }) => {
        const db = createD1Client(env.DB);
        const context: AppContext = {
          manifest,
          config,
          env,
          rawRequest: request,
          db,
          log,
        };

        return await handler.fetch(request, { context });
      },
    );
  },
};

export { DynamicWorkerEgressGateway, StreamDurableObject };
