// library/mcp.ts — `itx.connectToMcp(url, { headers? })`: an MCP client over Streamable HTTP, written
// against `itx.fetch` alone. JSON-RPC 2.0 POSTs to the one endpoint: `initialize` →
// `notifications/initialized` → `tools/list` at connect, then `tools/call` per call. A server that
// answers `initialize` with an `Mcp-Session-Id` header gets it back on every later request and a
// DELETE on close. Responses may be plain JSON or a `text/event-stream` carrying the JSON-RPC
// response as one `data:` event; both are read here.
// Tool args are one object; a result's `structuredContent` wins, else its text, JSON-parsed when it
// parses. There is no MCP SDK: the whole client is the few requests below.

import { RpcTarget } from "capnweb";
import { z } from "zod";
import type { LibraryItx } from "../library.ts";
import { refuseUnlessOk, subclassWithMethods } from "./connection.ts";

/** Options for `connectToMcp`: extra headers sent with every request (auth). */
export type McpConnectOptions = { headers?: Record<string, string> };

// An external MCP server's responses are UNTRUSTED network data — parsed against these schemas at
// every boundary, never cast, so a server that answers off-spec heals into a clear error instead of
// handing a typed frontend a value of the wrong shape (a tool whose `name` is a number, say).

/** One tool as `tools/list` describes it. */
const MCPTool = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
});
type MCPTool = z.infer<typeof MCPTool>;
const MCPToolsList = z.object({ tools: z.array(MCPTool) });

/** What `initialize` answered: the server's name and version, its protocol version and capabilities. */
const MCPServerInfo = z.object({
  protocolVersion: z.string().optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  serverInfo: z.object({ name: z.string().optional(), version: z.string().optional() }).optional(),
});
type MCPServerInfo = z.infer<typeof MCPServerInfo>;

/** Connect: initialize, announce, list the tools, and hand back a connection whose prototype carries
 *  one method per tool (a tool named like one of the connection's own members — `callTool`, `close`,
 *  `then`… — is reachable through `callTool` only; connection.ts `subclassWithMethods`). */
export async function connectToMcp(
  itx: LibraryItx,
  url: string,
  options: McpConnectOptions = {},
): Promise<McpConnectionRpcTarget> {
  const client = new McpJsonRpcClient(itx, url, options.headers || {});
  const serverInfo = await client.initialize();
  try {
    const { tools } = MCPToolsList.parse(await client.request("tools/list", {}));
    const Connection = subclassWithMethods(
      McpConnectionRpcTarget,
      tools.map((tool) => tool.name),
      (self, name, args) => self.callTool(name, args as Record<string, unknown> | undefined),
    );
    return new Connection(client, serverInfo);
  } catch (error) {
    // Discovery failed AFTER the handshake went live — close the client so its session is DELETEd
    // rather than leaked (nothing else holds this half-built connection).
    await client.close();
    throw error;
  }
}

/** A connected MCP server. Held across calls it is an RpcTarget; disposed, it DELETEs its session. */
export class McpConnectionRpcTarget extends RpcTarget {
  readonly #jsonRpcClient: McpJsonRpcClient;
  readonly #serverInfo: MCPServerInfo;
  constructor(client: McpJsonRpcClient, serverInfo: MCPServerInfo) {
    super();
    this.#jsonRpcClient = client;
    this.#serverInfo = serverInfo;
  }
  /** The `initialize` answer. */
  serverInfo(): MCPServerInfo {
    return this.#serverInfo;
  }
  /** Ask the server again — `tools/list` now. */
  async listTools(): Promise<MCPTool[]> {
    return MCPToolsList.parse(await this.#jsonRpcClient.request("tools/list", {})).tools;
  }
  /** `tools/call`: the result's `structuredContent`, else its text content JSON-parsed when it
   *  parses, else the text; an `isError` result throws with that text. */
  async callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
    const result = MCPToolResult.parse(
      await this.#jsonRpcClient.request("tools/call", { name, arguments: args || {} }),
    );
    return mcpResultToValue(name, result);
  }
  async close(): Promise<void> {
    await this.#jsonRpcClient.close();
  }
  [Symbol.dispose](): void {
    void this.close();
  }
}

const MCPToolResult = z.object({
  // A loose content item: `type` and (for text) `text` are validated, but every OTHER field survives —
  // an image/audio/resource part keeps its `data`/`mimeType`/`resource` instead of being stripped.
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});
type MCPToolResult = z.infer<typeof MCPToolResult>;

