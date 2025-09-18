import { MCPClientManager } from "agents/mcp/client";
import PQueue from "p-queue";
import { exhaustiveMatchingGuard, type Result } from "../../utils/type-helpers.ts";
import type { MergedStateForSlices } from "../agent-core.ts";
import type { CoreAgentSlices } from "../iterate-agent.ts";
import { MCPOAuthProvider } from "./mcp-oauth-provider.ts";
import {
  getConnectionKey,
  type MCPAddMcpServerEvent,
  type MCPConnection,
  type MCPConnectionErrorEventInput,
  type MCPConnectionEstablishedEventInput,
  MCPConnectionKey,
  type MCPConnectRequestEvent,
  type MCPConnectRequestEventInput,
  type MCPDisconnectRequestEvent,
  type MCPDisconnectRequestEventInput,
  type MCPOAuthRequiredEventInput,
  type MCPRemoveMcpServerEvent,
} from "./mcp-slice.ts";

// ------------------------- Types -------------------------

type HookedMCPEvent =
  | MCPAddMcpServerEvent
  | MCPRemoveMcpServerEvent
  | MCPConnectRequestEvent
  | MCPDisconnectRequestEvent;

export type MCPEventHookReturnEvent =
  | MCPConnectRequestEventInput
  | MCPDisconnectRequestEventInput
  | MCPConnectionEstablishedEventInput
  | MCPConnectionErrorEventInput
  | MCPOAuthRequiredEventInput;

interface MCPEventHandlerParams<TEvent extends HookedMCPEvent = HookedMCPEvent> {
  event: TEvent;
  reducedState: MergedStateForSlices<CoreAgentSlices>;
  agentDurableObjectId: string;
  agentDurableObjectName: string;
  getFinalRedirectUrl?: (payload: {
    durableObjectInstanceName: string;
    reducedState: MergedStateForSlices<CoreAgentSlices>;
  }) => Promise<string | undefined>;
}

// Single consolidated cache for MCP connections
interface MCPConnectionResult {
  manager: MCPClientManager | undefined;
  events: MCPEventHookReturnEvent[];
}

// Keep the old cache for direct manager access (will be populated by handleMCPConnectRequest)
export const mcpManagerCache = {
  managers: new Map<MCPConnectionKey, MCPClientManager>(),
};

// ------------------------- Event Handlers -------------------------

async function handleAddMcpServers(
  params: MCPEventHandlerParams<MCPAddMcpServerEvent>,
): Promise<MCPEventHookReturnEvent[]> {
  const { event, reducedState } = params;
  const events: MCPEventHookReturnEvent[] = [];

  // We need to request connections if there are existing participants.
  // If the connection is company mode, we only need to request a single connection.
  for (const spec of event.data.servers) {
    if (spec.mode === "personal") {
      const participants = Object.entries(reducedState.participants);
      for (const [userId] of participants) {
        const connectionKey = getConnectionKey({
          serverUrl: spec.serverUrl,
          mode: "personal",
          userId,
        });
        if (reducedState.mcpConnections[connectionKey]?.connectedAt) {
          console.log(`[MCP] Already connected to ${connectionKey}, skipping reconnection`);
          continue;
        }

        events.push({
          type: "MCP:CONNECT_REQUEST",
          data: {
            serverUrl: spec.serverUrl,
            mode: "personal",
            userId,
            integrationSlug: spec.integrationSlug,
            allowedTools: spec.allowedTools,
            allowedPrompts: spec.allowedPrompts,
            allowedResources: spec.allowedResources,
            requiresAuth: spec.requiresAuth ?? true,
            triggerLLMRequestOnEstablishedConnection: false,
            headers: spec.headers,
          },
          metadata: {},
          triggerLLMRequest: false,
        });
      }
    } else {
      const connectionKey = getConnectionKey({
        serverUrl: spec.serverUrl,
        mode: "company",
        userId: undefined,
      });
      if (reducedState.mcpConnections[connectionKey]?.connectedAt) {
        console.log(`[MCP] Already connected to ${connectionKey}, skipping reconnection`);
        continue;
      }

      if (Object.keys(reducedState.participants).length === 0) {
        console.warn(
          "[MCP] No participants found for company mode connection. Skipping connection request.",
        );
        continue;
      }
      events.push({
        type: "MCP:CONNECT_REQUEST",
        data: {
          serverUrl: spec.serverUrl,
          mode: "company",
          // add this to prevent csrf
          // the person who initiates the conversation is the one who must connect
          userId: Object.values(reducedState.participants)[0].internalUserId,
          requiresAuth: spec.requiresAuth ?? true,
          integrationSlug: spec.integrationSlug,
          allowedTools: spec.allowedTools,
          allowedPrompts: spec.allowedPrompts,
          allowedResources: spec.allowedResources,
          triggerLLMRequestOnEstablishedConnection: false,
          headers: spec.headers,
        },
        metadata: {},
        triggerLLMRequest: false,
      });
    }
  }

  return events;
}

