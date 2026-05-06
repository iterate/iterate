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
import { E2EAppendChainSubscriber } from "~/durable-objects/e2e-append-chain-subscriber.ts";

const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: workerEnv,
});

export default {
  async fetch(request: Request, env: Env, cfCtx: ExecutionContext) {
    const e2eSubscriberResponse = await routeE2EAppendChainSubscriberStatus(request, env);
    if (e2eSubscriberResponse !== undefined) {
      return e2eSubscriberResponse;
    }

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

export { E2EAppendChainSubscriber, StreamDurableObject };

async function routeE2EAppendChainSubscriberStatus(request: Request, env: Env) {
  // This route is test-only infrastructure for deployed preview e2e coverage.
  // Production alchemy deploys omit the binding, which also keeps the
  // unauthenticated status endpoint out of the production worker surface.
  if (!("E2E_APPEND_CHAIN_SUBSCRIBER" in env)) {
    return undefined;
  }

  const url = new URL(request.url);
  const prefix = "/__e2e/append-chain-subscriber/";
  if (!url.pathname.startsWith(prefix) || !url.pathname.endsWith("/status")) {
    return undefined;
  }

  const name = decodeURIComponent(url.pathname.slice(prefix.length, -"/status".length));
  if (name.trim() === "") {
    return Response.json({ error: "Missing subscriber name" }, { status: 400 });
  }

  const namespace =
    env.E2E_APPEND_CHAIN_SUBSCRIBER as DurableObjectNamespace<E2EAppendChainSubscriber>;
  const stub = namespace.get(namespace.idFromName(name));
  return await stub.fetch(new Request("https://e2e-append-chain-subscriber.local/status", request));
}
