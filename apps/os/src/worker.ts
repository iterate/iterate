/**
 * Cloudflare Worker entry for OS.
 *
 * One worker serves three kinds of traffic, dispatched on hostname and path:
 *
 * 1. Infrastructure routes that bypass the app entirely (captun tunnel,
 *    admin-token debug endpoints).
 * 2. Project ingress: requests to project hosts (`<slug>.iterate.app`,
 *    custom hostnames) are routed to the project's durable object / callable.
 * 3. The OS dashboard itself: a TanStack Start app (SSR + oRPC API), handled
 *    by `@tanstack/react-start/server-entry` with a per-request context.
 *
 * Worker bindings are intentionally not threaded through request context —
 * modules import `env` from "cloudflare:workers" directly:
 * https://developers.cloudflare.com/workers/runtime-apis/bindings/#importing-env-as-a-global
 */
import handler from "@tanstack/react-start/server-entry";
import { withEvlog } from "@iterate-com/shared/evlog";
import { NitroWebSocketResponse } from "@iterate-com/shared/nitro-ws-response";
import { Stream as PackageStream } from "@iterate-com/streams/workers/durable-objects/stream";
import captunWorker, { CaptunServerShard } from "captun/worker";
import crossws from "crossws/adapters/cloudflare";
import { createD1Client } from "sqlfu";
import { AppConfig, parseConfig } from "~/config.ts";
import type { RequestContext } from "~/request-context.ts";
import { handleDebugRoutes, handleDurableObjectDebugFetch } from "~/debug-routes.ts";
import { dispatchFetchCallable, matchIngressRequest } from "~/ingress/host-routing.ts";
import { lookupIngressRule } from "~/ingress/lookup.ts";
import { handleMcpFetch } from "~/domains/inbound-mcp-server/mcp-handler.ts";
import { handleRootIterateContextFetch } from "~/capnweb/root-context-fetch.ts";
import { handleProjectStreamRpcFetch } from "~/domains/streams/project-stream-rpc.ts";
import { getProjectDurableObjectName } from "~/domains/projects/durable-objects/project-durable-object.ts";

