import { StreamPath } from "@iterate-com/shared/streams/types.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";
import type { AppConfig } from "~/config.ts";
import type { CloudflareArtifactsBinding } from "~/domains/repos/artifacts.ts";
import { seedIterateConfigBaseRepo } from "~/domains/repos/iterate-config-base-seed.ts";
import { DEBUG_APPEND_CHAIN_EVENT_TYPE } from "~/durable-objects/debug-append-chain-subscriber.ts";
import { authenticateAdminBearer } from "~/auth/admin.ts";

const EGRESS_ECHO_PATH = "/api/itx/egress-echo";
const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

/**
 * Admin-token-gated debug and operations endpoints that bypass the normal
 * request pipeline (no evlog, no ingress routing). Returns null for anything
 * that is not one of these routes.
 */
export async function handleDebugRoutes(input: {
  request: Request;
  env: Env;
  config: AppConfig;
}): Promise<Response | null> {
  return (
    handleEgressEchoFetch(input) ??
    (await handleDebugAppendChainFetch(input)) ??
    (await handleSeedIterateConfigBaseFetch(input))
  );
}

/** Echo request metadata back, for verifying worker egress paths end to end. */
function handleEgressEchoFetch(input: { request: Request; config: AppConfig }) {
  const url = new URL(input.request.url);
  if (url.pathname !== EGRESS_ECHO_PATH) return null;

  const expectedToken = input.config.adminApiSecret?.exposeSecret();
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

async function handleDebugAppendChainFetch(input: {
  request: Request;
  env: Env;
  config: AppConfig;
}) {
  const { request, env, config } = input;
  const url = new URL(request.url);
  if (url.pathname !== "/__debug/append-chain") return null;

  const expectedToken = config.adminApiSecret?.exposeSecret();
  if (expectedToken == null) {
    return Response.json({ error: "Debug endpoint is disabled." }, { status: 404 });
  }

  if (
    !authenticateAdminBearer({
      authorizationHeader: request.headers.get("authorization"),
      config,
    })
  ) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (!hasDebugAppendChainSubscriber(env)) {
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
    durableObjectNamespace: env.STREAM as unknown as StreamDurableObjectNamespace,
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

async function handleSeedIterateConfigBaseFetch(input: {
  request: Request;
  env: Env;
  config: AppConfig;
}) {
  const { request, env, config } = input;
  const url = new URL(request.url);
  if (url.pathname !== "/__debug/seed-iterate-config-base") return null;

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }

  const expectedToken = config.adminApiSecret?.exposeSecret();
  if (expectedToken == null) {
    return Response.json({ error: "Seed endpoint is disabled." }, { status: 404 });
  }

  if (
    !authenticateAdminBearer({
      authorizationHeader: request.headers.get("authorization"),
      config,
    })
  ) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const envWithArtifacts = env as Env & { ARTIFACTS?: CloudflareArtifactsBinding };
  if (!envWithArtifacts.ARTIFACTS) {
    return Response.json({ error: "ARTIFACTS binding is not configured." }, { status: 500 });
  }
  if (!env.ARTIFACTS_ACCOUNT_ID || !env.ARTIFACTS_NAMESPACE) {
    return Response.json(
      { error: "Artifacts account and namespace bindings are not configured." },
      { status: 500 },
    );
  }

  try {
    return Response.json(
      await seedIterateConfigBaseRepo({
        accountId: env.ARTIFACTS_ACCOUNT_ID,
        artifacts: envWithArtifacts.ARTIFACTS,
        namespace: env.ARTIFACTS_NAMESPACE,
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

/**
 * Proxy `/__durable-objects/<kind>/<name>/<path>` to a durable object's fetch
 * handler for debugging. Runs inside the normal pipeline (after ingress
 * routing), unlike the routes above.
 *
 * Admin-token gated: this proxies arbitrary requests straight into a DO's
 * fetch handler, so it must never be reachable anonymously. (Today only
 * PROJECT exposes a fetch handler and it self-authenticates, but the gate
 * keeps that from being load-bearing as new DO fetch handlers are added.)
 */
export async function handleDurableObjectDebugFetch(input: {
  request: Request;
  env: Env;
  config: AppConfig;
}) {
  const url = new URL(input.request.url);
  const match = url.pathname.match(/^\/__durable-objects\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!match) return null;

  if (input.config.adminApiSecret == null) {
    return Response.json({ error: "Durable Object debug proxy is disabled." }, { status: 404 });
  }
  if (
    !authenticateAdminBearer({
      authorizationHeader: input.request.headers.get("authorization"),
      config: input.config,
    })
  ) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

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
