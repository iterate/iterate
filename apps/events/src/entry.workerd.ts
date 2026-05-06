import { env as workerEnv } from "cloudflare:workers";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import {
  registerDurableObjectPublicRoute,
  routeDurableObjectRequest,
} from "@iterate-com/shared/durable-object-utils/mixins/with-public-fetch-route";
import { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import handler from "@tanstack/react-start/server-entry";
import { createD1Client } from "sqlfu";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";

const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: workerEnv,
});

export default {
  async fetch(request: Request, env: Env, cfCtx: ExecutionContext) {
    const durableObjectResponse = await routeDurableObjectRequest(request, [
      registerDurableObjectPublicRoute({
        namespace: env.STREAM as never,
        class: StreamDurableObject as never,
      }),
    ]);
    if (durableObjectResponse !== undefined) {
      return durableObjectResponse;
    }

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

export { StreamDurableObject };
