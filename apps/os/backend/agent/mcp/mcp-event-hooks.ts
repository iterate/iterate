import { MCPClientManager } from "agents/mcp/client";
import PQueue from "p-queue";
import { eq, and } from "drizzle-orm";
import * as R from "remeda";
import { exhaustiveMatchingGuard, type Result } from "../../utils/type-helpers.ts";
import type { MergedStateForSlices } from "../agent-core.ts";
import type { CoreAgentSlices } from "../iterate-agent.ts";
import type { AgentDurableObjectInfo } from "../../auth/oauth-state-schemas.ts";
import { getAuth } from "../../auth/auth.ts";
import { getDb, type DB } from "../../db/client.ts";
import { mcpConnectionParam } from "../../db/schema.ts";
import * as schema from "../../db/schema.ts";
import { IntegrationMode } from "../tool-schemas.ts";
import type { MCPParam } from "../tool-schemas.ts";
import type { Branded } from "../callable.ts";
import { MCPOAuthProvider } from "./mcp-oauth-provider.ts";
import {
  getConnectionKey,
  type MCPConnection,
  type MCPConnectionErrorEventInput,
  type MCPConnectionEstablishedEventInput,
  MCPConnectionKey,
  type MCPConnectRequestEvent,
  type MCPConnectRequestEventInput,
  type MCPDisconnectRequestEvent,
  type MCPDisconnectRequestEventInput,
  type MCPOAuthRequiredEventInput,
  type MCPParamsRequiredEventInput,
} from "./mcp-slice.ts";

// ------------------------- Types -------------------------

type HookedMCPEvent = MCPConnectRequestEvent | MCPDisconnectRequestEvent;

export type MCPEventHookReturnEvent =
  | MCPConnectRequestEventInput
  | MCPDisconnectRequestEventInput
  | MCPConnectionEstablishedEventInput
  | MCPConnectionErrorEventInput
  | MCPOAuthRequiredEventInput
  | MCPParamsRequiredEventInput;

interface MCPEventHandlerParams<TEvent extends HookedMCPEvent = HookedMCPEvent> {
  event: TEvent;
  reducedState: MergedStateForSlices<CoreAgentSlices>;
  agentDurableObject: AgentDurableObjectInfo;
  estateId: string;
  getFinalRedirectUrl?: (payload: {
    durableObjectInstanceName: string;
  }) => Promise<string | undefined>;
}

interface MCPConnectionResult {
  manager: MCPClientManager | undefined;
  events: MCPEventHookReturnEvent[];
}

type MCPManagerCacheKey = Branded<"MCPManagerCacheKey">;

export function createCacheKey(
  durableObjectId: string,
  connectionKey: MCPConnectionKey,
): MCPManagerCacheKey {
  return `${durableObjectId}--${connectionKey}` as MCPManagerCacheKey;
}

// Use MCPManagerCacheKey to make sure we are not sharing managers between different durable objects (true for local dev)
export const mcpManagerCache = {
  managers: new Map<MCPManagerCacheKey, MCPClientManager>(),
};

