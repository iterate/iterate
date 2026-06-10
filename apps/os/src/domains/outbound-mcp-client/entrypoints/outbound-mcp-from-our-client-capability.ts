/**
 * Outbound MCP From Our Client Capability — a Durable Object that connects from OS to a
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
 * The DO name encodes the server URL and plain request headers. On first call,
 * it connects and caches the tool list. Subsequent calls reuse the connection.
 *
 * Provider registrations are constructed in a browser-safe utility next to
 * this entrypoint. The provider keeps only short instructions in the event log;
 * detailed tool discovery is an ordinary function call via
 * `ctx.<namespace>.listTools()`.
 *
 * MCP streamable HTTP transport:
 * https://modelcontextprotocol.io/docs/concepts/transports#streamable-http
 */

import { DurableObject } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  type CachedMcpTool,
  connectOutboundMcpFromOurClient,
  describeOutboundMcpFromOurClientTools,
  executeOutboundMcpFromOurClientToolFunction,
} from "../utils/outbound-mcp-from-our-client-capability-core.ts";
import type { ExecuteCodemodeFunctionCallInput } from "~/domains/codemode/stream-processors/codemode/implementation.ts";

/**
 * Each Durable Object instance bridges a single remote MCP server. The server
 * URL is encoded in the DO name and stored in transient state on first connect.
 */
export class OutboundMcpFromOurClientCapability extends DurableObject {
  #client: Client | null = null;
  #tools: CachedMcpTool[] | null = null;

  private async ensureConnected() {
    if (this.#client) return;

    const config = parseOutboundMcpDurableObjectName(this.ctx.id.name);
    if (!config.serverUrl)
      throw new Error(
        "OutboundMcpFromOurClientCapability DO must be created with a name (the MCP server URL)",
      );

    const connection = await connectOutboundMcpFromOurClient(config);
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

function parseOutboundMcpDurableObjectName(name: string | undefined): {
  headers?: Record<string, string>;
  serverUrl: string;
} {
  if (!name) return { serverUrl: "" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(name) as unknown;
  } catch {
    return { serverUrl: name };
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "serverUrl" in parsed) {
    const value = parsed as { headers?: unknown; serverUrl?: unknown };
    return {
      serverUrl: typeof value.serverUrl === "string" ? value.serverUrl : "",
      headers: parseHeaderRecord(value.headers),
    };
  }

  return { serverUrl: name };
}

function parseHeaderRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
