import { z } from "zod";
import { defineAgentCoreSlice } from "../agent-core.ts";
import {
  agentCoreBaseEventFields,
  type AgentCoreEvent,
  type CoreReducedState,
} from "../agent-core-schemas.ts";
import type { ResponseInputItem } from "../openai-response-schemas.ts";
import { IntegrationMode, type RuntimeTool } from "../tool-schemas.ts";
import { AgentDurableObjectInfo } from "../../auth/oauth-state-schemas.ts";
import type { CloudflareEnv } from "../../../env.ts";
import { MCPParam } from "../tool-schemas.ts";
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
  userId: z.string(),
  integrationSlug: z.string().optional(),
  tools: z.array(MCPTool),
  prompts: z.array(MCPPrompt),
  resources: z.array(MCPResource),
  connectedAt: z.string(),
  requiresParams: z.array(MCPParam).optional(),
});

// ------------------------- Types -------------------------

export type MCPTool = z.infer<typeof MCPTool>;
export type MCPPrompt = z.infer<typeof MCPPrompt>;
export type MCPPromptArgument = z.infer<typeof MCPPromptArgument>;
export type MCPResource = z.infer<typeof MCPResource>;
export type MCPConnection = z.infer<typeof MCPConnection>;

export interface MCPSliceState {
  mcpConnections: Record<MCPConnectionKey, MCPConnection>;
}

// ------------------------- Event Schemas -------------------------

const mcpConnectRequestFields = {
  type: z.literal("MCP:CONNECT_REQUEST"),
  data: z.object({
    serverUrl: z.string(),
    mode: IntegrationMode,
    userId: z.string(),
    integrationSlug: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    allowedPrompts: z.array(z.string()).optional(),
    allowedResources: z.array(z.string()).optional(),
    triggerLLMRequestOnEstablishedConnection: z.boolean().default(false),
    requiresParams: z.array(MCPParam).optional(),
    reconnect: z
      .object({
        id: z.string(),
        oauthClientId: z.string(),
        oauthCode: z.string(),
      })
      .optional(),
  }),
};

export const MCPConnectRequestEvent = z.object({
  ...agentCoreBaseEventFields,
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
    requiresParams: z.array(MCPParam).optional(),
  }),
};

export const MCPConnectionEstablishedEvent = z.object({
  ...agentCoreBaseEventFields,
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

const mcpOAuthRequiredFields = {
  type: z.literal("MCP:OAUTH_REQUIRED"),
  data: z.object({
    connectionKey: z.string(),
    serverUrl: z.string(),
    mode: IntegrationMode,
    userId: z.string().optional(),
    integrationSlug: z.string(),
    oauthUrl: z.string(),
    serverId: z.string(),
  }),
};

export const MCPOAuthRequiredEvent = z.object({
  ...agentCoreBaseEventFields,
  ...mcpOAuthRequiredFields,
});

const mcpParamsRequiredFields = {
  type: z.literal("MCP:PARAMS_REQUIRED"),
  data: z.object({
    serverUrl: z.string(),
    mode: IntegrationMode,
    connectionKey: z.string(),
    requiredParams: z.array(MCPParam),
    userId: z.string(),
    agentDurableObject: AgentDurableObjectInfo,
    integrationSlug: z.string(),
    paramsCollectionUrl: z.string(),
  }),
};

export const MCPParamsRequiredEvent = z.object({
  ...agentCoreBaseEventFields,
  ...mcpParamsRequiredFields,
});

// ------------------------- Discriminated Unions -------------------------

export const MCPEvent = z.discriminatedUnion("type", [
  MCPConnectRequestEvent,
  MCPConnectionEstablishedEvent,
  MCPDisconnectRequestEvent,
  MCPToolsChanged,
  MCPConnectionErrorEvent,
  MCPOAuthRequiredEvent,
  MCPParamsRequiredEvent,
]);

// ------------------------- Types -------------------------

export type MCPConnectRequestEvent = z.infer<typeof MCPConnectRequestEvent>;
export type MCPDisconnectRequestEvent = z.infer<typeof MCPDisconnectRequestEvent>;
export type MCPConnectionEstablishedEvent = z.infer<typeof MCPConnectionEstablishedEvent>;
export type MCPConnectionErrorEvent = z.infer<typeof MCPConnectionErrorEvent>;
export type MCPOAuthRequiredEvent = z.infer<typeof MCPOAuthRequiredEvent>;
export type MCPParamsRequiredEvent = z.infer<typeof MCPParamsRequiredEvent>;

export type MCPEvent = z.infer<typeof MCPEvent>;

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
function updateRuntimeTools<TEventInput = AgentCoreEvent>(params: {
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

  return {
    ...params.state.groupedRuntimeTools,
    mcp: newRuntimeTools as RuntimeTool<TEventInput | AgentCoreEvent>[],
  };
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

export type { MCPManagerCache } from "./mcp-event-hooks.ts";

// ------------------------- Slice Definition -------------------------

export const mcpSlice = defineAgentCoreSlice<{
  SliceState: MCPSliceState;
  EventSchema: typeof MCPEvent;
  SliceDeps: MCPSliceDeps;
}>({
  name: "mcp-slice",
  eventSchema: MCPEvent,
  initialState: {
    mcpConnections: {},
  },
  reduce(state, deps, event) {
    switch (event.type) {
      case "MCP:CONNECT_REQUEST": {
        const { serverUrl, mode, userId } = event.data;
        const connectionKey = getConnectionKey({ serverUrl, mode, userId });
        const { [connectionKey]: _conn, ...rest } = state.mcpConnections;
        const updatedRuntimeTools = updateRuntimeTools({ state, newConnections: rest, deps });

        return {
          mcpConnections: { ...rest },
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

        return {
          mcpConnections: newConnections,
          groupedRuntimeTools: updatedRuntimeTools,
          inputItems: [...state.inputItems, connectionMessage],
          triggerLLMRequest: true,
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

        const newConnections = { ...state.mcpConnections };
        if (connectionKey) {
          delete newConnections[connectionKey];
        }
        const updatedRuntimeTools = updateRuntimeTools({ state, newConnections, deps });

        return {
          mcpConnections: newConnections,
          groupedRuntimeTools: updatedRuntimeTools,
          inputItems: [...state.inputItems, errorMessage],
          triggerLLMRequest: true,
        };
      }

      case "MCP:OAUTH_REQUIRED": {
        const { connectionKey, serverUrl, mode, userId, integrationSlug, oauthUrl, serverId } =
          event.data;

        if (!oauthUrl) {
          return {};
        }

        const oauthMessage = {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: `User is being prompted to authorize ${integrationSlug}. Connection will continue automatically once authorized.`,
            },
          ],
        } satisfies ResponseInputItem;

        const newState = {
          mcpConnections: {
            ...state.mcpConnections,
            [connectionKey]: {
              serverId,
              serverUrl,
              mode,
              userId,
              integrationSlug,
              tools: [],
              prompts: [],
              resources: [],
            },
          },
          inputItems: [...state.inputItems, oauthMessage],
          triggerLLMRequest: false,
        };
        return newState;
      }

      case "MCP:PARAMS_REQUIRED": {
        const { connectionKey, serverUrl, mode, userId, integrationSlug } = event.data;

        const paramsRequiredMessage = {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: `User is being prompted to provide additional inputs for ${integrationSlug}. Connection will continue automatically once inputs are added.`,
            },
          ],
        } satisfies ResponseInputItem;

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
          inputItems: [...state.inputItems, paramsRequiredMessage],
          triggerLLMRequest: false,
        };
        return newState;
      }

      default:
        return {};
    }
  },
});
