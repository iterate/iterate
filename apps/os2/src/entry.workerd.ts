import { env as workerEnv } from "cloudflare:workers";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { withEvlog } from "@iterate-com/shared/apps/logging/with-evlog";
import { NitroWebSocketResponse } from "@iterate-com/shared/nitro-ws-response";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers.ts";
import { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import {
  STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
  StreamPath,
} from "@iterate-com/shared/streams/types.ts";
import handler from "@tanstack/react-start/server-entry";
import crossws from "crossws/adapters/cloudflare";
import { createD1Client } from "sqlfu";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import { getIngressRouteByHost } from "~/db/queries/.generated/index.ts";
import {
  dispatchFetchCallable,
  matchIngressRequest,
  normalizeIngressHost,
  parseIngressCallable,
} from "~/ingress/host-routing.ts";
import type { ExactHostIngressRule } from "~/ingress/types.ts";
import { DEBUG_APPEND_CHAIN_EVENT_TYPE } from "~/durable-objects/debug-append-chain-subscriber.ts";

// Re-export rpc-targets used by OS2's existing loopback callable paths.
// Stream processor subscriptions do not use these exports; they target Durable
// Object namespace env bindings directly.
export { OpenApiBridge } from "~/rpc-targets/openapi-bridge.ts";
export { OutboundMcpFromOurClientCapability } from "~/rpc-targets/outbound-mcp-from-our-client-capability.ts";
export { CodemodeSession } from "~/durable-objects/codemode-session.ts";
export { DebugAppendChainSubscriber } from "~/durable-objects/debug-append-chain-subscriber.ts";
export { ProjectDurableObject } from "~/durable-objects/project-durable-object.ts";
export { ProjectMcpServerConnection } from "~/durable-objects/project-mcp-server-connection.ts";
export {
  AgentCapability,
  AgentDurableObject,
  AiCapability,
  OrpcCapability,
  RepoCapability,
  RepoDurableObject,
  SlackCapability,
  WorkspaceDurableObject,
} from "~/codemode/example-capabilities.ts";
export { FetchCapability } from "~/codemode/fetch-capability.ts";
export { ProjectIngressEntrypoint } from "~/entrypoints/project-ingress-entrypoint.ts";
export { ProjectMcpServerEntrypoint } from "~/entrypoints/project-mcp-server-entrypoint.ts";
export { StreamCapability } from "~/entrypoints/stream-capability.ts";
export { StreamDurableObject };

const config = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: workerEnv as unknown as Record<string, unknown>,
});

export default {
  async fetch(request: Request, env: Env, cfCtx: ExecutionContext) {
    const debugAppendChainResponse = await handleDebugAppendChainFetch({ request, env });
    if (debugAppendChainResponse) return debugAppendChainResponse;

    const seedMcpProjectResponse = await handleSeedMcpProjectFetch({ request, env });
    if (seedMcpProjectResponse) return seedMcpProjectResponse;

    return withEvlog(
      {
        request,
        manifest,
        config,
        executionCtx: cfCtx,
      },
      async ({ log }) => {
        const durableObjectDebugResponse = await handleDurableObjectDebugFetch({ request, env });
        if (durableObjectDebugResponse) return durableObjectDebugResponse;

        const db = createD1Client(env.DB);
        const projectHostnameBases = config.projectHostnameBases;
        const ingressMatch = await matchIngressRequest({
          request,
          lookupRule: async (host) => {
            const row = await getIngressRouteByHost(db, { host: normalizeIngressHost(host) });
            return row ? ingressRouteRowToRule(row) : null;
          },
        });

        if (ingressMatch) {
          return await dispatchFetchCallable({
            callable: ingressMatch.rule.callable,
            context: {
              env: env as unknown as Record<string, unknown>,
              exports: (cfCtx as ExecutionContext & { exports?: Record<string, unknown> }).exports,
            },
            request,
          });
        }

        const context: AppContext = {
          manifest,
          config,
          rawRequest: request,
          db,
          doCatalog: env.DB,
          log,
          projectHostnameBases,
          loader: env.LOADER,
          codemodeSession: env.CODEMODE_SESSION,
          callableEnv: env,
          projectDurableObjectNamespace: env.PROJECT,
          stream: env.STREAM,
          workerExports: (cfCtx as ExecutionContext & { exports?: Record<string, unknown> })
            .exports,
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

async function handleSeedMcpProjectFetch(input: { request: Request; env: Env }) {
  const url = new URL(input.request.url);
  if (url.pathname !== "/__debug/seed-mcp-project") return null;

  const expectedToken = config.adminApiSecret?.exposeSecret();
  if (expectedToken == null) {
    return Response.json({ error: "Debug endpoint is disabled." }, { status: 404 });
  }

  if (input.request.headers.get("authorization") !== `Bearer ${expectedToken}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (input.request.method !== "POST") {
    return Response.json({ error: "Use POST to seed an MCP project." }, { status: 405 });
  }

  const body = await readSeedMcpProjectBody(input.request);
  const projectId = normalizeSeedMcpProjectValue(body.projectId, "proj-preview-mcp-smoke");
  const slug = normalizeSeedMcpProjectValue(body.slug, "preview-mcp-smoke");

  // Admin-only preview/operator hook: normal project creation requires Clerk
  // org auth, but preview CI and deployed MCP smoke tests need deterministic
  // project ingress rows before connecting a real MCP client to the project host.
  const project = await input.env.PROJECT.getByName(projectId).createProject({
    clerkOrgId: normalizeSeedMcpProjectValue(body.clerkOrgId, "org_preview_smoke"),
    createdByClerkUserId: normalizeSeedMcpProjectValue(body.userId, "user_preview_smoke"),
    metadata: {
      seededBy: "os2-preview-mcp-smoke",
      seededAt: new Date().toISOString(),
      ...(isJsonObject(body.metadata) ? body.metadata : {}),
    },
    projectId,
    slug,
  });

  const mcpHost =
    project.hosts.find((host) => host.startsWith(`mcp__${project.slug}.`)) ??
    project.hosts.find((host) => host.startsWith("mcp__")) ??
    null;

  return Response.json({
    project,
    mcpUrl: mcpHost == null ? null : `https://${mcpHost}/`,
  });
}

async function readSeedMcpProjectBody(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return {} as Record<string, unknown>;
  }
  const parsed = await request.json();
  return isJsonObject(parsed) ? parsed : {};
}

function normalizeSeedMcpProjectValue(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    namespace: input.env.STREAM as unknown as StreamDurableObjectNamespace,
    projectId,
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
