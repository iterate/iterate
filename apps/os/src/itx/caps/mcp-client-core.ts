// Pure MCP streamable-HTTP client helpers — connect, list, call. MCP is a
// stateless protocol (fetch with metadata): every helper here works on a
// per-invocation client; there is no session state worth keeping anywhere.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type McpFetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

export async function connectMcp(input: {
  /** All transport HTTP goes through this (e.g. the project egress pipe). */
  fetch?: McpFetch;
  headers?: Record<string, string>;
  serverUrl: string;
}): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(input.serverUrl), {
    ...(input.fetch ? { fetch: input.fetch } : {}),
    requestInit: input.headers ? { headers: input.headers } : undefined,
  });
  const client = new Client({ name: "itx-mcp-client", version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    // A partial handshake can leave server-side session state dangling.
    await client.close().catch(() => {});
    throw error;
  }
  return client;
}

export async function listMcpTools(client: Client) {
  const response = await client.listTools();
  return {
    tools: response.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
    })),
  };
}

export async function executeMcpToolCall(input: {
  args: unknown[];
  client: Client;
  path: string[];
}) {
  const toolName = input.path[0];
  if (!toolName) {
    throw new Error("MCP tool calls need a path with at least one segment (the tool name).");
  }

  const [firstArg] = input.args;
  const args =
    firstArg != null && typeof firstArg === "object" && !Array.isArray(firstArg)
      ? (firstArg as Record<string, unknown>)
      : {};

  const result = await input.client.callTool({ name: toolName, arguments: args });

  if (result.structuredContent != null) return result.structuredContent;

  if (result.isError) {
    const message = extractTextContent(result.content).join("\n") || "MCP tool call failed";
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