// Durable objects and RPC entrypoints must be exported from the worker's main
// module so the runtime can find the classes the bindings refer to:
// https://developers.cloudflare.com/durable-objects/get-started/
export { AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";
export { CodemodeSession } from "~/domains/codemode/durable-objects/codemode-session.ts";
export { DebugAppendChainSubscriber } from "~/durable-objects/debug-append-chain-subscriber.ts";
export { ProjectDurableObject } from "~/domains/projects/durable-objects/project-durable-object.ts";
export { ProjectMcpServerConnection } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
export { RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";
export { SlackAgentDurableObject } from "~/domains/slack/durable-objects/slack-agent-durable-object.ts";
export { SlackIntegrationDurableObject } from "~/domains/slack/durable-objects/slack-integration-durable-object.ts";
export { StreamProcessorRunner } from "~/domains/streams/durable-objects/stream-processor-runner.ts";
export { WorkspaceDurableObject } from "~/domains/workspaces/durable-objects/workspace-durable-object.ts";
export { CaptunServerShard };
export { PackageStream as StreamDurableObject };

export { AgentCapability } from "~/domains/agents/entrypoints/agent-capability.ts";
export { AiCapability, OrpcCapability } from "~/domains/codemode/example-capabilities.ts";
export { FetchCapability } from "~/domains/codemode/fetch-capability.ts";
export { GmailCapability } from "~/domains/google/entrypoints/gmail-capability.ts";
export { IterateContextEntrypoint } from "~/capnweb/iterate-context-capability.ts";
export { OpenApiBridge } from "~/rpc-targets/openapi-bridge.ts";
export { OutboundMcpFromOurClientCapability } from "~/domains/outbound-mcp-client/entrypoints/outbound-mcp-from-our-client-capability.ts";
export { ProjectCapability } from "~/domains/projects/entrypoints/project-capability.ts";
export { ProjectIngressEntrypoint } from "~/domains/projects/entrypoints/project-ingress-entrypoint.ts";
export { ProjectMcpServerEntrypoint } from "~/domains/inbound-mcp-server/entrypoints/project-mcp-server-entrypoint.ts";
export { RepoCapability, ReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
export { SecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";
export { SlackCapability } from "~/domains/slack/entrypoints/slack-capability.ts";
export { StreamsCapability } from "~/domains/streams/entrypoints/streams-capability.ts";
export { WorkspaceCapability } from "~/domains/workspaces/entrypoints/workspace-capability.ts";

const CAPTUN_TUNNEL_ROUTE_PREFIX = "/__iterate/captun";
const PROJECT_CAPNWEB_PATH = "/__iterate/capnweb";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Parse config per request, not at module scope: workerd may reuse an
    // isolate across binding-only deploys, so a module-scope copy can serve
    // stale secrets after a rotation. Parsing is pure and cheap.
    // https://developers.cloudflare.com/workers/runtime-apis/bindings/#how-bindings-work
    const config = parseConfig(env);

    const earlyResponse =
      (await handleCaptunTunnelFetch(request, env, config)) ??
      (await handleDebugRoutes({ request, env, config }));
    if (earlyResponse) return earlyResponse;

    // Everything below emits one structured "wide event" log line per request.
    return withEvlog(
      { request, app: { name: "@iterate-com/os", slug: "os" }, config, executionCtx: ctx },
      async ({ log }) => {
        const mcpResponse = await handleMcpFetch({ request, env, ctx, config });
        if (mcpResponse) return mcpResponse;

        // When baseUrl is not configured (dev tunnels, previews), the request
        // origin is the app's own URL. After this, baseUrl is always set.
        const requestConfig: AppConfig = config.baseUrl
          ? config
          : { ...config, baseUrl: new URL(request.url).origin as AppConfig["baseUrl"] };
        const appHostname = new URL(requestConfig.baseUrl!).hostname;

        const db = createD1Client(env.DB);

        // Project hosts (<slug>.iterate.app, custom hostnames) never reach the
        // dashboard app — they dispatch to the project's callable or durable object.
        const ingressMatch = await matchIngressRequest({
          request,
          lookupRule: (host) =>
            lookupIngressRule({
              appHostname,
              db,
              doCatalog: env.DB,
              host,
              projectHostnameBases: config.projectHostnameBases,
            }),
        });
        if (ingressMatch) {
          const pathname = new URL(request.url).pathname;
          const projectId = ingressMatch.rule.projectId;
          const servesProjectCapnweb =
            projectId &&
            (pathname === PROJECT_CAPNWEB_PATH ||
              pathname === `${PROJECT_CAPNWEB_PATH}/admin-cookie`);
          if (servesProjectCapnweb) {
            return await env.PROJECT.getByName(getProjectDurableObjectName(projectId)).fetch(
              request,
            );
          }
          return await dispatchFetchCallable({
            callable: ingressMatch.rule.callable,
            context: {
              env: env as unknown as Record<string, unknown>,
              exports: ctx.exports,
            },
            request,
          });
        }

        const context: RequestContext = {
          config: requestConfig,
          db,
          log,
          rawRequest: request,
          waitUntil: (promise) => ctx.waitUntil(promise),
          workerExports: ctx.exports,
        };

        const streamRpcResponse = await handleProjectStreamRpcFetch({ context, env, request });
        if (streamRpcResponse) return streamRpcResponse;

        const capnwebResponse = await handleRootIterateContextFetch({
          request,
          env,
          context,
          config,
        });
        if (capnwebResponse) return capnwebResponse;

        const durableObjectDebugResponse = await handleDurableObjectDebugFetch({
          request,
          env,
          config,
        });
        if (durableObjectDebugResponse) return durableObjectDebugResponse;

        // The TanStack Start app: SSR routes, server functions, and the oRPC
        // API under /api. `context` becomes the Start request context (see
        // src/request-context.ts for the Register augmentation).
        const response = await handler.fetch(request, { context });
        if (response instanceof NitroWebSocketResponse) {
          return crossws({ hooks: response.crossws }).handleUpgrade(request, env, ctx);
        }
        return response;
      },
    );
  },

  async queue(batch: { messages: readonly unknown[]; queue: string }) {
    console.warn("[os] received unhandled queue batch", {
      messageCount: batch.messages.length,
      queue: batch.queue,
    });
  },
};

/** Serve the captun tunnel relay mounted under /__iterate/captun. */
async function handleCaptunTunnelFetch(request: Request, env: Env, config: AppConfig) {
  const url = new URL(request.url);
  if (
    url.pathname !== CAPTUN_TUNNEL_ROUTE_PREFIX &&
    !url.pathname.startsWith(`${CAPTUN_TUNNEL_ROUTE_PREFIX}/`)
  ) {
    return null;
  }

  url.pathname = url.pathname.slice(CAPTUN_TUNNEL_ROUTE_PREFIX.length) || "/";

  return await captunWorker.fetch(new Request(url, request), {
    CAPTUN_SECRET: config.adminApiSecret?.exposeSecret(),
    CaptunServerShard: env.CaptunServerShard,
    SHARD_COUNT: "1",
  });
}