function getIntegrationSlugFromServerUrl(serverUrl: string) {
  try {
    const url = new URL(serverUrl);
    const hostnameAndPath = url.hostname + url.pathname;
    return hostnameAndPath
      .replace(/[/.:]/g, "-") // Replace /, ., : with -
      .replace(/[^a-zA-Z0-9-]/g, "") // Remove any other special chars
      .replace(/-+/g, "-") // Replace multiple hyphens with single hyphen
      .replace(/^-|-$/g, ""); // Remove leading/trailing hyphens
  } catch {
    return serverUrl
      .replace(/[^a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }
}

async function getMCPParamsCollectionURL(params: {
  db: DB;
  serverUrl: string;
  mode: IntegrationMode;
  connectionKey: string;
  requiredParams: MCPParam[];
  agentDurableObject: AgentDurableObjectInfo;
  estateId: string;
  integrationSlug: string;
  finalRedirectUrl: string | undefined;
}): Promise<string> {
  const estate = await params.db.query.estate.findFirst({
    where: eq(schema.estate.id, params.estateId),
    columns: {
      organizationId: true,
    },
  });

  if (!estate) {
    throw new Error(`Estate ${params.estateId} not found`);
  }

  const url = new URL(
    `${process.env.VITE_PUBLIC_URL || ""}/${estate.organizationId}/${params.estateId}/integrations/mcp-params`,
  );
  url.searchParams.set("serverUrl", params.serverUrl);
  url.searchParams.set("mode", params.mode);
  url.searchParams.set("connectionKey", params.connectionKey);
  url.searchParams.set("requiredParams", JSON.stringify(params.requiredParams));
  url.searchParams.set("integrationSlug", params.integrationSlug);
  url.searchParams.set("agentDurableObject", JSON.stringify(params.agentDurableObject));
  if (params.finalRedirectUrl) {
    url.searchParams.set("finalRedirectUrl", params.finalRedirectUrl);
  }
  return url.toString();
}

/**
 * Handle MCP:CONNECT_REQUEST - perform actual connection
 */
export async function handleMCPConnectRequest(
  params: MCPEventHandlerParams<MCPConnectRequestEvent>,
): Promise<MCPEventHookReturnEvent[]> {
  const { event, reducedState, agentDurableObject, estateId } = params;
  const events: MCPEventHookReturnEvent[] = [];
  const db = getDb();
  const auth = getAuth(db);
  const {
    serverUrl,
    mode,
    userId,
    integrationSlug,
    allowedTools,
    allowedPrompts,
    allowedResources,
    requiresOAuth,
    triggerLLMRequestOnEstablishedConnection,
    requiresParams,
    reconnect,
  } = event.data;

  const guaranteedIntegrationSlug =
    integrationSlug ?? getIntegrationSlugFromServerUrl(event.data.serverUrl);

  if (mode === "personal" && !userId) {
    events.push({
      type: "MCP:CONNECTION_ERROR",
      data: {
        serverUrl,
        error: "Personal connections require userId",
      },
      metadata: {},
      triggerLLMRequest: false,
    });
    return events;
  }

  const connectionKey = getConnectionKey({ serverUrl, mode, userId });
  const existingConnection = reducedState.mcpConnections[connectionKey];

  const cacheKey = createCacheKey(agentDurableObject.durableObjectId, connectionKey);
  const isRehydration = existingConnection?.connectedAt && !mcpManagerCache.managers.has(cacheKey);

  if (existingConnection?.connectedAt && !isRehydration) {
    return events;
  }

  let appliedHeaders: Record<string, string> = {};
  let modifiedServerUrl = serverUrl;

  const finalRedirectUrl = await params.getFinalRedirectUrl?.({
    durableObjectInstanceName: agentDurableObject.durableObjectName,
  });

  if (requiresParams && requiresParams.length > 0) {
    const storedParams = await db.query.mcpConnectionParam.findMany({
      where: and(
        eq(mcpConnectionParam.estateId, estateId),
        eq(mcpConnectionParam.connectionKey, connectionKey),
      ),
    });

    const missingParams = requiresParams.filter(
      (required) =>
        !storedParams.some(
          (stored) => stored.paramKey === required.key && stored.paramType === required.type,
        ),
    );

    if (missingParams.length > 0) {
      const paramsCollectionUrl = await getMCPParamsCollectionURL({
        db,
        serverUrl,
        mode,
        connectionKey,
        requiredParams: missingParams,
        agentDurableObject,
        estateId,
        integrationSlug: guaranteedIntegrationSlug,
        finalRedirectUrl,
      });

      events.push({
        type: "MCP:PARAMS_REQUIRED",
        data: {
          serverUrl,
          mode,
          connectionKey,
          requiredParams: missingParams,
          integrationSlug: guaranteedIntegrationSlug,
          userId,
          agentDurableObject,
          paramsCollectionUrl,
        },
        metadata: {},
        triggerLLMRequest: false,
      });
      return events;
    }

    appliedHeaders = R.pipe(
      storedParams,
      R.filter((param) => param.paramType === "header"),
      R.map((param) => [param.paramKey, param.paramValue] as const),
      R.fromEntries(),
    );

    modifiedServerUrl = R.pipe(
      storedParams,
      R.filter((param) => param.paramType === "query_param"),
      R.reduce((currentUrl, param) => {
        const url = new URL(currentUrl);
        url.searchParams.set(param.paramKey, param.paramValue);
        return url.toString();
      }, modifiedServerUrl),
    );
  }

  const oauthProvider = requiresOAuth
    ? new MCPOAuthProvider({
        auth,
        db,
        userId,
        estateId: estateId,
        integrationSlug: guaranteedIntegrationSlug,
        serverUrl: modifiedServerUrl,
        callbackUrl: finalRedirectUrl,
        agentDurableObject,
      })
    : undefined;

  const manager = new MCPClientManager("iterate-agent", "1.0.0");

  let result: Awaited<ReturnType<typeof manager.connect>>;

  try {
    const connectOptions: Parameters<typeof manager.connect>[1] = {
      transport: {
        authProvider: oauthProvider,
        type: "auto",
        requestInit: {
          headers: appliedHeaders,
        },
      },
      ...(reconnect && {
        reconnect: {
          id: "cloudflare-requires-id",
          oauthClientId: reconnect.oauthClientId,
          oauthCode: reconnect.oauthCode,
        },
      }),
    };

    result = await Promise.race([
      manager.connect(modifiedServerUrl, connectOptions),
      // wait 20 seconds - if fail, add an error event
      new Promise<typeof result>((_, reject) => {
        setTimeout(
          () => reject(new Error("MCP connection timeout - authentication may have expired")),
          20_000, // 10_000 was too short for some
        );
      }),
    ]);
  } catch (error) {
    if (requiresOAuth) {
      oauthProvider?.resetClientAndTokens();
    }

    if (requiresOAuth && oauthProvider?.authUrl) {
      events.push({
        type: "MCP:OAUTH_REQUIRED",
        data: {
          connectionKey,
          serverUrl,
          mode,
          userId: userId || undefined,
          integrationSlug: guaranteedIntegrationSlug,
          oauthUrl: oauthProvider.authUrl,
        },
        metadata: { error: String(error) },
        triggerLLMRequest: false,
      });
    } else {
      events.push({
        type: "MCP:CONNECTION_ERROR",
        data: {
          connectionKey,
          serverUrl,
          userId: userId || undefined,
          error: String(error),
        },
        metadata: { error: String(error) },
        triggerLLMRequest: false,
      });
    }
    return events;
  }

  if (result.authUrl) {
    events.push({
      type: "MCP:OAUTH_REQUIRED",
      data: {
        connectionKey,
        serverUrl,
        mode,
        userId: userId || undefined,
        integrationSlug: guaranteedIntegrationSlug,
        oauthUrl: result.authUrl,
      },
      metadata: {},
      triggerLLMRequest: false,
    });
    return events;
  }

  mcpManagerCache.managers.set(cacheKey, manager);

  const serverName = manager.mcpConnections[result.id].client.getServerVersion()?.name;
  if (!serverName) {
    throw new Error("Server name not found");
  }

  const tools = manager.listTools().filter((t) => t.serverId === result.id);
  const prompts = manager.listPrompts().filter((p) => p.serverId === result.id);
  const resources = manager.listResources().filter((r) => r.serverId === result.id);

  console.log(
    `[MCP] Server ${result.id} provides ${tools.length} tools, ${prompts.length} prompts, ${resources.length} resources`,
  );

  const filteredTools = allowedTools ? tools.filter((t) => allowedTools.includes(t.name)) : tools;
  const filteredPrompts = allowedPrompts
    ? prompts.filter((p) => allowedPrompts.includes(p.name))
    : prompts;
  const filteredResources = allowedResources
    ? resources.filter((r) => allowedResources.includes(r.uri))
    : resources;

  events.push({
    type: "MCP:CONNECTION_ESTABLISHED",
    data: {
      connectionKey,
      serverId: result.id,
      serverUrl,
      serverName,
      mode,
      userId,
      integrationSlug: guaranteedIntegrationSlug,
      tools: filteredTools,
      prompts: filteredPrompts,
      resources: filteredResources,
      requiresOAuth,
      requiresParams,
    },
    metadata: {},
    triggerLLMRequest: triggerLLMRequestOnEstablishedConnection,
  });

  return events;
}

/**
 * Handle MCP:DISCONNECT_REQUEST - perform actual disconnection
 */
async function handleMCPDisconnectRequest(
  params: MCPEventHandlerParams<MCPDisconnectRequestEvent>,
): Promise<MCPEventHookReturnEvent[]> {
  const { event, reducedState, agentDurableObject } = params;
  const events: MCPEventHookReturnEvent[] = [];
  const { connectionKey, serverUrl, userId } = event.data;

  let keysToDisconnect: MCPConnectionKey[] = [];

  if (connectionKey) {
    keysToDisconnect = [MCPConnectionKey.parse(connectionKey)];
  } else if (serverUrl && userId) {
    const key = getConnectionKey({ serverUrl, mode: "personal", userId });
    if (reducedState.mcpConnections[key]) {
      keysToDisconnect = [key];
    }
  } else if (serverUrl) {
    keysToDisconnect = Object.keys(reducedState.mcpConnections)
      .map((k) => MCPConnectionKey.parse(k))
      .filter((k) => reducedState.mcpConnections[k].serverUrl === serverUrl);
  } else if (userId) {
    keysToDisconnect = Object.keys(reducedState.mcpConnections)
      .map((k) => MCPConnectionKey.parse(k))
      .filter((k) => reducedState.mcpConnections[k].userId === userId);
  }

  for (const key of keysToDisconnect) {
    const connection = reducedState.mcpConnections[key];
    if (connection?.serverId) {
      try {
        const cacheKey = createCacheKey(agentDurableObject.durableObjectId, key);
        const manager = mcpManagerCache.managers.get(cacheKey);
        if (manager) {
          await manager.closeConnection(connection.serverId);
          mcpManagerCache.managers.delete(cacheKey);
          const entry = connectionQueues.get(cacheKey);
          if (entry && entry.queue.size === 0 && entry.queue.pending === 0) {
            connectionQueues.delete(cacheKey);
          }
          console.log(`[MCP] Disconnected and removed manager for ${key}`);
        } else {
          console.warn(`[MCP] No manager found for connection ${key}`);
        }
      } catch (error) {
        console.warn(`[MCP] Failed to disconnect ${key}:`, error);
      }
    }
  }

  return events;
}

// ------------------------- Connection Queueing -------------------------

/**
 * Queue-based connection management to handle concurrent connection attempts.
 * Each connection key gets its own queue with concurrency: 1 to ensure
 * only one connection attempt happens at a time per key.
 *
 * Once a connection is established and cached, subsequent requests bypass the queue entirely for faster access.
 *
 * Abort handling flow:
 * 1. When OAuth/error occurs, abortPendingConnections() is called
 * 2. This aborts the controller, causing all tasks to fail when they check the signal
 * 3. Tasks already executing will check signal.aborted and return error
 * 4. Queued tasks will be rejected by p-queue when it checks the signal before starting them
 * 5. The queue entry is cleaned up by the finally block after all tasks complete
 *
 * This ensures no promises are left dangling - they're all properly rejected.
 */
interface ConnectionQueueEntry {
  queue: PQueue;
  controller: AbortController;
}

// One queue per cache key (durableObjectId--connectionKey), each with concurrency: 1
// We include the durableObjectId in the cache key to ensure that we don't share queues between different durable objects (true for local dev)
export const connectionQueues = new Map<MCPManagerCacheKey, ConnectionQueueEntry>();

export function getConnectionQueue(cacheKey: MCPManagerCacheKey): ConnectionQueueEntry {
  let entry = connectionQueues.get(cacheKey);
  if (!entry) {
    entry = {
      queue: new PQueue({ concurrency: 1 }),
      controller: new AbortController(),
    };
    connectionQueues.set(cacheKey, entry);
  }
  return entry;
}

export function abortPendingConnections(cacheKey: MCPManagerCacheKey, reason: string) {
  const entry = connectionQueues.get(cacheKey);
  if (entry) {
    entry.controller.abort(reason);
  }
}

export async function getOrCreateMCPConnection(params: {
  connectionKey: MCPConnectionKey;
  connectionRequestEvent: MCPConnectRequestEvent;
  agentDurableObject: AgentDurableObjectInfo;
  estateId: string;
  reducedState: MergedStateForSlices<CoreAgentSlices>;
  getFinalRedirectUrl?: (payload: {
    durableObjectInstanceName: string;
  }) => Promise<string | undefined>;
}): Promise<Result<MCPConnectionResult>> {
  const { connectionKey, agentDurableObject } = params;

  const cacheKey = createCacheKey(agentDurableObject.durableObjectId, connectionKey);
  const existingManager = mcpManagerCache.managers.get(cacheKey);
  if (existingManager) {
    return { success: true, data: { manager: existingManager, events: [] } };
  }

  const { queue, controller } = getConnectionQueue(cacheKey);

  const result = await queue.add(
    async ({ signal }): Promise<Result<MCPConnectionResult>> => {
      try {
        const existingManager = mcpManagerCache.managers.get(cacheKey);
        if (existingManager) {
          return { success: true, data: { manager: existingManager, events: [] } };
        }
        if (signal?.aborted) {
          return { success: false, error: signal.reason || "Connection aborted" };
        }
        const events = await handleMCPConnectRequest({
          event: params.connectionRequestEvent,
          reducedState: params.reducedState,
          agentDurableObject: params.agentDurableObject,
          estateId: params.estateId,
          getFinalRedirectUrl: params.getFinalRedirectUrl,
        });

        const hasOAuthRequired = events.some((e) => e.type === "MCP:OAUTH_REQUIRED");
        const hasConnectionError = events.some((e) => e.type === "MCP:CONNECTION_ERROR");

        if (hasOAuthRequired || hasConnectionError) {
          const abortReason = hasOAuthRequired
            ? "OAuth authorization required - aborting pending connection attempts"
            : "Connection failed - aborting pending connection attempts";
          abortPendingConnections(cacheKey, abortReason);
        }

        const manager = mcpManagerCache.managers.get(cacheKey);
        if (!manager) {
          return { success: true, data: { manager: undefined, events } };
        }

        return { success: true, data: { manager, events } };
      } catch (error) {
        abortPendingConnections(cacheKey, `Connection error: ${String(error)}`);
        return { success: false, error: String(error) };
      } finally {
        // Clean up empty queue after connection attempt.
        // We need a timeout because when we're in this finally block, our task
        // is still being processed by the queue. The queue's internal state
        // (size and pending count) won't be updated until after our callback completes.
        setTimeout(() => {
          const entry = connectionQueues.get(cacheKey);
          if (entry && entry.queue.size === 0 && entry.queue.pending === 0) {
            connectionQueues.delete(cacheKey);
          }
        }, 0); // Next tick is sufficient - just need to wait for queue to update its state
      }
    },
    { signal: controller.signal },
  );

  return result as Result<MCPConnectionResult>;
}

// ------------------------- Lazy Connection -------------------------

/**
 * Rehydrate an existing MCP connection.
 *
 * 1. Returns immediately if connection exists in cache (no queue overhead)
 * 2. Uses queue only for actual connection attempts to prevent duplicates
 * 3. Cleans up idle queues automatically after connection attempts
 */
export async function rehydrateExistingMCPConnection(params: {
  connectionKey: MCPConnectionKey;
  connection: MCPConnection;
  agentDurableObject: AgentDurableObjectInfo;
  estateId: string;
  reducedState: MergedStateForSlices<CoreAgentSlices>;
  getFinalRedirectUrl?: (payload: {
    durableObjectInstanceName: string;
  }) => Promise<string | undefined>;
}): Promise<Result<MCPClientManager | undefined> & { events?: MCPEventHookReturnEvent[] }> {
  const result = await getOrCreateMCPConnection({
    ...params,
    connectionRequestEvent: {
      type: "MCP:CONNECT_REQUEST",
      data: {
        serverUrl: params.connection.serverUrl,
        mode: params.connection.mode,
        userId: params.connection.userId,
        integrationSlug: params.connection.integrationSlug,
        requiresOAuth: params.connection.requiresOAuth ?? true,
        allowedTools: params.connection.tools.map((t) => t.name),
        allowedPrompts: params.connection.prompts.map((p) => p.name),
        allowedResources: params.connection.resources.map((r) => r.uri),
        triggerLLMRequestOnEstablishedConnection: false,
      },
      eventIndex: 0,
      createdAt: new Date().toISOString(),
      metadata: {},
      triggerLLMRequest: false,
    },
  });

  if (result.success) {
    return {
      success: true,
      data: result.data.manager,
      events: result.data.events,
    };
  } else {
    return {
      success: false,
      error: result.error,
      events: [],
    };
  }
}

// ------------------------- Main Handler -------------------------

/**
 * Handle MCP events that require side effects (connections, disconnections, etc.)
 * This function should be called from onEventAdded callback to ensure it only runs once per event.
 * Returns an array of events to be added to the agent core.
 */
export async function runMCPEventHooks(
  params: MCPEventHandlerParams,
): Promise<MCPEventHookReturnEvent[]> {
  switch (params.event.type) {
    case "MCP:CONNECT_REQUEST":
      return await handleMCPConnectRequest({ ...params, event: params.event });
    case "MCP:DISCONNECT_REQUEST":
      return await handleMCPDisconnectRequest({ ...params, event: params.event });
    default:
      exhaustiveMatchingGuard(params.event);
  }
}