function mcpResultToValue(name: string, result: MCPToolResult): unknown {
  const text = (result.content || [])
    // oxlint-disable-next-line iterate/simple-truthiness-check -- part.text is validated string|undefined; an empty-string text part is valid MCP content and must join in, so absence (undefined) must be distinguished
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

type JsonRpcResponse = { id?: unknown; result?: unknown; error?: { message?: string } };

/** The JSON-RPC half: one endpoint, an id counter, the session id the server may hand out. A client
 *  closed by a holder (the context's pins' release closes the library's memoized connections)
 *  re-runs the handshake on its next request, so a held or memoized connection is never a dead
 *  session. */
class McpJsonRpcClient {
  readonly #itx: LibraryItx;
  readonly #url: string;
  readonly #headers: Record<string, string>;
  #nextId = 1;
  #sessionId: string | null = null;
  #closed = false;
  /** The in-flight handshake, shared while it runs so concurrent requests await ONE — and never post
   *  before the session id is established. Cleared on failure so the next request retries it. */
  #handshake: Promise<MCPServerInfo> | null = null;
  /** Bumped by `close()`. A handshake captures it at the start and, on completing, refuses to revive a
   *  client closed meanwhile — it DELETEs the session it just established instead of leaking it. */
  #generation = 0;
  constructor(itx: LibraryItx, url: string, headers: Record<string, string>) {
    this.#itx = itx;
    this.#url = url;
    this.#headers = headers;
  }
  /** The handshake: `initialize` → `notifications/initialized`. Memoized while in flight — a second
   *  caller (a concurrent request re-opening a closed client) joins the same one instead of racing a
   *  second handshake or posting session-less mid-handshake. `#closed` stays true until it completes. */
  async initialize(): Promise<MCPServerInfo> {
    if (!this.#handshake) {
      const handshake = this.#runHandshake();
      this.#handshake = handshake;
      // Clear the memo when THIS handshake settles — but ONLY if it is still the current one, so a
      // handshake that lost a close race never clears its replacement's memo (which would let a third
      // handshake start and leave one session unowned).
      void handshake
        .catch(() => {})
        .finally(() => {
          if (this.#handshake === handshake) this.#handshake = null;
        });
    }
    return this.#handshake;
  }
  async #runHandshake(): Promise<MCPServerInfo> {
    const generation = this.#generation;
    // This handshake OWNS the session it establishes — it never reads or writes the shared #sessionId
    // until it commits, so a concurrent handshake (a re-open racing a close) can neither clobber the
    // live session nor be clobbered by ours.
    const initialized = await this.#send("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "iterate-context", version: "1" },
    });
    const sessionId = initialized.sessionId; // OUR session id, from the initialize response
    try {
      const serverInfo = MCPServerInfo.parse(initialized.result);
      await this.notify("notifications/initialized", undefined, sessionId);
      // close() (or another close) ran while this handshake was in flight: do NOT revive the client.
      if (generation !== this.#generation)
        throw new Error("MCP client was closed during its handshake");
      this.#sessionId = sessionId; // publish OUR session as the live one …
      this.#closed = false; // … and only now — session id set, initialized sent — is it usable
      return serverInfo;
    } catch (error) {
      // ANY failure once the session was allocated — a bad initialize result, a failed `initialized`
      // notify, or the close race — DELETEs OUR OWN session so the server never keeps it orphaned.
      // (Never the shared #sessionId, which a newer handshake may now own.)
      // oxlint-disable-next-line iterate/simple-truthiness-check -- `null` is the deliberate "no session established" sentinel; a server-assigned id is echoed/DELETEd verbatim, so an (off-spec) empty id must not be folded into "no session"
      if (sessionId !== null) await this.#deleteSession(sessionId);
      throw error;
    }
  }
  async request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) await this.initialize();
    return (await this.#send(method, params, this.#sessionId)).result;
  }
  /** Post one JSON-RPC request against `sessionId` (default: the live #sessionId) and return its
   *  result AND the session id now in effect. The handshake guard is `request`'s, so `#runHandshake`
   *  uses this directly (the guard would deadlock on its own in-flight handshake). */
  async #send(
    method: string,
    params: unknown,
    sessionId: string | null = this.#sessionId,
  ): Promise<{ result: unknown; sessionId: string | null }> {
    const id = this.#nextId++;
    const posted = await this.#post({ jsonrpc: "2.0", id, method, params }, sessionId);
    const message = await readJsonRpcResponse(posted.response, id);
    if (message.error)
      throw new Error(`MCP ${method}: ${message.error.message || JSON.stringify(message.error)}`);
    return { result: message.result, sessionId: posted.sessionId };
  }
  async notify(method: string, params: unknown, sessionId: string | null): Promise<void> {
    const { response } = await this.#post({ jsonrpc: "2.0", method, params }, sessionId);
    await response.body?.cancel();
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#handshake = null; // a re-open must run a fresh handshake, not reuse this session's
    this.#generation += 1; // invalidate a handshake in flight — it must not revive this client
    const sessionId = this.#sessionId;
    this.#sessionId = null;
    // oxlint-disable-next-line iterate/simple-truthiness-check -- `null` is the deliberate "no session" sentinel; an (off-spec) empty session id must still be DELETEd, not treated as "nothing to delete"
    if (sessionId !== null) await this.#deleteSession(sessionId);
  }
  /** DELETE one server session (best-effort) — close()'s own, and the one a handshake that lost the
   *  close race established. */
  async #deleteSession(sessionId: string): Promise<void> {
    const headers = new Headers(this.#headers);
    headers.set("mcp-session-id", sessionId);
    await this.#itx
      .fetch(new Request(this.#url, { method: "DELETE", headers }))
      .then((r) => r.body?.cancel())
      .catch(() => undefined);
  }
  /** Send `sessionId` (when set) and return the response plus the session id now in effect — the
   *  server's freshly-assigned one (initialize) or the one we sent. Does NOT touch #sessionId: the
   *  caller owns it, so a handshake that loses the close race never clobbers the live session. */
  async #post(
    body: { jsonrpc: "2.0"; id?: number; method: string; params?: unknown },
    sessionId: string | null,
  ): Promise<{ response: Response; sessionId: string | null }> {
    const headers = new Headers(this.#headers);
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json, text/event-stream");
    // oxlint-disable-next-line iterate/simple-truthiness-check -- `null` is the deliberate "no session" sentinel; whether the mcp-session-id header is sent (even with an off-spec empty value) is a wire-level distinction, not a default
    if (sessionId !== null) headers.set("mcp-session-id", sessionId);
    const response = await this.#itx.fetch(
      new Request(this.#url, { method: "POST", headers, body: JSON.stringify(body) }),
    );
    const nextSessionId = response.headers.get("mcp-session-id") ?? sessionId;
    return {
      response: await refuseUnlessOk(response, `MCP ${body.method}`),
      sessionId: nextSessionId,
    };
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
