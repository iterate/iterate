/**
 * MCP client bridge — a Durable Object that connects to a remote MCP server
 * and exposes its tools through our ToolProvider interface.
 *
 * Unlike the stateless OpenApiBridge, this is a DO because MCP clients maintain
 * session state (initialize handshake, session ID, tool cache).
 *
 * The DO name encodes the server URL. On first call, it connects and caches
 * the tool list. Subsequent calls reuse the connection.
 *
 * Use createMcpClientProvider() to construct the ToolProviderDescriptor.
 *
 * MCP streamable HTTP transport:
 * https://modelcontextprotocol.io/docs/concepts/transports#streamable-http
 */

import { DurableObject } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolProviderDescriptor } from "@iterate-com/shared/codemode/types";

interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Each DO instance bridges a single remote MCP server. The server URL is
 * encoded in the DO name (see createMcpClientProvider) and stored in
 * transient state on first connect.
 */
export class McpClientBridge extends DurableObject {
  #client: Client | null = null;
  #tools: CachedTool[] | null = null;

  private async ensureConnected() {
    if (this.#client) return;

    // The DO name IS the server URL (set by createMcpClientProvider)
    const serverUrl = this.ctx.id.name;
    if (!serverUrl)
      throw new Error("McpClientBridge DO must be created with a name (the MCP server URL)");

    const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
    const client = new Client({ name: "os2-mcp-bridge", version: "1.0.0" });
    await client.connect(transport);
    this.#client = client;

    const response = await client.listTools();
    this.#tools = response.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));
  }

  /**
   * Execute a tool function on the remote MCP server.
   *
   * Called via Workers RPC from a callable with payload { path: string[], payload: unknown }.
   */
  async executeToolFunction(input: { path: string[]; payload: unknown }) {
    await this.ensureConnected();

    const toolName = input.path[0];
    if (!toolName)
      throw new Error("executeToolFunction requires path with at least one segment (tool name)");

    const args =
      input.payload != null && typeof input.payload === "object" && !Array.isArray(input.payload)
        ? (input.payload as Record<string, unknown>)
        : {};

    const result = await this.#client!.callTool({ name: toolName, arguments: args });

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

  /**
   * Describe available tool functions as TypeScript declarations.
   *
   * Called via Workers RPC from a callable with payload {}.
   */
  async describeToolFunctions() {
    await this.ensureConnected();
    const tools = this.#tools ?? [];

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
}

/**
 * Construct a ToolProviderDescriptor that routes through the McpClientBridge DO.
 *
 * The DO instance name is the server URL itself, so multiple providers
 * pointing at the same MCP server share a connection and tool cache.
 *
 *   createMcpClientProvider({
 *     path: ["linear"],
 *     serverUrl: "https://mcp.linear.app/mcp",
 *   })
 *
 * Requires a MCP_CLIENT_BRIDGE DurableObjectNamespace binding on the worker.
 */
export function createMcpClientProvider(options: {
  path: string[];
  serverUrl: string;
}): ToolProviderDescriptor {
  const via = {
    type: "loopback-binding" as const,
    bindingType: "durable-object-namespace" as const,
    exportName: "MCP_CLIENT_BRIDGE",
    durableObject: { name: options.serverUrl },
  };

  return {
    path: options.path,
    executeToolFunction: { type: "workers-rpc" as const, via, rpcMethod: "executeToolFunction" },
    describeToolFunctions: {
      type: "workers-rpc" as const,
      via,
      rpcMethod: "describeToolFunctions",
    },
  };
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
