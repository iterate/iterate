import { WorkerEntrypoint } from "cloudflare:workers";
import { env as workerEnv } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { createExternalEgressProxyFetch } from "@iterate-com/shared/apps/fetch-egress-proxy";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import handler from "@tanstack/react-start/server-entry";
import { drizzle as drizzleWorkerd } from "drizzle-orm/d1";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import * as schema from "~/db/schema.ts";
import { AgentChatStreamProcessorRunner } from "~/durable-objects/agent-chat-stream-processor-runner.ts";
import { AgentStreamProcessorRunner } from "~/durable-objects/agent-stream-processor-runner.ts";
import { ChildStreamAutoSubscriber } from "~/durable-objects/child-stream-auto-subscriber.ts";
import { CloudflareAiStreamProcessorRunner } from "~/durable-objects/cloudflare-ai-stream-processor-runner.ts";
import { CodemodeStreamProcessorRunner } from "~/durable-objects/codemode-stream-processor-runner.ts";
import { MCPClient } from "~/durable-objects/mcp-client.ts";
import { OpenApiToolClient } from "~/durable-objects/openapi-tool-client.ts";
import { OpenAiWsStreamProcessorRunner } from "~/durable-objects/openai-ws-stream-processor-runner.ts";
import { SlackApi } from "~/durable-objects/slack-api.ts";
import { StreamApi } from "~/entrypoints/stream-api.ts";
import {
  handleAgentChatStreamProcessorRunnerSocket,
  handleAgentStreamProcessorRunnerSocket,
  handleCloudflareAiStreamProcessorRunnerSocket,
  handleCodemodeStreamProcessorRunnerSocket,
  handleOpenAiWsStreamProcessorRunnerSocket,
} from "~/server/agent-stream-processor-runner-socket.ts";

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
        const runnerSocketResponse =
          (await handleAgentStreamProcessorRunnerSocket({
            env,
            request,
          })) ??
          (await handleCloudflareAiStreamProcessorRunnerSocket({
            env,
            request,
          })) ??
          (await handleOpenAiWsStreamProcessorRunnerSocket({
            env,
            request,
          })) ??
          (await handleCodemodeStreamProcessorRunnerSocket({
            env,
            request,
          })) ??
          (await handleAgentChatStreamProcessorRunnerSocket({
            env,
            request,
          }));
        if (runnerSocketResponse) {
          return runnerSocketResponse;
        }

        const agentResponse = await routeAgentRequest(request, env);
        if (agentResponse) {
          return agentResponse;
        }

        const db = drizzleWorkerd(env.DB, { schema });
        const context: AppContext = {
          manifest,
          config,
          env,
          db,
          rawRequest: request,
          log,
        };

        return await handler.fetch(request, { context });
      },
    );
  },
};

export {
  AgentChatStreamProcessorRunner,
  AgentStreamProcessorRunner,
  ChildStreamAutoSubscriber,
  CloudflareAiStreamProcessorRunner,
  CodemodeStreamProcessorRunner,
  MCPClient,
  OpenApiToolClient,
  OpenAiWsStreamProcessorRunner,
  SlackApi,
  StreamApi,
};
