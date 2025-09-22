import { z } from "zod/v4";
import { defineAgentCoreSlice } from "../agent-core.ts";
import {
  agentCoreBaseEventFields,
  agentCoreBaseEventInputFields,
  type AgentCoreEventInput,
  type CoreReducedState,
} from "../agent-core-schemas.ts";
import type { ResponseInputItem } from "../openai-response-schemas.ts";
import { IntegrationMode } from "../tool-schemas.ts";
import type { CloudflareEnv } from "../../../env.ts";
import {
  generateRuntimeToolsFromConnections,
  type LazyConnectionDeps,
} from "./mcp-tool-mapping.ts";

// ------------------------- Schemas -------------------------

/** Connection key format: serverUrl::mode::userId (personal) or serverUrl::company (company) */
export const MCPConnectionKey = z
  .string()
  .regex(
    /^.+::(personal::[^:]+|company)$/,
    "MCPConnectionKey must be in format 'serverUrl::personal::userId' or 'serverUrl::company'",
  )
  .brand<"MCPConnectionKey">();
export type MCPConnectionKey = z.infer<typeof MCPConnectionKey>;

// Individual schemas for reuse
export const MCPTool = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.any(),
});

export const MCPPromptArgument = z.object({
  name: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
});

export const MCPPrompt = z.object({
  name: z.string(),
  description: z.string().optional(),
  arguments: z.array(MCPPromptArgument).optional(),
});

export const MCPResource = z.object({
  uri: z.string(),
  name: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});

export const MCPConnection = z.object({
  serverId: z.string(), // ID from MCPClientManager
  serverUrl: z.string(),
  serverName: z.string(),
  mode: IntegrationMode,
  userId: z.string().optional(),
  integrationSlug: z.string().optional(),
  tools: z.array(MCPTool),
  prompts: z.array(MCPPrompt),
  resources: z.array(MCPResource),
  connectedAt: z.string(),
  requiresAuth: z.boolean().default(true).optional(), // For backwards compatibility with existing connections
  headers: z.record(z.string(), z.string()).optional(),
});

// ------------------------- Types -------------------------

export type MCPTool = z.infer<typeof MCPTool>;
export type MCPPrompt = z.infer<typeof MCPPrompt>;
export type MCPPromptArgument = z.infer<typeof MCPPromptArgument>;
export type MCPResource = z.infer<typeof MCPResource>;
export type MCPConnection = z.infer<typeof MCPConnection>;

export interface MCPSliceState {
  mcpConnections: Record<MCPConnectionKey, MCPConnection>;
  pendingConnections: string[]; // Track pending connection keys
}

// ------------------------- Event Schemas -------------------------

const mcpConnectRequestFields = {
  type: z.literal("MCP:CONNECT_REQUEST"),
  data: z.object({
    serverUrl: z.string(),
    mode: IntegrationMode,
    userId: z.string().optional(),
    integrationSlug: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    allowedPrompts: z.array(z.string()).optional(),
    allowedResources: z.array(z.string()).optional(),
    requiresAuth: z.boolean().default(true),
    triggerLLMRequestOnEstablishedConnection: z.boolean().default(false),
    headers: z.record(z.string(), z.string()).optional(),
    reconnect: z
      .object({
        id: z.string(),
        oauthClientId: z.string().optional(),
        oauthCode: z.string().optional(),
      })
      .optional(),
  }),
};

export const MCPConnectRequestEvent = z.object({
  ...agentCoreBaseEventFields,
  ...mcpConnectRequestFields,
});

export const MCPConnectRequestEventInput = z.object({
  ...agentCoreBaseEventInputFields,
  ...mcpConnectRequestFields,
});

const mcpConnectionEstablishedFields = {
  type: z.literal("MCP:CONNECTION_ESTABLISHED"),
  data: z.object({
    connectionKey: z.string(),
    serverId: z.string(),
    serverUrl: z.string(),
    serverName: z.string(),
    mode: IntegrationMode,
    userId: z.string().optional(),
    integrationSlug: z.string(),
    tools: z.array(MCPTool),
    prompts: z.array(MCPPrompt),
    resources: z.array(MCPResource),
    requiresAuth: z.boolean().default(true),
    headers: z.record(z.string(), z.string()).optional(),
  }),
};

