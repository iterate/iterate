/**
 * Outbound MCP From Our Client Capability — a Durable Object that connects from OS2 to a
 * remote MCP server and exposes that remote server as a codemode RPC provider.
 *
 * This is deliberately not the inbound Project MCP server. Inbound MCP is
 * `ProjectMcpServerEntrypoint` + `ProjectMcpServerConnection`, where an
 * external MCP client connects to us and may ask us to run codemode. This file
 * is the opposite direction: codemode calls out to someone else's MCP server.
 *
 * Unlike the stateless OpenApiBridge, this is a DO because MCP clients maintain
 * session state (initialize handshake, session ID, tool cache).
 *
 * The DO name encodes the server URL. On first call, it connects and caches
 * the tool list. Subsequent calls reuse the connection.
 *
 * Use createOutboundMcpFromOurClientToolProviderRegistration() to construct the
 * codemode provider registration. The provider keeps only short instructions in
 * the event log; detailed tool discovery is an ordinary function call via
 * `ctx.<namespace>.listTools()`.
 *
 * MCP streamable HTTP transport:
 * https://modelcontextprotocol.io/docs/concepts/transports#streamable-http
 */

import { DurableObject } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";
import {
  type CachedMcpTool,
  connectOutboundMcpFromOurClient,
  describeOutboundMcpFromOurClientTools,
  executeOutboundMcpFromOurClientToolFunction,
} from "./outbound-mcp-from-our-client-capability-core.ts";

/**
 * Each Durable Object instance bridges a single remote MCP server. The server
 * URL is encoded in the DO name (see
 * createOutboundMcpFromOurClientToolProviderRegistration) and stored in
 * transient state on first connect.
 */
export class OutboundMcpFromOurClientCapability extends DurableObject {
  #client: Client | null = null;
  #tools: CachedMcpTool[] | null = null;

  private async ensureConnected() {
    if (this.#client) return;

    // The DO name IS the server URL. That gives one warm MCP client/session
    // cache per remote server without adding another registry table.
    const serverUrl = this.ctx.id.name;
    if (!serverUrl)
      throw new Error(
        "OutboundMcpFromOurClientCapability DO must be created with a name (the MCP server URL)",
      );

    const connection = await connectOutboundMcpFromOurClient({ serverUrl });
    this.#client = connection.client;
    this.#tools = connection.tools;
  }

  /**
   * Execute a codemode function by translating the function path to an MCP tool
   * name. `listTools` is intentionally a normal function call, not a special
   * provider-description protocol, so MCP discovery works the same way from
   * inbound MCP sessions, browser-created codemode sessions, and future agents.
   */
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    await this.ensureConnected();

    if (input.functionPath.join(".") === "listTools") {
      return describeOutboundMcpFromOurClientTools(this.#tools ?? []);
    }

    return await executeOutboundMcpFromOurClientToolFunction({
      args: input.args,
      client: this.#client!,
      path: input.functionPath,
    });
  }
}

/**
 * Construct a codemode provider registration for a remote MCP server.
 *
 * The DO instance name is the server URL itself, so multiple providers
 * pointing at the same MCP server share a connection and tool cache.
 *
 *   createOutboundMcpFromOurClientToolProviderRegistration({
 *     path: ["linear"],
 *     serverUrl: "https://mcp.linear.app/mcp",
 *   })
 *
 * Requires an OUTBOUND_MCP_FROM_OUR_CLIENT_CAPABILITY DurableObjectNamespace binding on the worker
 * that dispatches this callable. This deliberately uses an env binding rather
 * than `ctx.exports` because CodemodeSession runs in its own Worker module, and
 * Cloudflare loopback exports only resolve top-level exports from that module:
 * https://developers.cloudflare.com/workers/runtime-apis/context/#exports
 */
export function createOutboundMcpFromOurClientToolProviderRegistration(options: {
  instructions?: string;
  path: string[];
  serverUrl: string;
}): ToolProviderRegistration {
  const via = {
    type: "env-binding" as const,
    bindingType: "durable-object-namespace" as const,
    bindingName: "OUTBOUND_MCP_FROM_OUR_CLIENT_CAPABILITY",
    durableObject: { name: options.serverUrl },
  };

  return {
    instructions:
      options.instructions ??
      `Remote MCP server at ${options.serverUrl}. Call listTools() on this namespace to inspect available MCP tools, then call the returned tool name as a codemode function path.`,
    invocation: {
      kind: "rpc",
      callable: {
        type: "workers-rpc" as const,
        via,
        rpcMethod: "executeCodemodeFunctionCall",
        argsMode: "object",
      },
    },
    path: options.path,
  };
}
