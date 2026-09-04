// library/mcp.ts — `itx.connectToMcp(url, { headers? })`: an MCP client over Streamable HTTP, written
// against `itx.fetch` alone (the library rule, index.ts). JSON-RPC 2.0 POSTs to the one endpoint:
// `initialize` → `notifications/initialized` → `tools/list` at connect, then `tools/call` per call. A
// server that answers `initialize` with an `Mcp-Session-Id` header gets it back on every later request
// and a DELETE on close. Responses may be plain JSON or a `text/event-stream` carrying the JSON-RPC
// response as one `data:` event; both are read here. The shape mirrors apps/os's mcp-client.ts
// (tool args = one object; a result's `structuredContent` wins, else its text, JSON-parsed when it
// parses) without the MCP SDK: the whole client is the few requests below.

import { RpcTarget } from "capnweb";
import type { LibraryItx } from "./index.ts";

/** Options for `connectToMcp`: extra headers sent with every request (auth). */
export type McpConnectOptions = { headers?: Record<string, string> };

/** One tool as `tools/list` describes it. */
export type McpTool = { name: string; description?: string; inputSchema?: unknown };

/** What `initialize` answered: the server's name and version, its protocol version and capabilities. */
export type McpServerInfo = {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string };
};

const MCP_PROTOCOL_VERSION = "2025-03-26";
const CLIENT_INFO = { name: "iterate-context", version: "1" };

/** Connect: initialize, announce, list the tools, and hand back a connection whose prototype carries
 *  one method per tool (a tool named like a reserved member — `callTool`, `close`… — is reachable
 *  through `callTool` only). */
export async function connectToMcp(
  itx: LibraryItx,
  url: string,
  options: McpConnectOptions = {},
): Promise<McpConnection> {
  const client = new McpJsonRpcClient(itx, url, options.headers ?? {});
  const serverInfo = await client.initialize();
  const { tools } = (await client.request("tools/list", {})) as { tools: McpTool[] };
  const Connection = withToolMethods(tools);
  return new Connection(client, tools, serverInfo);
}