export const MCPConnectionEstablishedEvent = z.object({
  ...agentCoreBaseEventFields,
  ...mcpConnectionEstablishedFields,
});

export const MCPConnectionEstablishedEventInput = z.object({
  ...agentCoreBaseEventInputFields,
  ...mcpConnectionEstablishedFields,
});

const mcpDisconnectRequestFields = {
  type: z.literal("MCP:DISCONNECT_REQUEST"),
  data: z.object({
    connectionKey: MCPConnectionKey.optional(),
    serverUrl: z.string().optional(),
    userId: z.string().optional(),
  }),
};

export const MCPDisconnectRequestEvent = z.object({
  ...agentCoreBaseEventFields,
  ...mcpDisconnectRequestFields,
});

export const MCPDisconnectRequestEventInput = z.object({
  ...agentCoreBaseEventInputFields,
  ...mcpDisconnectRequestFields,
});

const mcpToolsChangedFields = {
  type: z.literal("MCP:TOOLS_CHANGED"),
  data: z.object({
    connectionKey: MCPConnectionKey,
    serverId: z.string(),
    tools: z.array(MCPTool),
  }),
};

export const MCPToolsChanged = z.object({
  ...agentCoreBaseEventFields,
  ...mcpToolsChangedFields,
});

export const MCPToolsChangedInput = z.object({
  ...agentCoreBaseEventInputFields,
  ...mcpToolsChangedFields,
});

const mcpConnectionErrorFields = {
  type: z.literal("MCP:CONNECTION_ERROR"),
  data: z.object({
    connectionKey: MCPConnectionKey.optional(),
    serverUrl: z.string(),
    userId: z.string().optional(),
    error: z.string(),
  }),
};

export const MCPConnectionErrorEvent = z.object({
  ...agentCoreBaseEventFields,
  ...mcpConnectionErrorFields,
});

export const MCPConnectionErrorEventInput = z.object({
  ...agentCoreBaseEventInputFields,
  ...mcpConnectionErrorFields,
});

const mcpOAuthRequiredFields = {
  type: z.literal("MCP:OAUTH_REQUIRED"),
  data: z.object({
    connectionKey: z.string(),
    serverUrl: z.string(),
    mode: IntegrationMode,
    userId: z.string().optional(),
    integrationSlug: z.string(),
    oauthUrl: z.string(),
  }),
};

export const MCPOAuthRequiredEvent = z.object({
  ...agentCoreBaseEventFields,
  ...mcpOAuthRequiredFields,
});

export const MCPOAuthRequiredEventInput = z.object({
  ...agentCoreBaseEventInputFields,
  ...mcpOAuthRequiredFields,
});

// ------------------------- Discriminated Unions -------------------------

export const MCPEvent = z.discriminatedUnion("type", [
  MCPConnectRequestEvent,
  MCPConnectionEstablishedEvent,
  MCPDisconnectRequestEvent,
  MCPToolsChanged,
  MCPConnectionErrorEvent,
  MCPOAuthRequiredEvent,
]);

export const MCPEventInput = z.discriminatedUnion("type", [
  MCPConnectRequestEventInput,
  MCPConnectionEstablishedEventInput,
  MCPDisconnectRequestEventInput,
  MCPToolsChangedInput,
  MCPConnectionErrorEventInput,
  MCPOAuthRequiredEventInput,
]);

// ------------------------- Types -------------------------

export type MCPConnectRequestEvent = z.infer<typeof MCPConnectRequestEvent>;
export type MCPDisconnectRequestEvent = z.infer<typeof MCPDisconnectRequestEvent>;
export type MCPConnectionEstablishedEvent = z.infer<typeof MCPConnectionEstablishedEvent>;
export type MCPConnectionErrorEvent = z.infer<typeof MCPConnectionErrorEvent>;
export type MCPOAuthRequiredEvent = z.infer<typeof MCPOAuthRequiredEvent>;