async function handleRemoveMcpServers(
  params: MCPEventHandlerParams<MCPRemoveMcpServerEvent>,
): Promise<MCPEventHookReturnEvent[]> {
  const { event, reducedState } = params;
  const events: MCPEventHookReturnEvent[] = [];

  for (const server of event.data.servers) {
    for (const participant of Object.keys(reducedState.participants)) {
      events.push({
        type: "MCP:DISCONNECT_REQUEST",
        data: {
          serverUrl: server.serverUrl,
          userId: participant,
        },
        metadata: {},
        triggerLLMRequest: false,
      });
    }
  }

  return events;
}

function extractStringDependencies(targetString: string): string[] {
  const dependencies = targetString.match(/\{([^}]+)\}/g);
  return dependencies?.map((d) => d.slice(1, -1)) || [];
}

async function formatStringWithDependencyFromIntegrationSystem(params: {
  targetString: string;
  integrationSlug: string;
  mode: "personal" | "company";
  userId: string;
}) {
  const { targetString } = params;
  const formattedResponse = {
    formattedString: targetString,
    missingDependencies: [] as string[],
  };
  const dependencies = extractStringDependencies(targetString);
  for (const dependency of dependencies) {
    try {
      // TODO: fetch secret from better auth
      const integrationSecret = {
        token: "test",
      };
      formattedResponse.formattedString = formattedResponse.formattedString.replace(
        `{${dependency}}`,
        integrationSecret.token,
      );
    } catch (_error) {
      console.log("Failed to get integration secret for", _error);
      formattedResponse.missingDependencies.push(dependency);
      continue;
    }
  }
  return formattedResponse;
}

function getIntegrationSlugFromServerUrl(serverUrl: string) {
  try {
    const url = new URL(serverUrl);
    const hostnameAndPath = url.hostname + url.pathname;
    return encodeURIComponent(hostnameAndPath);
  } catch {
    return encodeURIComponent(serverUrl);
  }
}

function getIntegrationSecretFormUIURL(params: {
  message: string;
  integrationSlug: string;
  mode: "personal" | "company";
  userId: string;
  requiredDependencies: string[];
  finalRedirectUrl?: string;
  requestedByAgentDOId?: string;
  serverUrl?: string;
  requiresAuth?: boolean;
  headers?: Record<string, string>;
}) {
  const url = new URL(`${import.meta.env.VITE_PUBLIC_URL}/integrations/manual`);

  // Add query parameters for the manual connection form
  url.searchParams.set("appSlug", "platform");
  url.searchParams.set("integrationSlug", params.integrationSlug);
  url.searchParams.set("mode", params.mode);
  url.searchParams.set("name", `${params.integrationSlug}-${params.mode}-connection`);
  url.searchParams.set("message", params.message);
  if (params.finalRedirectUrl) {
    url.searchParams.set("finalRedirectUrl", params.finalRedirectUrl);
  }

  // Add MCP-specific parameters if provided
  if (params.requestedByAgentDOId) {
    url.searchParams.set("requestedByAgentDOId", params.requestedByAgentDOId);
  }
  if (params.serverUrl) {
    url.searchParams.set("serverUrl", params.serverUrl);
  }
  if (params.requiresAuth) {
    url.searchParams.set("requiresAuth", params.requiresAuth.toString());
  }
  if (params.headers) {
    url.searchParams.set("headers", btoa(JSON.stringify(params.headers)));
  }

  // Add each required dependency as a separate query parameter
  params.requiredDependencies.forEach((dependency) => {
    url.searchParams.append("requiredDependencies", dependency);
  });

  return url.toString();
}

