import {
  generateTypesFromJsonSchema,
  type JsonSchemaToolDescriptors,
  type ToolProvider,
} from "@cloudflare/codemode";
import { sanitizeToolName, uniqueSanitizedToolKey } from "~/lib/codemode-tool-key.ts";

interface McpServerRow {
  id: string;
  /** Stable label from `addMcpServer(name, …)`; preferred over random `id` for codemode namespaces. */
  name?: string;
}

interface McpToolDefinition {
  serverId: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

interface McpTextContent {
  type: string;
  text?: string;
}

interface McpCallToolResult {
  toolResult?: unknown;
  isError?: boolean;
  structuredContent?: unknown;
  content?: McpTextContent[];
}

export interface McpToolProviderSource {
  waitForConnections(options?: { timeout?: number }): Promise<void>;
  listServers(): McpServerRow[];
  listTools(): McpToolDefinition[];
  callTool(params: {
    serverId: string;
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<McpCallToolResult>;
}

export interface CreateMcpToolProvidersOptions {
  mcp: McpToolProviderSource;
  waitForConnectionsTimeout?: number;
}

export async function createMcpToolProviders(
  options: CreateMcpToolProvidersOptions,
): Promise<ToolProvider[]> {
  const { mcp, waitForConnectionsTimeout = 10_000 } = options;

  await mcp.waitForConnections({ timeout: waitForConnectionsTimeout });

  const serverRows = mcp.listServers();
  const serverIds = new Set(serverRows.map((server) => server.id));
  const namespaceCounts = new Map<string, number>();
  const namespaces = new Map<string, string>();

  for (const serverId of serverIds) {
    const row = serverRows.find((s) => s.id === serverId);
    const label = row?.name != null && String(row.name).trim() !== "" ? String(row.name) : serverId;
    const baseNamespace = sanitizeToolName(label).toLowerCase();
    const count = (namespaceCounts.get(baseNamespace) ?? 0) + 1;
    namespaceCounts.set(baseNamespace, count);
    namespaces.set(serverId, count === 1 ? baseNamespace : `${baseNamespace}_${count}`);
  }

  const toolsByServer = new Map<string, McpToolDefinition[]>();
  for (const tool of mcp.listTools()) {
    const tools = toolsByServer.get(tool.serverId) ?? [];
    tools.push(tool);
    toolsByServer.set(tool.serverId, tools);
  }

  return [...toolsByServer.entries()].map(([serverId, tools]) => {
    const row = serverRows.find((s) => s.id === serverId);
    const label = row?.name != null && String(row.name).trim() !== "" ? String(row.name) : serverId;
    const namespace = namespaces.get(serverId) ?? sanitizeToolName(label).toLowerCase();
    const descriptors: JsonSchemaToolDescriptors = {};
    const providerTools: ToolProvider["tools"] = {};
    const usedToolKeys = new Set<string>();

    for (const tool of tools) {
      const toolKey = uniqueSanitizedToolKey(tool.name, usedToolKeys);
      providerTools[toolKey] = {
        description: tool.description,
        execute: async (input: unknown) => {
          const result = await mcp.callTool({
            serverId,
            name: tool.name,
            arguments: toToolArguments(input),
          });
          return unwrapMcpResult(result);
        },
      };

      descriptors[toolKey] = {
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: "object" },
        outputSchema: tool.outputSchema,
      };
    }

    return {
      name: namespace,
      tools: providerTools,
      types: withNamespace(generateTypesFromJsonSchema(descriptors), namespace),
    };
  });
}

function toToolArguments(input: unknown) {
  if (input == null) {
    return {};
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("MCP tools expect an object input.");
  }

  return input as Record<string, unknown>;
}

function unwrapMcpResult(result: McpCallToolResult): unknown {
  if ("toolResult" in result) {
    return result.toolResult;
  }

  if (result.isError) {
    const message =
      (result.content ?? [])
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join("\n") || "Tool call failed";
    throw new Error(message);
  }

  if (result.structuredContent != null) {
    return result.structuredContent;
  }

  const allText =
    (result.content?.length ?? 0) > 0 &&
    (result.content ?? []).every((item) => item.type === "text");
  if (allText) {
    const text = (result.content ?? []).map((item) => item.text ?? "").join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return result;
}

function withNamespace(types: string, namespace: string) {
  return types.replace(/declare const codemode:/, `declare const ${namespace}:`);
}
