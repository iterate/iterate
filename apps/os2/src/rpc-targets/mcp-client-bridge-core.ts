import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface CachedMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export async function connectMcpClient(input: { serverUrl: string }) {
  const transport = new StreamableHTTPClientTransport(new URL(input.serverUrl));
  const client = new Client({ name: "os2-mcp-bridge", version: "1.0.0" });
  await client.connect(transport);
  const response = await client.listTools();

  return {
    client,
    tools: response.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
    })),
  };
}

export async function executeMcpToolFunction(input: {
  client: Client;
  path: string[];
  payload: unknown;
}) {
  const toolName = input.path[0];
  if (!toolName)
    throw new Error("executeToolFunction requires path with at least one segment (tool name)");

  const args =
    input.payload != null && typeof input.payload === "object" && !Array.isArray(input.payload)
      ? (input.payload as Record<string, unknown>)
      : {};

  const result = await input.client.callTool({ name: toolName, arguments: args });

  if (result.structuredContent != null) return result.structuredContent;

  if (result.isError) {
    const message =
      extractTextContent(result.content).join("\n") || "MCP tool function call failed";
    throw new Error(message);
  }

  const textParts = extractTextContent(result.content);
  if (textParts.length > 0) {
    const text = textParts.join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return result;
}

export function describeMcpToolFunctions(tools: CachedMcpTool[]) {
  if (tools.length === 0) {
    return { typeDefinitions: "/** No tool functions found on MCP server */" };
  }

  const lines = tools.map((tool) => {
    const desc = tool.description ?? tool.name;
    const safeName = tool.name.replace(/[^a-zA-Z0-9_$]/g, "_");
    return `  /** ${desc} */\n  ${safeName}(input: Record<string, unknown>): Promise<unknown>;`;
  });

  return { typeDefinitions: `{\n${lines.join("\n")}\n}` };
}

function extractTextContent(content: unknown) {
  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((item) => {
    if (
      item != null &&
      typeof item === "object" &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string"
    ) {
      return [item.text];
    }

    return [];
  });
}
