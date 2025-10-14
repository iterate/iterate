import { z } from "zod/v4";
import type { AgentCoreDeps, MergedStateForSlices } from "../agent-core.ts";
import type { AgentCoreEvent } from "../agent-core-schemas.ts";
import type { LocalFunctionRuntimeTool } from "../tool-schemas.ts";
import { sanitizeToolName } from "../tool-spec-to-runtime-tool.ts";
import { IntegrationMode } from "../tool-schemas.ts";
import type { CoreAgentSlices } from "../iterate-agent.ts";
import type { AgentDurableObjectInfo } from "../../auth/oauth-state-schemas.ts";
import { logger } from "../../tag-logger.ts";
import {
  rehydrateExistingMCPConnection,
  createCacheKey,
  type MCPManagerCache,
  type MCPConnectionQueues,
} from "./mcp-event-hooks.ts";
import { MCPConnectionKey, type MCPConnection, type MCPTool } from "./mcp-slice.ts";
import type { MCPEventHookReturnEvent } from "./mcp-event-hooks.ts";

type UploadFileFunction = NonNullable<AgentCoreDeps["uploadFile"]>;

export const MCPToolConnectionInfo = z.object({
  serverId: z.string(),
  mode: IntegrationMode,
  userId: z.string().optional(),
  toolSchema: z.any(),
});

export const MCPToolMappingInfo = z.object({
  integrationSlug: z.string(),
  originalName: z.string(),
  connections: z.record(z.string(), MCPToolConnectionInfo),
});

export const MCPToolMapping = z.record(z.string(), MCPToolMappingInfo);

export type MCPToolConnectionInfo = z.infer<typeof MCPToolConnectionInfo>;
export type MCPToolMappingInfo = z.infer<typeof MCPToolMappingInfo>;
export type MCPToolMapping = z.infer<typeof MCPToolMapping>;

// ------------------------- MCP Content Processing -------------------------

/**
 * Schema for MCP tool result content items
 */