/** A connected MCP server. Held across calls it is an RpcTarget; disposed, it DELETEs its session. */
export class McpConnection extends RpcTarget {
  readonly #client: McpJsonRpcClient;
  readonly #tools: McpTool[];
  readonly #serverInfo: McpServerInfo;
  constructor(client: McpJsonRpcClient, tools: McpTool[], serverInfo: McpServerInfo) {
    super();
    this.#client = client;
    this.#tools = tools;
    this.#serverInfo = serverInfo;
  }
  /** The `initialize` answer. */
  serverInfo(): McpServerInfo {
    return this.#serverInfo;
  }
  /** The tools as listed at connect (the methods this connection grew). */
  tools(): McpTool[] {
    return this.#tools;
  }
  /** Ask the server again — `tools/list` now. */
  async listTools(): Promise<McpTool[]> {
    const { tools } = (await this.#client.request("tools/list", {})) as { tools: McpTool[] };
    return tools;
  }
  /** `tools/call`: the result's `structuredContent`, else its text content JSON-parsed when it
   *  parses, else the text; an `isError` result throws with that text. */
  async callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
    const result = (await this.#client.request("tools/call", {
      name,
      arguments: args ?? {},
    })) as McpToolResult;
    return mcpResultToValue(name, result);
  }
  async close(): Promise<void> {
    await this.#client.close();
  }
  [Symbol.dispose](): void {
    void this.close();
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

// `then` is reserved so a tool so named can never make the connection THENABLE: an async function
// returning it, or any await of it, would adopt it as a promise, call the tool, and never settle.
const RESERVED_MEMBERS = new Set([
  "constructor",
  "then",
  "serverInfo",
  "tools",
  "listTools",
  "callTool",
  "close",
]);

/** A per-connection subclass whose PROTOTYPE carries one method per tool — prototype methods are what
 *  Workers RPC and capnweb traverse, so `conn.echo({ text })` works held across calls, not only inside
 *  one dotted expression. */
function withToolMethods(tools: McpTool[]): typeof McpConnection {
  const Connection = class extends McpConnection {};
  for (const tool of tools) {
    if (RESERVED_MEMBERS.has(tool.name) || !/^[A-Za-z_$][\w$]*$/.test(tool.name)) continue;
    Object.defineProperty(Connection.prototype, tool.name, {
      value(this: McpConnection, args?: Record<string, unknown>) {
        return this.callTool(tool.name, args);
      },
      writable: true,
      configurable: true,
    });
  }
  return Connection;
}

type JsonRpcResponse = { id?: unknown; result?: unknown; error?: { message?: string } };

/** The JSON-RPC half: one endpoint, an id counter, the session id the server may hand out. A client
 *  closed by a holder (the context's idle quiesce releases the library's memoized connections,
 *  index.ts) re-runs the handshake on its next request, so a held or memoized connection is never
 *  a dead session. */
class McpJsonRpcClient {
  readonly #itx: LibraryItx;
  readonly #url: string;
  readonly #headers: Record<string, string>;
  #nextId = 1;
  #sessionId: string | null = null;
  #closed = false;
  constructor(itx: LibraryItx, url: string, headers: Record<string, string>) {
    this.#itx = itx;
    this.#url = url;
    this.#headers = headers;
  }
  /** The handshake: `initialize` → `notifications/initialized`. */
  async initialize(): Promise<McpServerInfo> {
    this.#closed = false;
    const serverInfo = (await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })) as McpServerInfo;
    await this.notify("notifications/initialized");
    return serverInfo;
  }
  async request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) await this.initialize();
    const id = this.#nextId++;
    const response = await this.#post({ jsonrpc: "2.0", id, method, params });
    const message = await readJsonRpcResponse(response, id);
    if (message.error)
      throw new Error(`MCP ${method}: ${message.error.message ?? JSON.stringify(message.error)}`);
    return message.result;
  }
  async notify(method: string, params?: unknown): Promise<void> {
    const response = await this.#post({ jsonrpc: "2.0", method, params });
    await response.body?.cancel();
  }
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#sessionId === null) return;
    const headers = new Headers(this.#headers);
    headers.set("mcp-session-id", this.#sessionId);
    this.#sessionId = null;
    await this.#itx
      .fetch(new Request(this.#url, { method: "DELETE", headers }))
      .then((r) => r.body?.cancel())
      .catch(() => undefined);
  }
  async #post(body: { jsonrpc: "2.0"; id?: number; method: string; params?: unknown }) {
    const headers = new Headers(this.#headers);
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json, text/event-stream");
    if (this.#sessionId !== null) headers.set("mcp-session-id", this.#sessionId);
    const response = await this.#itx.fetch(
      new Request(this.#url, { method: "POST", headers, body: JSON.stringify(body) }),
    );
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.#sessionId = sessionId;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `MCP ${body.method}: ${response.status}${text ? ` ${text.slice(0, 300)}` : ""}`,
      );
    }
    return response;
  }
}

/** The JSON-RPC response with `id` — from a JSON body (one message or a batch array) or from a
 *  `text/event-stream` body, read AS IT ARRIVES and left the moment the event carrying that id is
 *  in (the stream is cancelled then): a server may keep the POST's stream open for later traffic
 *  (the spec says it SHOULD close it, not MUST), and waiting for its end would wait forever. */
async function readJsonRpcResponse(response: Response, id: number): Promise<JsonRpcResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  const messagesOf = (data: string): JsonRpcResponse[] => {
    const parsed = JSON.parse(data) as JsonRpcResponse | JsonRpcResponse[];
    return Array.isArray(parsed) ? parsed : [parsed];
  };
  if (!contentType.includes("text/event-stream")) {
    const message = messagesOf(await response.text()).find((m) => m.id === id);
    if (!message) throw new Error(`MCP: no JSON-RPC response with id ${id} (${contentType})`);
    return message;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`MCP: no JSON-RPC response with id ${id} (empty event stream)`);
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffered += done ? "" : decoder.decode(value, { stream: true });
    // every complete event is a block ending in a blank line; the tail may be a partial one
    const blocks = buffered.split(/\r?\n\r?\n/);
    buffered = done ? "" : (blocks.pop() ?? "");
    for (const block of blocks) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data === "") continue;
      const message = messagesOf(data).find((m) => m.id === id);
      if (message) {
        await reader.cancel().catch(() => undefined);
        return message;
      }
    }
    if (done) throw new Error(`MCP: no JSON-RPC response with id ${id} (text/event-stream ended)`);
  }
}
