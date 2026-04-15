import { WorkerEntrypoint } from "cloudflare:workers";
import { env as workerEnv } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { createExternalEgressProxyFetch } from "@iterate-com/shared/apps/fetch-egress-proxy";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import handler from "@tanstack/react-start/server-entry";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import { IterateAgent } from "~/durable-objects/iterate-agent.ts";

const nativeFetch = globalThis.fetch.bind(globalThis);
const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: workerEnv,
});

if (config.externalEgressProxy) {
  // `externalEgressProxy` is an app-level runtime feature flag from
  // `BaseAppConfig`. Install the fetch override once at module scope so every
  // subrequest made by this Worker takes the same egress path.
  globalThis.fetch = createExternalEgressProxyFetch({
    fetch: nativeFetch,
    externalEgressProxy: config.externalEgressProxy,
  });
}

/**
 * Service entrypoint for {@link DynamicWorkerExecutor}'s `globalOutbound`. Nested
 * codemode workers cannot see this Worker's `globalThis.fetch`; they need a real
 * `Fetcher` binding. This forwards to the same `fetch` installed above (including
 * egress proxy when configured).
 */
export class CodemodeOutboundFetch extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> {
    return globalThis.fetch(request);
  }
}

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
        const agentResponse = await routeAgentRequest(request, env);
        if (agentResponse) {
          return agentResponse;
        }

        const context: AppContext = {
          manifest,
          config,
          env,
          rawRequest: request,
          log,
        };

        return await handler.fetch(request, { context });
      },
    );
  },
};

export { IterateAgent };
