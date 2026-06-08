import { env as workerEnv } from "cloudflare:workers";
import { newWorkersRpcResponse } from "capnweb";
import {
  PublicStreamRpcTarget,
  Stream as PackageStream,
} from "@iterate-com/streams/workers/durable-objects/stream";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import { NitroWebSocketResponse } from "@iterate-com/shared/nitro-ws-response";
import { StreamPath } from "@iterate-com/shared/streams/types.ts";
import handler from "@tanstack/react-start/server-entry";
import captunWorker, { CaptunServerShard } from "captun/worker";
import crossws from "crossws/adapters/cloudflare";
import { createD1Client } from "sqlfu";
import {
  getInitializedStreamStub,
  getStreamDurableObjectName,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/new-stream-runtime.ts";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import { getIngressRouteByHost } from "~/db/queries/.generated/index.ts";
import type { CloudflareArtifactsBinding } from "~/domains/repos/artifacts.ts";
import { seedIterateConfigBaseRepo } from "~/domains/repos/iterate-config-base-seed.ts";
import {
  dispatchFetchCallable,
  matchIngressRequest,
  normalizeIngressHost,
  parseIngressCallable,
} from "~/ingress/host-routing.ts";
import { getProjectPlatformHostIngressRule } from "~/ingress/project-platform-host-routing.ts";
import { getProjectCustomHostnameIngressRule } from "~/ingress/project-custom-hostname-routing.ts";
import type { ExactHostIngressRule } from "~/ingress/types.ts";
import { DEBUG_APPEND_CHAIN_EVENT_TYPE } from "~/durable-objects/debug-append-chain-subscriber.ts";
import { createOsIterateAuth, resolveRequestAuth } from "~/auth/middleware.ts";
import { handleMcpFetch } from "~/domains/inbound-mcp-server/mcp-handler.ts";
import { handleRootIterateContextFetch } from "~/capnweb/root-context-fetch.ts";
import { getProjectDurableObjectName } from "~/domains/projects/durable-objects/project-durable-object.ts";
import { requireProjectScopedAccess } from "~/orpc/project-access.ts";
import { resolveStreamPath } from "~/domains/streams/entrypoints/streams-capability.ts";

// Re-export rpc-targets used by OS's existing loopback callable paths.
// Stream processor subscriptions do not use these exports; they target Durable
// Object namespace env bindings directly.
export { OpenApiBridge } from "~/rpc-targets/openapi-bridge.ts";
export { OutboundMcpFromOurClientCapability } from "~/domains/outbound-mcp-client/entrypoints/outbound-mcp-from-our-client-capability.ts";
export { AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";
export { CaptunServerShard };
export { CodemodeSession } from "~/domains/codemode/durable-objects/codemode-session.ts";
export { DebugAppendChainSubscriber } from "~/durable-objects/debug-append-chain-subscriber.ts";
export { ProjectDurableObject } from "~/domains/projects/durable-objects/project-durable-object.ts";
export { ProjectMcpServerConnection } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
export { SlackAgentDurableObject } from "~/domains/slack/durable-objects/slack-agent-durable-object.ts";
export { SlackIntegrationDurableObject } from "~/domains/slack/durable-objects/slack-integration-durable-object.ts";
export { AgentCapability } from "~/domains/agents/entrypoints/agent-capability.ts";
export { AiCapability, OrpcCapability } from "~/domains/codemode/example-capabilities.ts";
export { FetchCapability } from "~/domains/codemode/fetch-capability.ts";
export { GmailCapability } from "~/domains/google/entrypoints/gmail-capability.ts";
export { IterateContextEntrypoint } from "~/capnweb/iterate-context-capability.ts";
export { ProjectCapability } from "~/domains/projects/entrypoints/project-capability.ts";
export { ProjectIngressEntrypoint } from "~/domains/projects/entrypoints/project-ingress-entrypoint.ts";
export { ProjectMcpServerEntrypoint } from "~/domains/inbound-mcp-server/entrypoints/project-mcp-server-entrypoint.ts";
export { RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";
export { RepoCapability, ReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
export { SlackCapability } from "~/domains/slack/entrypoints/slack-capability.ts";
export { SecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";
export { StreamsCapability } from "~/domains/streams/entrypoints/streams-capability.ts";
export { StreamProcessorRunner } from "~/domains/streams/durable-objects/stream-processor-runner.ts";
export { PackageStream as StreamDurableObject };
export { WorkspaceCapability } from "~/domains/workspaces/entrypoints/workspace-capability.ts";
export { WorkspaceDurableObject } from "~/domains/workspaces/durable-objects/workspace-durable-object.ts";

const CAPTUN_TUNNEL_ROUTE_PREFIX = "/__iterate/captun";
const EGRESS_ECHO_PATH = "/api/captnweb/egress-echo";
const PROJECT_CAPNWEB_PATH = "/__iterate/capnweb";
const PROJECT_STREAM_RPC_PREFIX = "/api/project-streams";
const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: workerEnv as unknown as Record<string, unknown>,
});

export default {
  async fetch(request: Request, env: Env, cfCtx: ExecutionContext) {
    const captunTunnelResponse = await handleCaptunTunnelFetch({ env, request });
    if (captunTunnelResponse) return captunTunnelResponse;

    const egressEchoResponse = handleEgressEchoFetch({ request });
    if (egressEchoResponse) return egressEchoResponse;

    const debugAppendChainResponse = await handleDebugAppendChainFetch({ request, env });
    if (debugAppendChainResponse) return debugAppendChainResponse;
    const seedIterateConfigBaseResponse = await handleSeedIterateConfigBaseFetch({ request, env });
    if (seedIterateConfigBaseResponse) return seedIterateConfigBaseResponse;

    return withEvlog(
      {
        request,
        manifest,
        config,
        executionCtx: cfCtx,
      },
      async ({ log }) => {
        const mcpResponse = await handleMcpFetch({ request, env, ctx: cfCtx, config });
        if (mcpResponse) return mcpResponse;

        const db = createD1Client(env.DB);
        const requestConfig = config.baseUrl
          ? config
          : {
              ...config,
              baseUrl: new URL(request.url).origin as AppConfig["baseUrl"],
            };
        const projectHostnameBases = config.projectHostnameBases;
        const appHostname = requestConfig.baseUrl ? new URL(requestConfig.baseUrl).hostname : null;
        const ingressMatch = await matchIngressRequest({
          request,
          lookupRule: async (host) => {
            const row = await getIngressRouteByHost(db, { host: normalizeIngressHost(host) });
            if (row) return ingressRouteRowToRule(row);

            const platformRule = await getProjectPlatformHostIngressRule({
              appHostname,
              bases: projectHostnameBases,
              db: env.DB,
              host,
            });
            if (platformRule) return platformRule;

            return await getProjectCustomHostnameIngressRule({
              appHostname,
              db: env.DB,
              host,
            });
          },
        });

        if (ingressMatch) {
          const pathname = new URL(request.url).pathname;
          if (
            (pathname === PROJECT_CAPNWEB_PATH ||
              pathname === `${PROJECT_CAPNWEB_PATH}/admin-cookie`) &&
            ingressMatch.rule.projectId
          ) {
            return await env.PROJECT.getByName(
              getProjectDurableObjectName(ingressMatch.rule.projectId),
            ).fetch(request);
          }
          return await dispatchFetchCallable({
            callable: ingressMatch.rule.callable,
            context: {
              env: env as unknown as Record<string, unknown>,
              exports: cfCtx.exports,
            },
            request,
          });
        }

        const envWithArtifacts = env as Env & { ARTIFACTS?: CloudflareArtifactsBinding };
        const context: AppContext = {
          manifest,
          config: requestConfig,
          rawRequest: request,
          db,
          doCatalog: env.DB,
          log,
          projectHostnameBases,
          waitUntil: (promise) => cfCtx.waitUntil(promise),
          agent: env.AGENT,
          artifacts: envWithArtifacts.ARTIFACTS,
          loader: env.LOADER,
          codemodeSession: env.CODEMODE_SESSION,
          callableEnv: env,
          projectDurableObjectNamespace: env.PROJECT,
          repo: env.REPO,
          slackAgent: env.SLACK_AGENT,
          slackIntegration: env.SLACK_INTEGRATION,
          stream: env.STREAM,
          workerExports: cfCtx.exports,
        };

        const projectStreamRpcResponse = await handleProjectStreamRpcFetch({
          context,
          env,
          request,
        });
        if (projectStreamRpcResponse) return projectStreamRpcResponse;

        const captnwebResponse = await handleRootIterateContextFetch({
          request,
          env,
          context,
          config,
        });
        if (captnwebResponse) return captnwebResponse;

        const durableObjectDebugResponse = await handleDurableObjectDebugFetch({ request, env });
        if (durableObjectDebugResponse) return durableObjectDebugResponse;

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
  async queue(batch: { messages: readonly unknown[]; queue: string }) {
    console.warn("[os] received unhandled queue batch", {
      messageCount: batch.messages.length,
      queue: batch.queue,
    });
  },
};

async function handleProjectStreamRpcFetch(input: {
  context: AppContext;
  env: Env;
  request: Request;
}): Promise<Response | null> {
  const route = parseProjectStreamRpcRoute(input.request);
  if (!route) return null;

  const auth = createOsIterateAuth(input.context, input.request);
  const resolvedAuth = await resolveRequestAuth({
    auth,
    context: input.context,
    request: input.request,
  });
  const context: AppContext = {
    ...input.context,
    iterateAuthSession: resolvedAuth.session,
    principal: resolvedAuth.principal,
    rawRequest: input.request,
  };
  const project = await requireProjectScopedAccess({
    context,
    projectSlugOrId: route.projectSlugOrId,
  });
  const streamPath = resolveStreamPath(route.streamPath);
  const stream = input.env.STREAM.getByName(
    getStreamDurableObjectName({
      namespace: project.id,
      path: streamPath,
    }),
  );
  const response = await newWorkersRpcResponse(input.request, new PublicStreamRpcTarget(stream));
  const setCookie = resolvedAuth.responseHeaders.get("set-cookie");
  if (setCookie) response.headers.append("set-cookie", setCookie);
  return response;
}

function parseProjectStreamRpcRoute(request: Request): {
  projectSlugOrId: string;
  streamPath: string;
} | null {
  const url = new URL(request.url);
  if (
    url.pathname !== PROJECT_STREAM_RPC_PREFIX &&
    !url.pathname.startsWith(`${PROJECT_STREAM_RPC_PREFIX}/`)
  ) {
    return null;
  }

  const remainder = url.pathname.slice(PROJECT_STREAM_RPC_PREFIX.length);
  const match = /^\/([^/]+)(?:\/(.*))?$/.exec(remainder);
  if (!match) return null;
  const projectSlugOrId = decodeURIComponent(match[1] ?? "").trim();
  if (!projectSlugOrId) return null;
  const encodedStreamPath = match[2];
  return {
    projectSlugOrId,
    streamPath:
      encodedStreamPath == null || encodedStreamPath === ""
        ? "/"
        : decodeURIComponent(encodedStreamPath),
  };
}

function handleEgressEchoFetch(input: { request: Request }) {
  const url = new URL(input.request.url);
  if (url.pathname !== EGRESS_ECHO_PATH) return null;

  const expectedToken = config.adminApiSecret?.exposeSecret();
  if (
    expectedToken == null ||
    input.request.headers.get("authorization") !== `Bearer ${expectedToken}`
  ) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  return Response.json({
    headers: Object.fromEntries(input.request.headers),
    method: input.request.method,
    url: url.toString(),
  });
}

async function handleCaptunTunnelFetch(input: { env: Env; request: Request }) {
  const url = new URL(input.request.url);
  if (
    url.pathname !== CAPTUN_TUNNEL_ROUTE_PREFIX &&
    !url.pathname.startsWith(`${CAPTUN_TUNNEL_ROUTE_PREFIX}/`)
  ) {
    return null;
  }

  url.pathname = url.pathname.slice(CAPTUN_TUNNEL_ROUTE_PREFIX.length) || "/";

  return await captunWorker.fetch(new Request(url, input.request), {
    CAPTUN_SECRET: config.adminApiSecret?.exposeSecret(),
    CaptunServerShard: input.env.CaptunServerShard,
    SHARD_COUNT: "1",
  });
}

async function handleDebugAppendChainFetch(input: { request: Request; env: Env }) {
  const url = new URL(input.request.url);
  if (url.pathname !== "/__debug/append-chain") return null;

  const expectedToken = config.adminApiSecret?.exposeSecret();
  if (expectedToken == null) {
    return Response.json({ error: "Debug endpoint is disabled." }, { status: 404 });
  }

  if (input.request.headers.get("authorization") !== `Bearer ${expectedToken}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (!hasDebugAppendChainSubscriber(input.env)) {
    return Response.json({ error: "Debug append-chain endpoint is disabled." }, { status: 404 });
  }

  const action = parseDebugAppendChainAction(url.searchParams.get("action"));
  const mode = parseDebugAppendChainMode(url.searchParams.get("mode"));
  const chainId = normalizeDebugChainId(url.searchParams.get("chainId"));
  const max = parseDebugPositiveInt(url.searchParams.get("max"), {
    defaultValue: 4,
    max: 200,
    name: "max",
  });
  const projectId = `debug-append-chain-${chainId}`;
  const streamPath = StreamPath.parse(`/debug/append-chain/${chainId}`);
  const stream = await getInitializedStreamStub({
    durableObjectNamespace: input.env.STREAM as unknown as StreamDurableObjectNamespace,
    namespace: projectId,
    path: streamPath,
  });

  const startedAt = Date.now();
  if (action === "status") {
    const history = await stream.history({ after: "start" });
    const tickEvents = history.filter((event) => event.type === DEBUG_APPEND_CHAIN_EVENT_TYPE);
    return Response.json({
      chainId,
      durationMs: Date.now() - startedAt,
      eventCount: history.length,
      max,
      mode,
      streamPath,
      tickCount: tickEvents.length,
      tickOffsets: tickEvents.map((event) => event.offset),
      ticks: tickEvents.map((event) => ({
        offset: event.offset,
        payload: event.payload,
      })),
    });
  }

  try {
    await stream.append({
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `debug-append-chain-subscription:${chainId}`,
      payload: {
        slug: `debug-append-chain:${chainId}`,
        type: "callable",
        callable: {
          type: "workers-rpc",
          via: {
            type: "env-binding",
            bindingType: "durable-object-namespace",
            bindingName: "DEBUG_APPEND_CHAIN_SUBSCRIBER",
            durableObject: { name: chainId },
          },
          rpcMethod: "afterAppend",
          argsMode: "object",
        },
      },
    });

    const triggerEvent = await stream.append({
      type: DEBUG_APPEND_CHAIN_EVENT_TYPE,
      payload: {
        chainId,
        count: 1,
        max,
        mode,
        projectId,
        streamPath,
      },
    });

    const responseBody = {
      action,
      chainId,
      durationMs: Date.now() - startedAt,
      max,
      mode,
      streamPath,
      triggerOffset: triggerEvent.offset,
    };

    console.log("[DEBUG-append-chain] endpoint.started", responseBody);
    return Response.json(responseBody);
  } catch (error) {
    return Response.json(
      {
        action,
        chainId,
        durationMs: Date.now() - startedAt,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
        max,
        mode,
        streamPath,
      },
      { status: 500 },
    );
  }
}

async function handleSeedIterateConfigBaseFetch(input: { request: Request; env: Env }) {
  const url = new URL(input.request.url);
  if (url.pathname !== "/__debug/seed-iterate-config-base") return null;

  if (input.request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }

  const expectedToken = config.adminApiSecret?.exposeSecret();
  if (expectedToken == null) {
    return Response.json({ error: "Seed endpoint is disabled." }, { status: 404 });
  }

  if (input.request.headers.get("authorization") !== `Bearer ${expectedToken}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const envWithArtifacts = input.env as Env & { ARTIFACTS?: CloudflareArtifactsBinding };
  if (!envWithArtifacts.ARTIFACTS) {
    return Response.json({ error: "ARTIFACTS binding is not configured." }, { status: 500 });
  }
  if (!input.env.ARTIFACTS_ACCOUNT_ID || !input.env.ARTIFACTS_NAMESPACE) {
    return Response.json(
      { error: "Artifacts account and namespace bindings are not configured." },
      { status: 500 },
    );
  }

  try {
    return Response.json(
      await seedIterateConfigBaseRepo({
        accountId: input.env.ARTIFACTS_ACCOUNT_ID,
        artifacts: envWithArtifacts.ARTIFACTS,
        namespace: input.env.ARTIFACTS_NAMESPACE,
      }),
    );
  } catch (error) {
    return Response.json(
      {
        error: {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : "Error",
          stack: error instanceof Error ? error.stack : undefined,
        },
      },
      { status: 500 },
    );
  }
}

function hasDebugAppendChainSubscriber(env: Env) {
  return (
    (env as Partial<Env> & { DEBUG_APPEND_CHAIN_SUBSCRIBER?: DurableObjectNamespace })
      .DEBUG_APPEND_CHAIN_SUBSCRIBER != null
  );
}

function parseDebugAppendChainAction(value: string | null): "start" | "status" {
  if (value == null || value === "" || value === "start") return "start";
  if (value === "status") return "status";
  throw new Error('action must be "start" or "status".');
}

function parseDebugAppendChainMode(value: string | null): "alarm" | "sync" {
  if (value == null || value === "" || value === "sync") return "sync";
  if (value === "alarm") return "alarm";
  throw new Error('mode must be "sync" or "alarm".');
}

function parseDebugPositiveInt(
  value: string | null,
  options: { defaultValue: number; max: number; name: string },
) {
  if (value == null || value === "") return options.defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > options.max) {
    throw new Error(`${options.name} must be an integer from 1 to ${options.max}.`);
  }
  return parsed;
}

function normalizeDebugChainId(value: string | null) {
  const candidate = value ?? crypto.randomUUID().replaceAll("-", "");
  const normalized = candidate
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 64);
  if (!normalized) throw new Error("chainId must contain at least one URL-safe character.");
  return normalized;
}

function ingressRouteRowToRule(row: {
  id: string;
  host: string;
  project_id?: string | null;
  priority: number;
  notes?: string | null;
  callable_json: string;
  created_at: string;
  updated_at: string;
}): ExactHostIngressRule {
  return {
    id: row.id,
    host: row.host,
    projectId: row.project_id ?? null,
    priority: row.priority,
    notes: row.notes ?? null,
    callable: parseIngressCallable(row.callable_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function handleDurableObjectDebugFetch(input: { request: Request; env: Env }) {
  const url = new URL(input.request.url);
  const match = url.pathname.match(/^\/__durable-objects\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!match) return null;

  const objectKind = match[1];
  const objectName = decodeURIComponent(match[2] ?? "");
  const targetPath = match[3] ?? "/";
  const namespace = readDebugDurableObjectNamespace(input.env, objectKind);
  if (!namespace) {
    return new Response(`Unknown Durable Object debug namespace: ${objectKind}`, { status: 404 });
  }

  const targetUrl = new URL(input.request.url);
  targetUrl.pathname = targetPath;
  const stub = namespace.getByName(objectName);
  return await stub.fetch(new Request(targetUrl, input.request));
}

type DebugDurableObjectNamespace = {
  getByName(name: string): {
    fetch(request: Request): Promise<Response>;
  };
};

function readDebugDurableObjectNamespace(
  env: Env,
  objectKind: string,
): DebugDurableObjectNamespace | null {
  switch (objectKind) {
    case "codemode-session":
      return env.CODEMODE_SESSION as unknown as DebugDurableObjectNamespace;
    case "project":
      return env.PROJECT as unknown as DebugDurableObjectNamespace;
    case "project-mcp-server-connection":
      return env.PROJECT_MCP_SERVER_CONNECTION as unknown as DebugDurableObjectNamespace;
    case "stream":
      return env.STREAM as unknown as DebugDurableObjectNamespace;
    default:
      return null;
  }
}
