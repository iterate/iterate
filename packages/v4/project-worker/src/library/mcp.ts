// library/mcp.ts — a thin public shape over the official MCP Streamable HTTP client. Network
// access stays on `itx.fetch`, so ordinary rewrites, egress policy, and auditing still apply.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RpcTarget } from "capnweb";
import { reportIssue } from "../lib/errors.ts";
import { responseTextPrefix, subclassWithMethods, type LibraryItx } from "./index.ts";

export type McpConnectOptions = { headers?: Record<string, string> };
export type McpTool = { name: string; description?: string; inputSchema?: unknown };
export type McpServerInfo = {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string };
};
const CLIENT_INFO = { name: "iterate-context", version: "1" };

export async function connectToMcp(
  itx: LibraryItx,
  url: string,
  options: McpConnectOptions = {},
): Promise<McpConnection> {
  const connected = await connect(itx, url, options.headers ?? {});
  const Connection = subclassWithMethods(
    McpConnection,
    connected.tools.map((tool) => tool.name),
    (self, name, args) => self.callTool(name, args as Record<string, unknown> | undefined),
  );
  return new Connection(itx, url, options.headers ?? {}, connected);
}

type Connected = {
  client: Client;
  transport: StreamableHTTPClientTransport;
  tools: McpTool[];
  serverInfo: McpServerInfo;
  failure: { error: Error | undefined };
};

/** A held connection reconnects lazily after close, matching the library memoization contract. */
export class McpConnection extends RpcTarget {
  #connected: Connected | undefined;
  #closed = false;
  readonly #itx: LibraryItx;
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #tools: McpTool[];
  readonly #serverInfo: McpServerInfo;
  constructor(itx: LibraryItx, url: string, headers: Record<string, string>, connected: Connected) {
    super();
    this.#itx = itx;
    this.#url = url;
    this.#headers = headers;
    this.#connected = connected;
    this.#tools = connected.tools;
    this.#serverInfo = connected.serverInfo;
  }
  serverInfo(): McpServerInfo {
    return this.#serverInfo;
  }
  tools(): McpTool[] {
    return this.#tools;
  }
  async listTools(): Promise<McpTool[]> {
    try {
      return (await (await this.#clientFor()).listTools()).tools;
    } catch (error) {
      throw mcpError("tools/list", error);
    }
  }
  async callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
    try {
      return mcpResultToValue(
        name,
        (await (
          await this.#clientFor()
        ).callTool({ name, arguments: args ?? {} })) as unknown as McpToolResult,
      );
    } catch (error) {
      throw mcpError("tools/call", error);
    }
  }
  async close(): Promise<void> {
    const connected = this.#connected;
    if (!connected) return;
    this.#closed = true;
    this.#connected = undefined;
    try {
      // The SDK already classifies a 405 as the expected "server does not terminate sessions"
      // response. Every other termination failure remains the caller's failure.
      await connected.transport.terminateSession();
    } finally {
      await connected.client.close();
    }
  }
  [Symbol.dispose](): void {
    void this.close().catch((error) => reportIssue("library.mcp.dispose", error));
  }
  async #clientFor(): Promise<Client> {
    const connected = this.#connected;
    if (connected?.failure.error) {
      // Streamable HTTP reports failed background SSE/reconnect work through onerror. The public
      // connection's contract is lazy reopening, so retain that error until a public use tears
      // down the broken SDK client and makes one fresh connection; never leave it as an unobserved
      // callback while continuing to use its transport.
      this.#connected = undefined;
      try {
        await connected.client.close();
      } catch (cleanupError) {
        throw new Error(
          `MCP transport: ${connected.failure.error.message}; cleanup: ${String(cleanupError)}`,
        );
      }
      throw new Error(`MCP transport: ${connected.failure.error.message}`);
    }
    if (this.#closed || !this.#connected) {
      this.#connected = await connect(this.#itx, this.#url, this.#headers);
      this.#closed = false;
    }
    return this.#connected.client;
  }
}

async function connect(
  itx: LibraryItx,
  url: string,
  headers: Record<string, string>,
): Promise<Connected> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
    fetch: async (input, init) => {
      const request = new Request(String(input), init);
      const response = await itx.fetch(request);
      // Capnweb preserves an Error message more reliably than an SDK error's status property.
      // Keep the status/body available to the public error coercion without parsing MCP ourselves.
      // Streamable HTTP explicitly permits a 405 on its optional GET SSE probe.
      if (!response.ok && !(request.method === "GET" && response.status === 405))
        throw new Error(`MCP HTTP ${response.status}: ${await responseTextPrefix(response)}`);
      return response;
    },
  });
  const client = new Client(CLIENT_INFO);
  const failure: Connected["failure"] = { error: undefined };
  // `Client.connect()` takes ownership of transport.onerror and forwards it here. Record the first
  // asynchronous transport failure so the next public use cannot silently continue on that client.
  client.onerror = (error) => {
    failure.error ??= error instanceof Error ? error : new Error(String(error));
  };
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return {
      client,
      transport,
      tools,
      serverInfo: {
        protocolVersion: transport.protocolVersion,
        capabilities: client.getServerCapabilities() as Record<string, unknown> | undefined,
        serverInfo: client.getServerVersion(),
      },
      failure,
    };
  } catch (error) {
    await client.close();
    throw mcpError("initialize", error);
  }
}

type McpToolResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};
function mcpResultToValue(name: string, result: McpToolResult): unknown {
  const text = (result.content ?? [])
    .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n");
  if (result.isError) throw new Error(`MCP tool ${name} failed: ${text || "no message"}`);
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (text === "") return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function mcpError(method: string, error: unknown): Error {
  if (!(error instanceof Error)) return new Error(`MCP ${method}: ${String(error)}`);
  if (error.message.startsWith("MCP tool ")) return error;
  const body = /Error POSTing to endpoint: (.*)$/.exec(error.message);
  const directHttp = /MCP HTTP (\d+): (.*)$/.exec(error.message);
  const rpc = /^MCP error -?\d+: (.*)$/.exec(error.message);
  const code = "code" in error && typeof error.code === "number" ? error.code : undefined;
  if (body && code !== undefined) return new Error(`MCP ${method} returned ${code}: ${body[1]}`);
  if (directHttp) return new Error(`MCP ${method} returned ${directHttp[1]}: ${directHttp[2]}`);
  return rpc ? new Error(`MCP ${method}: ${rpc[1]}`) : error;
}
