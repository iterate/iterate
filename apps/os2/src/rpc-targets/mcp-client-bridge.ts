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
import type { ToolProviderDescriptor } from "@iterate-com/shared/codemode/types";
import {
  type CachedMcpTool,
  connectMcpClient,
  describeMcpToolFunctions,
  executeMcpToolFunction,
} from "./mcp-client-bridge-core.ts";

/**
 * Each DO instance bridges a single remote MCP server. The server URL is
 * encoded in the DO name (see createMcpClientProvider) and stored in
 * transient state on first connect.
 */
export class McpClientBridge extends DurableObject {
  #client: Client | null = null;
  #tools: CachedMcpTool[] | null = null;

  private async ensureConnected() {
    if (this.#client) return;

    // The DO name IS the server URL (set by createMcpClientProvider)
    const serverUrl = this.ctx.id.name;
    if (!serverUrl)
      throw new Error("McpClientBridge DO must be created with a name (the MCP server URL)");

    const connection = await connectMcpClient({ serverUrl });
    this.#client = connection.client;
    this.#tools = connection.tools;
  }

  /**
   * Execute a tool function on the remote MCP server.
   *
   * Called via Workers RPC from a callable with payload { path: string[], payload: unknown }.
   */
  async executeToolFunction(input: { path: string[]; payload: unknown }) {
    await this.ensureConnected();

    return await executeMcpToolFunction({
      client: this.#client!,
      path: input.path,
      payload: input.payload,
    });
  }

  /**
   * Describe available tool functions as TypeScript declarations.
   *
   * Called via Workers RPC from a callable with payload {}.
   */
  async describeToolFunctions() {
    await this.ensureConnected();
    return describeMcpToolFunctions(this.#tools ?? []);
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
