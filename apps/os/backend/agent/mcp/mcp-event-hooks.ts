import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { MCPClientManager } from "agents/mcp/client";
import PQueue from "p-queue";
import pRace from "p-suite/p-race";
import { eq, and } from "drizzle-orm";
import * as R from "remeda";
import { exhaustiveMatchingGuard, type Result } from "../../utils/type-helpers.ts";
import { logger } from "../../tag-logger.ts";
import type { MergedStateForSlices } from "../agent-core.ts";
import type { CoreAgentSlices } from "../iterate-agent.ts";
import type { AgentDurableObjectInfo } from "../../auth/oauth-state-schemas.ts";
import { getAuth } from "../../auth/auth.ts";
import { getDb, type DB } from "../../db/client.ts";
import { mcpConnectionParam } from "../../db/schema.ts";
import * as schema from "../../db/schema.ts";
import { IntegrationMode } from "../tool-schemas.ts";
import type { MCPParam } from "../tool-schemas.ts";
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
  mcpConnectionCache: MCPManagerCache;
  mcpConnectionQueues: MCPConnectionQueues;
  getFinalRedirectUrl?: (payload: {
    durableObjectInstanceName: string;
  }) => Promise<string | undefined>;
}

interface MCPConnectionResult {
  manager: MCPClientManager | undefined;
  events: MCPEventHookReturnEvent[];
}

// Cache key is simply the connection key since cache is now instance-level per DO
export function createCacheKey(connectionKey: MCPConnectionKey): MCPConnectionKey {
  return connectionKey;
}

// Instance-level cache interface (to avoid sharing I/O objects across Durable Objects)
export interface MCPManagerCache {
  managers: Map<MCPConnectionKey, MCPClientManager>;
}