export const MCPContentItem = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    annotations: z
      .object({
        audience: z.array(z.string()).optional(),
        priority: z.number().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("image"),
    data: z.base64(),
    mimeType: z.string(),
    annotations: z
      .object({
        audience: z.array(z.string()).optional(),
        priority: z.number().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("audio"),
    data: z.base64(),
    mimeType: z.string(),
    annotations: z
      .object({
        audience: z.array(z.string()).optional(),
        priority: z.number().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("resource_link"),
    uri: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    annotations: z
      .object({
        audience: z.array(z.string()).optional(),
        priority: z.number().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("resource"),
    resource: z.object({
      uri: z.string(),
      title: z.string().optional(),
      mimeType: z.string().optional(),
      text: z.string().optional(),
      annotations: z
        .object({
          audience: z.array(z.string()).optional(),
          priority: z.number().optional(),
          lastModified: z.string().optional(),
        })
        .optional(),
    }),
    annotations: z
      .object({
        audience: z.array(z.string()).optional(),
        priority: z.number().optional(),
      })
      .optional(),
  }),
]);

export type MCPContentItem = z.infer<typeof MCPContentItem>;

/**
 * Process MCP content array and handle file uploads for binary content
 */
export async function processMCPContent(
  content: unknown[],
  uploadFile: UploadFileFunction,
): Promise<{
  textContent: string[];
  processedContent: Record<string, unknown>[];
  fileEvents: AgentCoreEvent[];
}> {
  const textContent: string[] = [];
  const processedContent: Record<string, unknown>[] = [];
  const fileEvents: AgentCoreEvent[] = [];

  for (const item of content) {
    const parsed = MCPContentItem.safeParse(item);

    if (!parsed.success) {
      // If parsing fails, treat as generic content and add to processed content
      processedContent.push(item as Record<string, unknown>);
      continue;
    }

    const contentItem = parsed.data;

    if (contentItem.type === "text") {
      textContent.push(contentItem.text);
      processedContent.push({
        type: contentItem.type,
        text: contentItem.text,
        ...(contentItem.annotations && { annotations: contentItem.annotations }),
      });
    } else if (contentItem.type === "image" || contentItem.type === "audio") {
      // Handle binary content - upload to Iterate
      const { data, ...itemWithoutData } = contentItem;

      try {
        // Convert base64 to buffer
        const buffer = Buffer.from(data, "base64");
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(buffer);
            controller.close();
          },
        });

        // Generate filename based on content type
        const extension =
          contentItem.mimeType.split("/")[1] || (contentItem.type === "image" ? "png" : "wav");
        const filename = `mcp-${contentItem.type}-${Date.now()}.${extension}`;

        // Upload the file
        const iterateFile = await uploadFile({
          content: stream,
          filename,
          contentLength: buffer.length,
          mimeType: contentItem.mimeType,
          metadata: {
            mcpContentItem: itemWithoutData,
            source: "mcp-tool-result",
          },
        });

        // Add file shared event
        fileEvents.push({
          type: "CORE:FILE_SHARED",
          data: {
            direction: "from-agent-to-user",
            iterateFileId: iterateFile.fileId,
            openAIFileId: iterateFile.openAIFileId,
            originalFilename: filename,
            size: iterateFile.size,
            mimeType: contentItem.mimeType,
          },
        });

        // Add processed content without data field
        processedContent.push({
          ...itemWithoutData,
          iterateFileId: iterateFile.fileId,
          filename,
        });
      } catch (error) {
        logger.error(
          `[MCP] Failed to upload ${contentItem.type} content:`,
          error instanceof Error ? error : new Error(String(error)),
        );
        // Add to processed content without data field as fallback
        const { data: _data, ...itemWithoutData } = contentItem;
        processedContent.push({
          ...itemWithoutData,
          error: "Failed to upload file",
        });
      }
    } else {
      // Handle other content types (resource_link, resource) - pass through without data field
      processedContent.push(contentItem);
    }
  }

  return {
    textContent,
    processedContent,
    fileEvents,
  };
}

// ------------------------- Tool Name Generation -------------------------

/**
 * Generate tool name using integrationSlug and original tool name
 * Format: {integrationSlug}_{toolName}
 * Ensures the name doesn't exceed 64 characters (OpenAI limit)
 */
export function generateToolName(params: { slug: string; toolName: string }): string {
  const { slug, toolName } = params;
  const prefix = `${slug}_`;
  const remainingSpace = 64 - prefix.length;
  const truncatedToolName =
    toolName.length > remainingSpace ? `${toolName.slice(0, remainingSpace - 3)}...` : toolName;
  return sanitizeToolName(`${prefix}${truncatedToolName}`);
}

// ------------------------- Tool Mapping Computation -------------------------

/**
 * Compute tool mapping from active connections
 * Returns deduplicated tools with their available connections
 */
export function computeToolMapping(
  connections: Record<MCPConnectionKey, MCPConnection>,
): MCPToolMapping {
  const toolMapping: MCPToolMapping = {};
  for (const [connectionKey, connection] of Object.entries(connections) as [
    MCPConnectionKey,
    MCPConnection,
  ][]) {
    if (!connection.connectedAt || !connection.tools) {
      continue;
    }
    for (const tool of connection.tools) {
      const toolName = generateToolName({
        slug: (connection.serverName ?? connection.integrationSlug ?? "mcp").toLowerCase(),
        toolName: tool.name,
      });
      if (!toolMapping[toolName]) {
        toolMapping[toolName] = {
          integrationSlug: connection.integrationSlug ?? connection.serverUrl,
          originalName: tool.name,
          connections: {},
        };
      }
      toolMapping[toolName]!.connections[connectionKey] = {
        serverId: connection.serverId,
        mode: connection.mode,
        userId: connection.userId,
        toolSchema: tool.inputSchema,
      };
    }
  }
  return toolMapping;
}

// ------------------------- Schema Validation -------------------------

/**
 * Check for schema conflicts across multiple connections for the same tool
 * Returns true if there are conflicts, false otherwise
 */
function hasToolSchemaConflicts(
  toolName: string,
  connections: Record<MCPConnectionKey, MCPToolConnectionInfo>,
): boolean {
  const schemas = Object.values(connections).map((c) => c.toolSchema);
  const firstSchema = schemas[0];
  const hasConflict = schemas.some(
    (schema) => JSON.stringify(schema) !== JSON.stringify(firstSchema),
  );

  if (hasConflict) {
    logger.error(`[MCP] Schema conflict detected for tool ${toolName}. Skipping tool creation.`);
  }

  return hasConflict;
}

// ------------------------- Runtime Tool Generation -------------------------

/**
 * Generate runtime tools from current connections
 */
export function generateRuntimeToolsFromConnections(
  connections: Record<MCPConnectionKey, MCPConnection>,
  uploadFile: UploadFileFunction,
  lazyConnectionDeps?: LazyConnectionDeps,
): LocalFunctionRuntimeTool[] {
  const toolMapping = computeToolMapping(connections);
  const runtimeTools: LocalFunctionRuntimeTool[] = [];
  for (const [toolName, toolInfo] of Object.entries(toolMapping)) {
    const firstConnectionKey = MCPConnectionKey.parse(Object.keys(toolInfo.connections)[0]);
    const firstConnection = connections[firstConnectionKey];
    if (!firstConnection) {
      continue;
    }
    const originalTool = firstConnection.tools.find((t) => t.name === toolInfo.originalName);
    if (!originalTool) {
      continue;
    }
    if (hasToolSchemaConflicts(toolName, toolInfo.connections)) {
      continue;
    }
    runtimeTools.push(
      createRuntimeToolFromMCPTool({
        tool: originalTool,
        toolName,
        integrationSlug: toolInfo.integrationSlug,
        connections: toolInfo.connections,
        uploadFile,
        lazyConnectionDeps,
      }),
    );
  }
  return runtimeTools;
}

// ------------------------- Runtime Tool Creation -------------------------

// Lazy connection dependencies interface
export interface LazyConnectionDeps {
  getDurableObjectInfo: () => AgentDurableObjectInfo;
  getEstateId: () => string;
  getReducedState: () => MergedStateForSlices<CoreAgentSlices>;
  mcpConnectionCache: MCPManagerCache;
  mcpConnectionQueues: MCPConnectionQueues;
  getFinalRedirectUrl?: (payload: {
    durableObjectInstanceName: string;
  }) => Promise<string | undefined>;
}

/**
 * Convert MCP tool to OpenAI runtime tool with impersonation support
 */
export function createRuntimeToolFromMCPTool(params: {
  tool: MCPTool; // Original tool definition from MCP
  toolName: string;
  integrationSlug: string;
  connections: Record<MCPConnectionKey, MCPToolConnectionInfo>;
  uploadFile: UploadFileFunction;
  lazyConnectionDeps?: LazyConnectionDeps;
}): LocalFunctionRuntimeTool {
  const { tool, toolName, integrationSlug, connections, uploadFile } = params;

  const hasPersonalConnections = Object.values(connections).some((c) => c.mode === "personal");

  let modifiedParameters = tool.inputSchema || { type: "object", properties: {} };

  if (hasPersonalConnections) {
    if (!modifiedParameters.type || modifiedParameters.type !== "object") {
      modifiedParameters = { type: "object", properties: {} };
    }

    modifiedParameters = {
      ...modifiedParameters,
      properties: {
        ...modifiedParameters.properties,
        impersonateUserId: {
          type: "string",
          description: "ID of the user to impersonate for this tool call",
        },
      },
      required: [...(modifiedParameters.required || []), "impersonateUserId"],
    };
  }

  return {
    type: "function",
    name: toolName,
    description: tool.description || `MCP tool from ${integrationSlug}`,
    parameters: modifiedParameters,
    strict: false,
    metadata: { source: "mcp" },
    async execute(_call, args: any) {
      const { impersonateUserId, ...toolArgs } = args;

      let selectedConnectionKey: MCPConnectionKey | undefined;
      let selectedConnection: MCPToolConnectionInfo | undefined;

      let additionalMCPEvents: MCPEventHookReturnEvent[] = [];

      if (hasPersonalConnections) {
        if (!impersonateUserId) {
          throw new Error(
            `Missing required parameter 'impersonateUserId' for personal MCP tool ${toolName}`,
          );
        }

        for (const [key, conn] of Object.entries(connections)) {
          if (conn.mode === "personal" && conn.userId === impersonateUserId) {
            selectedConnectionKey = MCPConnectionKey.parse(key);
            selectedConnection = conn;
            break;
          }
        }

        if (!selectedConnection || !selectedConnectionKey) {
          throw new Error(
            `No personal MCP connection found for user ${impersonateUserId} for tool ${toolName}. Available users: ${Object.values(
              connections,
            )
              .filter((c) => c.mode === "personal")
              .map((c) => c.userId)
              .join(", ")}`,
          );
        }
      } else {
        const firstKey = MCPConnectionKey.parse(Object.keys(connections)[0]);
        selectedConnectionKey = firstKey;
        selectedConnection = connections[firstKey];

        if (!selectedConnection || !selectedConnectionKey) {
          throw new Error(`No MCP connections available for tool ${toolName}`);
        }
      }

      if (!params.lazyConnectionDeps) {
        throw new Error(
          `Lazy connection deps are required for MCP tool execution to access the cache.`,
        );
      }

      const cacheKey = createCacheKey(selectedConnectionKey);
      let manager = params.lazyConnectionDeps.mcpConnectionCache.managers.get(cacheKey);

      if (!manager) {
        const reducedState = params.lazyConnectionDeps.getReducedState();
        const connection = reducedState.mcpConnections[selectedConnectionKey];

        if (!connection) {
          throw new Error(
            `MCP connection ${selectedConnectionKey} not found in state. The connection may have been removed.`,
          );
        }

        logger.log(`[MCP] Tool ${toolName} triggering lazy connection to ${selectedConnectionKey}`);

        const result = await rehydrateExistingMCPConnection({
          connectionKey: selectedConnectionKey,
          connection,
          agentDurableObject: params.lazyConnectionDeps.getDurableObjectInfo(),
          estateId: params.lazyConnectionDeps.getEstateId(),
          reducedState: reducedState,
          mcpConnectionCache: params.lazyConnectionDeps.mcpConnectionCache,
          mcpConnectionQueues: params.lazyConnectionDeps.mcpConnectionQueues,
          getFinalRedirectUrl: params.lazyConnectionDeps.getFinalRedirectUrl,
        });

        if (!result.success) {
          throw new Error(`Failed to establish MCP connection: ${result.error}`);
        }

        manager = result.data;

        additionalMCPEvents = result.events || [];

        if (!manager) {
          return {
            addEvents: [...additionalMCPEvents],
            toolCallResult: {
              content: [],
              textSummary: `Tool call failed`,
            },
            triggerLLMRequest: `true:mcp-tool-call-failed`,
          };
        }
      }

      // Get the actual serverId from the manager's connections
      // During rehydration, the serverId might change and the state might not be updated yet
      // We always have one mcp connection, so we can just get the first one
      // At this point, manager is definitely assigned (either from cache or lazy connection)
      const actualServerId = Object.keys(manager.mcpConnections)[0];

      if (!actualServerId || !manager.mcpConnections[actualServerId]) {
        throw new Error(
          `There was a system error and the MCP manager is not connected to the server. Please contact support.`,
        );
      }

      const mcpResult = await manager
        .callTool({
          serverId: actualServerId,
          name: tool.name,
          arguments: toolArgs,
        })
        .catch((error) => {
          logger.error(
            `[MCP] Tool execution failed for ${tool.name}:`,
            (error as Error)?.stack || error,
          );
          throw error;
        });

      if (mcpResult?.resource_link) {
        try {
          const resourceContent = await manager.readResource(
            {
              serverId: actualServerId,
              uri: mcpResult.resource_link as string,
            },
            {},
          );

          const contentToProcess = Array.isArray(mcpResult.content)
            ? [...mcpResult.content, { type: "resource", resource: resourceContent }]
            : [mcpResult.content, { type: "resource", resource: resourceContent }];

          const { textContent, processedContent, fileEvents } = await processMCPContent(
            contentToProcess,
            uploadFile,
          );

          const result: any = {
            content: processedContent,
            textSummary: textContent.join("\n"),
          };

          if (mcpResult.structuredContent) {
            result.structuredContent = mcpResult.structuredContent;
          }

          return {
            toolCallResult: result,
            triggerLLMRequest: `true:mcp-resource-link-found`,
            addEvents: [...additionalMCPEvents, ...fileEvents],
          };
        } catch (error) {
          logger.warn(`Failed to fetch resource ${mcpResult.resource_link}:`, error);
        }
      }

      const contentArray = Array.isArray(mcpResult.content)
        ? mcpResult.content
        : mcpResult.content
          ? [mcpResult.content]
          : [];

      const { textContent, processedContent, fileEvents } = await processMCPContent(
        contentArray,
        uploadFile,
      );

      const result: any = {
        content: processedContent,
        textSummary: textContent.join("\n"),
      };

      if (mcpResult.structuredContent) {
        result.structuredContent = mcpResult.structuredContent;
      }

      if (mcpResult.isError) {
        result.isError = mcpResult.isError;
      }

      return {
        toolCallResult: result,
        triggerLLMRequest: `true:mcp-tool-call-succeeded`,
        addEvents: [...additionalMCPEvents, ...fileEvents] as any,
      };
    },
  };
}