export type MCPConnectRequestEventInput = z.infer<typeof MCPConnectRequestEventInput>;
export type MCPDisconnectRequestEventInput = z.infer<typeof MCPDisconnectRequestEventInput>;
export type MCPConnectionEstablishedEventInput = z.infer<typeof MCPConnectionEstablishedEventInput>;
export type MCPConnectionErrorEventInput = z.infer<typeof MCPConnectionErrorEventInput>;
export type MCPOAuthRequiredEventInput = z.infer<typeof MCPOAuthRequiredEventInput>;

export type MCPEvent = z.infer<typeof MCPEvent>;
export type MCPEventInput = z.input<typeof MCPEventInput>;

// ------------------------- Helper Functions -------------------------

/**
 * Generate a connection key from server URL, mode, and optional user ID
 */
export function getConnectionKey(params: {
  serverUrl: string;
  mode: IntegrationMode;
  userId?: string;
}) {
  const { serverUrl, mode, userId } = params;
  if (mode === "personal" && userId) {
    return MCPConnectionKey.parse(`${serverUrl}::personal::${userId}`);
  }
  return MCPConnectionKey.parse(`${serverUrl}::company`);
}

/**
 * Parse a connection key into its components
 */
export function parseConnectionKey(key: MCPConnectionKey) {
  const [serverUrl, mode, userId] = key.split("::");
  return { serverUrl, mode: IntegrationMode.parse(mode), userId };
}

/**
 * Update runtime tools from MCP connections
 */
function updateRuntimeTools<TEventInput = AgentCoreEventInput>(params: {
  state: CoreReducedState<TEventInput> & MCPSliceState;
  newConnections: Record<MCPConnectionKey, MCPConnection>;
  deps: MCPSliceDeps;
}): typeof params.state.groupedRuntimeTools {
  const { newConnections, deps } = params;
  const newRuntimeTools = generateRuntimeToolsFromConnections(
    newConnections,
    deps.uploadFile ||
      (() => {
        throw new Error("uploadFile dependency not implemented");
      }),
    deps.lazyConnectionDeps,
  );

  return { ...params.state.groupedRuntimeTools, mcp: newRuntimeTools };
}

// ------------------------- Slice Dependencies -------------------------

export interface MCPSliceDeps {
  env: CloudflareEnv;
  uploadFile?: (data: {
    content: ReadableStream;
    filename: string;
    contentLength?: number;
    mimeType?: string;
    metadata?: Record<string, any>;
  }) => Promise<{
    fileId: string;
    openAIFileId: string;
    originalFilename?: string;
    size?: number;
    mimeType?: string;
  }>;
  lazyConnectionDeps?: LazyConnectionDeps;
}

// ------------------------- Slice Definition -------------------------