/**
 * Handle MCP:CONNECT_REQUEST - perform actual connection
 */
export async function handleMCPConnectRequest(
  params: MCPEventHandlerParams<MCPConnectRequestEvent>,
): Promise<MCPEventHookReturnEvent[]> {
  const { event, reducedState, agentDurableObjectId, agentDurableObjectName } = params;
  const events: MCPEventHookReturnEvent[] = [];
  const {
    serverUrl,
    mode,
    userId,
    integrationSlug,
    allowedTools,
    allowedPrompts,
    allowedResources,
    requiresAuth,
    triggerLLMRequestOnEstablishedConnection,
    headers,
  } = event.data;

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

  // Check if we're being called from lazyConnectMCPServer for rehydration
  const isRehydration =
    existingConnection?.connectedAt && !mcpManagerCache.managers.has(connectionKey);

  if (existingConnection?.connectedAt && !isRehydration) {
    console.log(
      `[MCP] Already connected to ${connectionKey} with serverId: ${existingConnection.serverId}`,
    );
    return events;
  }

  if (isRehydration) {
    console.log(
      `[MCP] Rehydrating connection ${connectionKey} - connection exists but manager missing from cache`,
    );
  }

  const guaranteedIntegrationSlug = integrationSlug ?? getIntegrationSlugFromServerUrl(serverUrl);

  const { formattedString: formattedServerUrl, missingDependencies } =
    await formatStringWithDependencyFromIntegrationSystem({
      targetString: serverUrl,
      integrationSlug: guaranteedIntegrationSlug,
      mode,
      userId: userId!,
    });

  const allMissingDependencies = missingDependencies;

  const formattedHeaders: Record<string, string> = {};
  if (headers) {
    for (const header of Object.keys(headers)) {
      const value = headers[header];
      const {
        formattedString: formattedHeaderValue,
        missingDependencies: missingHeaderDependencies,
      } = await formatStringWithDependencyFromIntegrationSystem({
        targetString: value,
        integrationSlug: guaranteedIntegrationSlug,
        mode,
        userId: userId!,
      });
      allMissingDependencies.push(...missingHeaderDependencies);
      formattedHeaders[header] = formattedHeaderValue;
    }
  }

  const requiredDependencies = [...new Set(allMissingDependencies)];
  const finalRedirectUrl = await params.getFinalRedirectUrl?.({
    durableObjectInstanceName: agentDurableObjectName,
    reducedState: reducedState,
  });

  if (allMissingDependencies.length > 0) {
    events.push({
      type: "MCP:OAUTH_REQUIRED",
      data: {
        connectionKey,
        serverUrl,
        mode,
        userId,
        integrationSlug: guaranteedIntegrationSlug,
        oauthUrl: getIntegrationSecretFormUIURL({
          message: `Please add the following dependencies to the integration ${guaranteedIntegrationSlug}`,
          integrationSlug: guaranteedIntegrationSlug,
          mode,
          userId: userId!,
          requiredDependencies,
          finalRedirectUrl,
          requestedByAgentDOId: agentDurableObjectId,
          serverUrl,
          requiresAuth,
          headers,
        }),
      },
      metadata: {},
      triggerLLMRequest: false,
    });
    return events;
  }

  const oauthProvider = requiresAuth
    ? new MCPOAuthProvider({
        clientId: "iterate-mcp-client",
        serverId: formattedServerUrl,
      })
    : undefined;

  const manager = new MCPClientManager("iterate-agent", "1.0.0");

  let result: Awaited<ReturnType<typeof manager.connect>>;

  try {
    result = await Promise.race([
      manager.connect(formattedServerUrl, {
        transport: {
          authProvider: oauthProvider,
          type: "auto",
          requestInit: {
            headers: formattedHeaders,
          },
        },
      }),
      // wait 20 seconds - if fail, add an error event
      new Promise<typeof result>((_, reject) => {
        setTimeout(
          () => reject(new Error("MCP connection timeout - authentication may have expired")),
          20_000, // 10_000 was too short for some
        );
      }),
    ]);
  } catch (error) {
    if (requiresAuth) {
      // clear tokens and re-setup oauth flow
      oauthProvider?.clearTokens();
      // await oauthProvider?.setupOAuthFlow();
    }

    if (requiresAuth && oauthProvider?.authUrl) {
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

  mcpManagerCache.managers.set(connectionKey, manager);

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
      requiresAuth,
      headers,
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
  const { event, reducedState } = params;
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
        const manager = mcpManagerCache.managers.get(key);
        if (manager) {
          await manager.closeConnection(connection.serverId);
          mcpManagerCache.managers.delete(key);
          // Clean up empty queue for this connection key
          const entry = connectionQueues.get(key);
          if (entry && entry.queue.size === 0 && entry.queue.pending === 0) {
            connectionQueues.delete(key);
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
 * Performance optimization: Once a connection is established and cached,
 * subsequent requests bypass the queue entirely for faster access.
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

// One queue per connection key, each with concurrency: 1
export const connectionQueues = new Map<MCPConnectionKey, ConnectionQueueEntry>();

export function getConnectionQueue(connectionKey: MCPConnectionKey): ConnectionQueueEntry {
  let entry = connectionQueues.get(connectionKey);
  if (!entry) {
    entry = {
      queue: new PQueue({ concurrency: 1 }),
      controller: new AbortController(),
    };
    connectionQueues.set(connectionKey, entry);
  }
  return entry;
}

export function abortPendingConnections(connectionKey: MCPConnectionKey, reason: string) {
  const entry = connectionQueues.get(connectionKey);
  if (entry) {
    // Abort all pending tasks - this will cause p-queue to reject promises
    // for both executing and pending tasks when they check the signal
    entry.controller.abort(reason);

    // Important: We don't delete the queue entry immediately to avoid race conditions.
    // The queue will be cleaned up by the timeout in the finally block of getOrCreateMCPConnection
    // after all tasks have been processed (either completed or aborted).
  }
}

export async function getOrCreateMCPConnection(params: {
  connectionKey: MCPConnectionKey;
  connection: MCPConnection;
  agentDurableObjectId: string;
  agentDurableObjectName: string;
  reducedState: MergedStateForSlices<CoreAgentSlices>;
  getFinalRedirectUrl?: (payload: {
    durableObjectInstanceName: string;
    reducedState: MergedStateForSlices<CoreAgentSlices>;
  }) => Promise<string | undefined>;
}): Promise<Result<MCPConnectionResult>> {
  const { connectionKey, connection } = params;

  // Check cache first before even creating/using a queue
  const existingManager = mcpManagerCache.managers.get(connectionKey);
  if (existingManager) {
    return { success: true, data: { manager: existingManager, events: [] } };
  }

  // Only use queue for actual connection attempts
  const { queue, controller } = getConnectionQueue(connectionKey);

  const result = await queue.add(
    async ({ signal }): Promise<Result<MCPConnectionResult>> => {
      // Actually create the connection (only one execution at a time per key)
      try {
        // Double-check inside queue in case another concurrent request completed
        const existingManager = mcpManagerCache.managers.get(connectionKey);
        if (existingManager) {
          return { success: true, data: { manager: existingManager, events: [] } };
        }

        // Check if we've been aborted before starting
        if (signal?.aborted) {
          return { success: false, error: signal.reason || "Connection aborted" };
        }
        const events = await handleMCPConnectRequest({
          event: {
            type: "MCP:CONNECT_REQUEST",
            data: {
              serverUrl: connection.serverUrl,
              mode: connection.mode,
              userId: connection.userId,
              integrationSlug: connection.integrationSlug,
              requiresAuth: connection.requiresAuth ?? true,
              headers: connection.headers,
              allowedTools: connection.tools.map((t) => t.name),
              allowedPrompts: connection.prompts.map((p) => p.name),
              allowedResources: connection.resources.map((r) => r.uri),
              triggerLLMRequestOnEstablishedConnection: false,
            },
            eventIndex: 0,
            createdAt: new Date().toISOString(),
            metadata: {},
            triggerLLMRequest: false,
          } as MCPConnectRequestEvent,
          reducedState: params.reducedState,
          agentDurableObjectId: params.agentDurableObjectId,
          agentDurableObjectName: params.agentDurableObjectName,
          getFinalRedirectUrl: params.getFinalRedirectUrl,
        });

        console.log("events", events);

        // Check if events contain oauth_required or connection_error
        const hasOAuthRequired = events.some((e) => e.type === "MCP:OAUTH_REQUIRED");
        const hasConnectionError = events.some((e) => e.type === "MCP:CONNECTION_ERROR");

        if (hasOAuthRequired || hasConnectionError) {
          // Abort all pending connections for this key
          const abortReason = hasOAuthRequired
            ? "OAuth authorization required - aborting pending connection attempts"
            : "Connection failed - aborting pending connection attempts";
          console.log("aborting pending connections", abortReason);
          abortPendingConnections(params.connectionKey, abortReason);

          console.log("aborted pending connections", abortReason);
        }

        // The manager should be available after successful connection
        const manager = mcpManagerCache.managers.get(params.connectionKey);
        if (!manager) {
          return { success: true, data: { manager: undefined, events } };
        }

        return { success: true, data: { manager, events } };
      } catch (error) {
        // Also abort on uncaught errors
        abortPendingConnections(params.connectionKey, `Connection error: ${String(error)}`);
        return { success: false, error: String(error) };
      } finally {
        // Clean up empty queue after connection attempt.
        // We need a timeout because when we're in this finally block, our task
        // is still being processed by the queue. The queue's internal state
        // (size and pending count) won't be updated until after our callback completes.
        setTimeout(() => {
          const entry = connectionQueues.get(connectionKey);
          if (entry && entry.queue.size === 0 && entry.queue.pending === 0) {
            connectionQueues.delete(connectionKey);
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
 * Lazily connect to an MCP server when a tool is first used.
 *
 * Performance optimizations:
 * 1. Returns immediately if connection exists in cache (no queue overhead)
 * 2. Uses queue only for actual connection attempts to prevent duplicates
 * 3. Cleans up idle queues automatically after connection attempts
 */
export async function lazyConnectMCPServer(params: {
  connectionKey: MCPConnectionKey;
  connection: MCPConnection;
  agentDurableObjectId: string;
  agentDurableObjectName: string;
  reducedState: MergedStateForSlices<CoreAgentSlices>;
  getFinalRedirectUrl?: (payload: {
    durableObjectInstanceName: string;
    reducedState: MergedStateForSlices<CoreAgentSlices>;
  }) => Promise<string | undefined>;
}): Promise<Result<MCPClientManager | undefined> & { events?: MCPEventHookReturnEvent[] }> {
  const { connectionKey } = params;

  const existingManager = mcpManagerCache.managers.get(connectionKey);
  if (existingManager) {
    return { success: true, data: existingManager };
  }

  // Use the memoized connection function
  const result = await getOrCreateMCPConnection(params);

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
    case "MCP:ADD_MCP_SERVERS":
      return await handleAddMcpServers({ ...params, event: params.event });
    case "MCP:REMOVE_MCP_SERVERS":
      return await handleRemoveMcpServers({ ...params, event: params.event });
    case "MCP:CONNECT_REQUEST":
      return await handleMCPConnectRequest({ ...params, event: params.event });
    case "MCP:DISCONNECT_REQUEST":
      return await handleMCPDisconnectRequest({ ...params, event: params.event });
    default:
      exhaustiveMatchingGuard(params.event);
  }
}
