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
import { handleArtifactEventsBatch } from "~/domains/repos/artifact-events-queue-handler.ts";
import { handleItxFetch, handleProjectHostItxFetch } from "~/itx/fetch.ts";
import { handleAdminStreamRpcFetch } from "~/domains/streams/admin-stream-rpc.ts";
import { handleProjectStreamRpcFetch } from "~/domains/streams/project-stream-rpc.ts";
import { handleDocsMarkdownFetch } from "~/lib/docs-markdown.ts";

// Durable objects and RPC entrypoints must be exported from the worker's main
// module so the runtime can find the classes the bindings refer to:
// https://developers.cloudflare.com/durable-objects/get-started/
export { AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";
export { CodemodeSession } from "~/durable-objects/codemode-session-tombstone.ts";
export { DebugAppendChainSubscriber } from "~/durable-objects/debug-append-chain-subscriber.ts";
export { ProjectDurableObject } from "~/domains/projects/durable-objects/project-durable-object.ts";
export { ProjectMcpServerConnection } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
export { RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";
export { SlackAgentDurableObject } from "~/domains/slack/durable-objects/slack-agent-durable-object.ts";
export { SlackIntegrationDurableObject } from "~/domains/slack/durable-objects/slack-integration-durable-object.ts";
export { WorkspaceDurableObject } from "~/domains/workspaces/durable-objects/workspace-durable-object.ts";
export { CaptunServerShard };
export { PackageStream as StreamDurableObject };

export { AgentCapability } from "~/domains/agents/entrypoints/agent-capability.ts";
export { AgentToolsCapability } from "~/domains/agents/entrypoints/agent-tools-capability.ts";
export { AiCapability, OrpcCapability } from "~/rpc-targets/os-capabilities.ts";
export { GmailCapability } from "~/domains/google/entrypoints/gmail-capability.ts";
export { BindingCapability, ItxEntrypoint, ProjectEgress } from "~/itx/entrypoint.ts";
export { McpClient } from "~/itx/caps/mcp-client.ts";
export { ContextDO } from "~/itx/context-do.ts";
export { ItxCapIngress } from "~/itx/http.ts";
export { OpenApiBridge } from "~/rpc-targets/openapi-bridge.ts";
export { ProjectCapability } from "~/domains/projects/entrypoints/project-capability.ts";
export { ProjectIngressEntrypoint } from "~/domains/projects/entrypoints/project-ingress-entrypoint.ts";
export { ProjectMcpServerEntrypoint } from "~/domains/inbound-mcp-server/entrypoints/project-mcp-server-entrypoint.ts";
export { RepoCapability, ReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
export { SecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";
export { SlackCapability } from "~/domains/slack/entrypoints/slack-capability.ts";
export { StreamsCapability } from "~/domains/streams/entrypoints/streams-capability.ts";
export { WorkspaceCapability } from "~/domains/workspaces/entrypoints/workspace-capability.ts";

const CAPTUN_TUNNEL_ROUTE_PREFIX = "/__iterate/captun";

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
          // Project-host itx sessions terminate HERE in the stateless worker,
          // never in the Project DO (itx Law 7 — the hibernation-ready seam).
          if (ingressMatch.rule.projectId) {
            const projectItxResponse = await handleProjectHostItxFetch({
              config: requestConfig,
              env,
              exports: ctx.exports,
              projectId: ingressMatch.rule.projectId,
              request,
            });
            if (projectItxResponse) return projectItxResponse;
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

        const docsMarkdownResponse = handleDocsMarkdownFetch({
          appBaseUrl: requestConfig.baseUrl,
          request,
        });
        if (docsMarkdownResponse) return docsMarkdownResponse;

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

        const adminStreamRpcResponse = await handleAdminStreamRpcFetch({
          config: requestConfig,
          context,
          env,
          request,
        });
        if (adminStreamRpcResponse) return adminStreamRpcResponse;

        const itxResponse = await handleItxFetch({ config, context, env, request });
        if (itxResponse) return itxResponse;

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

  async queue(batch: MessageBatch, env: Env) {
    if (batch.queue.endsWith("-artifact-events")) {
      await handleArtifactEventsBatch(batch, env);
      return;
    }
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