export function createMCPManagerCache(): MCPManagerCache {
  return {
    managers: new Map<MCPConnectionKey, MCPClientManager>(),
  };
}

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
  const { event, reducedState, agentDurableObject, estateId, mcpConnectionCache } = params;
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

  const cacheKey = createCacheKey(connectionKey);
  const isRehydration =
    existingConnection?.connectedAt && !mcpConnectionCache.managers.has(cacheKey);

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

  const oauthProvider = new MCPOAuthProvider({
    auth,
    db,
    userId,
    estateId: estateId,
    integrationSlug: guaranteedIntegrationSlug,
    serverUrl: modifiedServerUrl,
    callbackUrl: finalRedirectUrl,
    agentDurableObject,
    isReconnecting: !!reconnect,
  });

  const manager = new MCPClientManager("iterate-agent", "1.0.0");

  let result: Awaited<ReturnType<typeof manager.connect>>;

  try {
    result = await pRace((signal) => [
      manager.connect(modifiedServerUrl, {
        transport: {
          authProvider: oauthProvider,
          type: "auto",
          requestInit: {
            headers: appliedHeaders,
            signal,
          },
        },
        ...(reconnect && {
          reconnect: {
            id: reconnect.id,
            oauthClientId: reconnect.oauthClientId,
            oauthCode: reconnect.oauthCode,
          },
        }),
      }),
      setTimeoutPromise(30_000, null, { signal }).then(() => {
        throw new Error("MCP connection timeout - authentication may have expired");
      }),
    ]);
  } catch (error) {
    oauthProvider?.resetTokens();
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
    return events;
  }

  if (result.authUrl) {
    // Close the partial connection since we need OAuth first
    // The connection will be re-established after OAuth completes
    try {
      await manager.closeConnection(result.id);
    } catch (cleanupError) {
      logger.warn(`[MCP] Failed to cleanup manager after OAuth required:`, cleanupError);
    }

    events.push({
      type: "MCP:OAUTH_REQUIRED",
      data: {
        connectionKey,
        serverUrl,
        mode,
        userId: userId || undefined,
        integrationSlug: guaranteedIntegrationSlug,
        oauthUrl: result.authUrl,
        serverId: result.id,
      },
      metadata: {},
      triggerLLMRequest: false,
    });
    return events;
  }

  mcpConnectionCache.managers.set(cacheKey, manager);

  // Failback to Unknown if the server developer has not implemented the specification properly
  const serverName = manager.mcpConnections[result.id].client.getServerVersion()?.name || "Unknown";

  const tools = manager.listTools().filter((t) => t.serverId === result.id);
  const prompts = manager.listPrompts().filter((p) => p.serverId === result.id);
  const resources = manager.listResources().filter((r) => r.serverId === result.id);

  logger.log(
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
  const { event, reducedState, mcpConnectionCache, mcpConnectionQueues } = params;
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
        const cacheKey = createCacheKey(key);
        const manager = mcpConnectionCache.managers.get(cacheKey);
        if (manager) {
          await manager.closeConnection(connection.serverId);
          mcpConnectionCache.managers.delete(cacheKey);
          const entry = mcpConnectionQueues.get(cacheKey);
          if (entry && entry.queue.size === 0 && entry.queue.pending === 0) {
            mcpConnectionQueues.delete(cacheKey);
          }
          logger.log(`[MCP] Disconnected and removed manager for ${key}`);
        } else {
          logger.warn(`[MCP] No manager found for connection ${key}`);
        }
      } catch (error) {
        logger.warn(`[MCP] Failed to disconnect ${key}:`, error);
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

// Instance-level connection queues (one per DO, not module-level)
export type MCPConnectionQueues = Map<MCPConnectionKey, ConnectionQueueEntry>;

export function createMCPConnectionQueues(): MCPConnectionQueues {
  return new Map<MCPConnectionKey, ConnectionQueueEntry>();
}

export function getConnectionQueue(
  mcpConnectionQueues: MCPConnectionQueues,
  cacheKey: MCPConnectionKey,
): ConnectionQueueEntry {
  let entry = mcpConnectionQueues.get(cacheKey);
  // If the entry exists but the controller is already aborted, remove it and create a fresh one
  if (entry?.controller.signal.aborted) {
    mcpConnectionQueues.delete(cacheKey);
    entry = undefined;
  }
  if (!entry) {
    entry = {
      queue: new PQueue({ concurrency: 1 }),
      controller: new AbortController(),
    };
    mcpConnectionQueues.set(cacheKey, entry);
  }
  return entry;
}

export function abortPendingConnections(
  mcpConnectionQueues: MCPConnectionQueues,
  cacheKey: MCPConnectionKey,
  reason: string,
) {
  const entry = mcpConnectionQueues.get(cacheKey);
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
  mcpConnectionCache: MCPManagerCache;
  mcpConnectionQueues: MCPConnectionQueues;
  getFinalRedirectUrl?: (payload: {
    durableObjectInstanceName: string;
  }) => Promise<string | undefined>;
}): Promise<Result<MCPConnectionResult>> {
  const { connectionKey, mcpConnectionCache, mcpConnectionQueues } = params;

  const cacheKey = createCacheKey(connectionKey);
  const existingManager = mcpConnectionCache.managers.get(cacheKey);
  if (existingManager) {
    return { success: true, data: { manager: existingManager, events: [] } };
  }

  const { queue, controller } = getConnectionQueue(mcpConnectionQueues, cacheKey);

  const result = await queue.add(
    async ({ signal }): Promise<Result<MCPConnectionResult>> => {
      try {
        const existingManager = mcpConnectionCache.managers.get(cacheKey);
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
          mcpConnectionCache,
          mcpConnectionQueues,
          getFinalRedirectUrl: params.getFinalRedirectUrl,
        });

        const hasOAuthRequired = events.some((e) => e.type === "MCP:OAUTH_REQUIRED");
        const hasConnectionError = events.some((e) => e.type === "MCP:CONNECTION_ERROR");

        if (hasOAuthRequired || hasConnectionError) {
          const abortReason = hasOAuthRequired
            ? "OAuth authorization required - aborting pending connection attempts"
            : "Connection failed - aborting pending connection attempts";
          abortPendingConnections(mcpConnectionQueues, cacheKey, abortReason);
        }

        const manager = mcpConnectionCache.managers.get(cacheKey);
        if (!manager) {
          return { success: true, data: { manager: undefined, events } };
        }

        return { success: true, data: { manager, events } };
      } catch (error) {
        abortPendingConnections(
          mcpConnectionQueues,
          cacheKey,
          `Connection error: ${String(error)}`,
        );
        return { success: false, error: String(error) };
      } finally {
        // Clean up empty queue after connection attempt.
        // We need a timeout because when we're in this finally block, our task
        // is still being processed by the queue. The queue's internal state
        // (size and pending count) won't be updated until after our callback completes.
        setTimeout(() => {
          const entry = mcpConnectionQueues.get(cacheKey);
          if (entry && entry.queue.size === 0 && entry.queue.pending === 0) {
            mcpConnectionQueues.delete(cacheKey);
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
  mcpConnectionCache: MCPManagerCache;
  mcpConnectionQueues: MCPConnectionQueues;
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