export const mcpSlice = defineAgentCoreSlice<{
  SliceState: MCPSliceState;
  EventSchema: typeof MCPEvent;
  EventInputSchema: typeof MCPEventInput;
  SliceDeps: MCPSliceDeps;
}>({
  name: "mcp-slice",
  eventSchema: MCPEvent,
  eventInputSchema: MCPEventInput,
  initialState: {
    mcpConnections: {},
    pendingConnections: [],
  },
  reduce(state, deps, event) {
    switch (event.type) {
      case "MCP:CONNECT_REQUEST": {
        const { serverUrl, mode, userId } = event.data;
        const connectionKey = getConnectionKey({ serverUrl, mode, userId });
        const { [connectionKey]: _conn, ...rest } = state.mcpConnections;
        // Add to pending connections if not already there
        const pendingConnections = state.pendingConnections || [];
        const newPendingConnections = pendingConnections.includes(connectionKey)
          ? pendingConnections
          : [...pendingConnections, connectionKey];

        // Update runtime tools to remove tools from the disconnected connection
        const updatedRuntimeTools = updateRuntimeTools({ state, newConnections: rest, deps });

        return {
          mcpConnections: { ...rest },
          pendingConnections: newPendingConnections,
          groupedRuntimeTools: updatedRuntimeTools,
          inputItems: [...state.inputItems],
        };
      }

      case "MCP:CONNECTION_ESTABLISHED": {
        const { connectionKey, ...connectionProps } = event.data;
        const newConnections = {
          ...state.mcpConnections,
          [connectionKey]: {
            ...connectionProps,
            isConnected: true,
            connectedAt: new Date().toISOString(),
          },
        };

        const { userId, integrationSlug, tools } = connectionProps;
        const updatedRuntimeTools = updateRuntimeTools({ state, newConnections, deps });
        const connectionMessage = {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: `User ${userId} connected to ${integrationSlug} (${tools.length} new tools available)`,
            },
          ],
        } satisfies ResponseInputItem;

        // Remove from pending connections
        const pendingConnections = state.pendingConnections || [];
        const newPendingConnections = pendingConnections.filter((key) => key !== connectionKey);

        return {
          mcpConnections: newConnections,
          pendingConnections: newPendingConnections,
          groupedRuntimeTools: updatedRuntimeTools,
          inputItems: [...state.inputItems, connectionMessage],
          // Only trigger LLM if no more pending connections
          triggerLLMRequest: newPendingConnections.length === 0,
        };
      }

      case "MCP:DISCONNECT_REQUEST": {
        const { connectionKey } = event.data;
        const newConnections = { ...state.mcpConnections };
        if (connectionKey) {
          delete newConnections[connectionKey];
        }
        const updatedRuntimeTools = updateRuntimeTools({ state, newConnections, deps });
        return {
          mcpConnections: newConnections,
          groupedRuntimeTools: updatedRuntimeTools,
          inputItems: [...state.inputItems],
        };
      }

      case "MCP:TOOLS_CHANGED": {
        const { connectionKey, tools } = event.data;
        const connection = state.mcpConnections[connectionKey];
        if (!connection || !connection.connectedAt) {
          const { [connectionKey]: _removed, ...rest } = state.mcpConnections;
          return { mcpConnections: rest };
        }
        const newConnections = {
          ...state.mcpConnections,
          [connectionKey]: {
            ...connection,
            tools,
          },
        };
        const updatedRuntimeTools = updateRuntimeTools({ state, newConnections, deps });
        return {
          mcpConnections: newConnections,
          groupedRuntimeTools: updatedRuntimeTools,
          inputItems: [...state.inputItems],
        };
      }

      case "MCP:CONNECTION_ERROR": {
        const { connectionKey, error } = event.data;

        const errorMessage = {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: `Failed to connect to ${connectionKey}: ${error}`,
            },
          ],
        } satisfies ResponseInputItem;

        // Remove the connection from state on error
        const newConnections = { ...state.mcpConnections };
        if (connectionKey) {
          delete newConnections[connectionKey];
        }
        const updatedRuntimeTools = updateRuntimeTools({ state, newConnections, deps });

        // Remove from pending connections
        const pendingConnections = state.pendingConnections || [];
        const newPendingConnections = connectionKey
          ? pendingConnections.filter((key) => key !== connectionKey)
          : pendingConnections;

        return {
          mcpConnections: newConnections,
          pendingConnections: newPendingConnections,
          groupedRuntimeTools: updatedRuntimeTools,
          inputItems: [...state.inputItems, errorMessage],
          // Only trigger LLM if no more pending connections
          triggerLLMRequest: newPendingConnections.length === 0,
        };
      }

      case "MCP:OAUTH_REQUIRED": {
        const { connectionKey, serverUrl, mode, userId, integrationSlug, oauthUrl } = event.data;

        if (!oauthUrl) {
          return {};
        }

        const oauthMessage = {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: `Authorization needed to access ${integrationSlug}. URL to authorize: ${oauthUrl}. Connection will proceed automatically once authorization is complete.`,
            },
          ],
        } satisfies ResponseInputItem;

        // Remove from pending connections since OAuth is needed
        const pendingConnections = state.pendingConnections || [];
        const newPendingConnections = pendingConnections.filter((key) => key !== connectionKey);

        const newState = {
          mcpConnections: {
            ...state.mcpConnections,
            [connectionKey]: {
              serverId: "",
              serverUrl,
              mode,
              userId,
              integrationSlug,
              tools: [],
              prompts: [],
              resources: [],
            },
          },
          pendingConnections: newPendingConnections,
          inputItems: [...state.inputItems, oauthMessage],
          // Only trigger LLM if no more pending connections
          triggerLLMRequest: newPendingConnections.length === 0,
        };
        return newState;
      }

      default:
        return {};
    }
  },
});
