import { env as workerEnv } from "cloudflare:workers";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import { routeDurableObjectRequest } from "@iterate-com/shared/durable-object-utils/mixins/with-public-fetch-route";
import handler from "@tanstack/react-start/server-entry";
import { drizzle as drizzleWorkerd } from "drizzle-orm/d1";
import crossws from "crossws/adapters/cloudflare";
import { NitroWebSocketResponse } from "@iterate-com/shared/nitro-ws-response";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import * as schema from "~/db/schema.ts";
import { ExampleCounter } from "~/durable-objects/example-counter.ts";
import { COUNTER_DURABLE_OBJECT_NAMESPACE_SLUG } from "~/lib/counter-durable-objects.ts";

const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: workerEnv,
});
const db = drizzleWorkerd(workerEnv.DB, { schema });

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
        const url = new URL(request.url);
        if (isCounterDurableObjectPublicPath(url.pathname)) {
          const durableObjectResponse = await routeDurableObjectRequest(request, [
            {
              namespaceSlug: COUNTER_DURABLE_OBJECT_NAMESPACE_SLUG,
              namespace: env.EXAMPLE_COUNTER,
            },
          ]);
          if (durableObjectResponse) {
            return durableObjectResponse;
          }
        }

        const context: AppContext = {
          manifest,
          config,
          rawRequest: request,
          db,
          log,
          workerEnv: env,
        };

        const response = await handler.fetch(request, {
          context,
        });
        if (response instanceof NitroWebSocketResponse) {
          return crossws({ hooks: response.crossws }).handleUpgrade(request, env, cfCtx);
        }

        return response;
      },
    );
  },
};

export { ExampleCounter };

function isCounterDurableObjectPublicPath(pathname: string) {
  const namespacePrefix = `/durable-objects/${COUNTER_DURABLE_OBJECT_NAMESPACE_SLUG}/`;

  return (
    pathname.startsWith(`${namespacePrefix}by-name/`) ||
    pathname.startsWith(`${namespacePrefix}by-id/`) ||
    pathname.startsWith(`${namespacePrefix}by-init-params/`)
  );
}
