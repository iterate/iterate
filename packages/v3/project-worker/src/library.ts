// library.ts — THE LIBRARY: the built-ins that could be userspace, ONE file the boundary test reads
// whole. Five concepts:
//   the library — `buildLibrary` (the memoized roots) + the rule, and the two refusal helpers
//   capnweb     — `itx.connectToCapnweb(url)`: a remote capnweb API as a pipelinable handle
//   mcp         — `itx.connectToMcp(url)`: an MCP client over Streamable HTTP
//   mcp server  — `itx.serveMcp()`: THIS context as an MCP server, one tool (`itx.invoke`)
//   openapi     — `itx.connectToOpenApi(spec)`: an OpenAPI 3 service as an RpcTarget of operationIds

import {
  RpcSession,
  newWebSocketRpcSession,
  type RpcStub,
  type RpcTransport,
  RpcTarget,
} from "capnweb";
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type JsonSchemaType,
} from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import type { BuiltInScope } from "./context/built-ins.ts";
import {
  keySortedForPrint,
  InvokeHandle,
  walkStepsOnRpcStub,
  normalizedItxExpression,
  type ItxExpression,
  type ItxExpressionInput,
} from "./context/expression.ts";

// ── the library ── THE LIBRARY: the built-ins that could be userspace. context/built-ins.ts has TWO
// groups: ROOTS, implemented against ctx/env (the log, the stub registry, the rule table, the two
// hosts, the bindings), and THIS FILE — plain compiled-in first-party code whose ONLY dependency is
// `itx`, the same dotted handle a loaded worker gets from `env.ITX.get()`. That signature IS the
// layering (the owner's litmus test: "could this be written in a userspace worker?"): a library module
// takes `itx` and nothing else, so it could move to a userspace worker unchanged (the capnweb connector once
// the SDK exports `InvokeHandle`); the surface shows no level — `itx.connectToMcp(url)` reads like
// `itx.ai.run(...)` — the file and the signature do. library.test.ts pins the rule (no runtime import
// from the stream, the DO or the context folder, except context/expression.ts — the codec and the
// pipelinable handle).
//
// The verbs: `connectToMcp` · `connectToOpenApi` · `connectToCapnweb` · `serveMcp`. The three
// connectors each return a connection RpcTarget a caller can hold across calls, and each does ALL
// its HTTP through `itx.fetch` (egress: `{{secret:project:NAME}}` placeholders in headers substitute
// for free; a user rule shadowing `itx.fetch` redirects the library too, which is how a test fakes a
// remote). `serveMcp` is the other direction — THIS context as an MCP server (the mcp server section): a
// handle whose one member is `fetch(request)`, mounted as an app (`provide("itx.apps.mcp",
// "itx.serveMcp()")`) and reached through `itx.cd('.')`, the dotted surface's expression-as-data
// door. `connectToGraphql` is the obvious next member of the family and does not exist yet.
//
// LIVE CONNECTIONS ARE MEMOIZED per context: a connector reached THROUGH a rewrite rule
// (`provide('itx.tools', "itx.connectToMcp(url)")`, the documented composition) is a connect per
// call as an expression — a fresh MCP session, an open WebSocket, that no intermediate holder ever
// disposes. So `buildLibrary` keeps every connection it opened, by (verb, url, options), hands the
// same one back while it lives, and `releaseConnections()` closes them all — the context's idle
// quiesce calls it beside returning its borrowed stubs, since a held connection pins the context
// awake exactly like a borrowed stub. A connection closed by a holder or broken by the far side
// reopens itself on its next use (the mcp and capnweb sections), so a memoized one is never dead.

/** What a library module is handed: the itx handle (the record's own dotted surface), narrowed to
 *  what the library uses today — `fetch` (the connectors' HTTP) and `cd` (`serveMcp`'s evaluation
 *  door: `cd('.')` is this context, and its handle's `invoke(steps)` takes an expression as data).
 *  Widen it HERE when a module needs more of itx — never by importing something else. */
export type LibraryItx = Pick<BuiltInScope, "fetch" | "cd">;

/** The library's roots, exactly as the built-ins record spreads them in: each verb closed over ONE
 *  `itx`. `BuiltInScope` (context/built-ins.ts) extends this, so the typed surface has them once. */
export interface LibraryRoots {
  /** An MCP server over Streamable HTTP: `callTool(name, args)`, `listTools()`, and one method per
   *  tool whose name is a legal identifier. */
  connectToMcp(url: string, options?: McpConnectOptions): Promise<McpConnection>;
  /** An OpenAPI 3 service from its document or the URL of one: one method per `operationId`, taking
   *  one input object (path, query, header and body fields together); `call(operationId, input)` too. */
  connectToOpenApi(
    specOrUrl: string | OpenApiDocument,
    options?: OpenApiConnectOptions,
  ): Promise<OpenApiConnection>;
  /** A remote capnweb API's main object as a pipelinable handle — a WebSocket session through egress
   *  (default) or one HTTP batch per chain (`{ transport: "batch" }`); dotted calls chain with no round
   *  trip per step. */
  connectToCapnweb(url: string, options?: CapnwebConnectOptions): Promise<CapnwebConnection>;
  /** THIS context as an MCP server: a handle whose one member is `fetch(request)` — the Streamable
   *  HTTP endpoint with ONE tool, `itx.invoke({ expression, args? })`, evaluated as itx evaluates
   *  it, under the calling request's principal. Mount it: `provide("itx.apps.mcp", "itx.serveMcp()")`. */
  serveMcp(): McpServerHandle;
}

/** The library, built once per context: the verbs closed over one `itx`, memoizing the live
 *  connections the connectors open, and the one release door. Nothing is constructed here: a wake
 *  pays nothing for the library until a verb runs. */
export function buildLibrary(itx: LibraryItx): {
  roots: LibraryRoots;
  /** Close every connection the library holds (the idle quiesce's call); the next use reopens. */
  releaseConnections(): void;
} {
  const liveConnections = new Map<string, Promise<unknown>>();
  const memoized = <T>(key: unknown[], open: () => Promise<T>): Promise<T> => {
    const memoKey = JSON.stringify(key, keySortedForPrint); // keys sorted: two spellings, one key
    let connection = liveConnections.get(memoKey) as Promise<T> | undefined;
    if (!connection) {
      connection = open();
      liveConnections.set(memoKey, connection);
      // a connect that FAILS is not kept — the next call retries (the caller sees the rejection)
      connection.catch(() => liveConnections.delete(memoKey));
    }
    return connection;
  };
  return {
    roots: {
      connectToMcp: (url, options) =>
        memoized(["mcp", url, options], () => connectToMcp(itx, url, options)),
      connectToOpenApi: (specOrUrl, options) =>
        memoized(["openapi", specOrUrl, options], () => connectToOpenApi(itx, specOrUrl, options)),
      connectToCapnweb: (url, options) =>
        memoized(["capnweb", url, options], () => connectToCapnweb(itx, url, options)),
      // Not memoized: the handle holds no connection — a stateless server per request.
      serveMcp: () => new McpServerHandle(itx),
    },
    releaseConnections: () => {
      // `close()` where a connection has one (the graceful half-close), else its dispose; a release
      // that throws is REPORTED — a connection that will not close is a fact worth a log line.
      for (const [memoKey, connection] of liveConnections)
        void connection
          .then((c) => {
            const held = c as { close?: () => unknown; [Symbol.dispose]?: () => void };
            return held.close ? held.close() : held[Symbol.dispose]?.();
          })
          .catch((error: unknown) =>
            console.warn(`releaseConnections: ${memoKey} did not close: ${String(error)}`),
          );
      liveConnections.clear();
    },
  };
}

// ── what the three connectors share ──

/** A per-connection subclass whose PROTOTYPE carries one method per name — prototype members are what
 *  Workers RPC and capnweb traverse, so `conn.echo({ … })` works held across calls, not only inside
 *  one dotted expression. A name the base already declares (its own methods, `constructor`, whatever
 *  `RpcTarget` adds) stays reachable through the generic door only; so does a name that is not an
 *  identifier, and `then` — a thenable connection would be adopted as a promise by any await and
 *  never settle. */
export function subclassWithMethods<Base extends abstract new (...args: never[]) => object>(
  base: Base,
  names: string[],
  call: (self: InstanceType<Base>, name: string, input: unknown) => unknown,
): Base {
  const Subclass = class extends (base as abstract new (...args: never[]) => object) {};
  for (const name of names) {
    if (name === "then" || name in Subclass.prototype || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    Object.defineProperty(Subclass.prototype, name, {
      value(this: InstanceType<Base>, input?: unknown) {
        return call(this, name, input);
      },
      writable: true,
      configurable: true,
    });
  }
  return Subclass as unknown as Base;
}

/** The error for a response that refused: `<what> returned <status>: <the first 300 characters>`.
 *  The body is read only that far, then CANCELLED — a refusal's snippet must never buffer a whole
 *  error page (the v4 review's hygiene item). */
export async function responseRefusal(response: Response, what: string): Promise<Error> {
  const reader = response.body?.getReader();
  let snippet = "";
  if (reader) {
    const decoder = new TextDecoder();
    try {
      while (snippet.length < 300) {
        const { done, value } = await reader.read();
        if (done) break;
        snippet += decoder.decode(value, { stream: true });
      }
    } catch {
      /* a body that cannot be read adds nothing to the refusal */
    } finally {
      reader.cancel().catch(() => undefined);
    }
    snippet = snippet.slice(0, 300);
  }
  return new Error(`${what} returned ${response.status}${snippet ? `: ${snippet}` : ""}`);
}

/** The response, or the refusal thrown — ONE spelling for every non-2xx the connectors meet. */
export async function refuseUnlessOk(response: Response, what: string): Promise<Response> {
  if (response.ok) return response;
  throw await responseRefusal(response, what);
}

// ── capnweb ── `itx.connectToCapnweb(url, { headers?, transport? })`: a remote capnweb API's
// main object as a pipelinable handle, written against `itx.fetch` alone (the library rule, above).
// The WebSocket is opened THROUGH egress — `itx.fetch` with the Upgrade header, the 101's socket
// accepted and handed to capnweb — so `{{secret:project:NAME}}` headers substitute and the socket is
// the context's. `{ transport: "batch" }` is the one-shot alternative: capnweb's HTTP batch client
// uses the global fetch, so the same transport is re-spelled here over `itx.fetch` (RpcTransport is
// capnweb's own extension point for exactly that). A held connection pins this context awake for its
// life, like a busy facet; dispose it and the session closes. A batch connection holds no socket:
// each chain is its own batch session, so it never pins anything.

/** The remote main object: unknown by construction — the caller's dotted calls are its contract. */
type RemoteMain = RpcStub<any>;

/** Options for `connectToCapnweb`: headers for the handshake (auth), and the transport — a WebSocket
 *  session (default) or one HTTP batch per call chain. */
export type CapnwebConnectOptions = {
  headers?: Record<string, string>;
  transport?: "websocket" | "batch";
};

/** Connect and hand back the remote main object as a handle. A WebSocket session is opened now and
 *  shared by every later call; the batch transport opens one capnweb batch session PER CHAIN (a
 *  batch is one POST and dies with it — capnweb's own contract), which is the one-shot shape. */
export async function connectToCapnweb(
  itx: LibraryItx,
  url: string,
  options: CapnwebConnectOptions = {},
): Promise<CapnwebConnection> {
  const headers = options.headers ?? {};
  if (options.transport === "batch")
    return new CapnwebConnection(
      () => batchSessionOverEgress(itx, url, headers),
      () => undefined,
    );
  // The WebSocket session is opened NOW (a connect that cannot reach the far side fails here) and
  // REOPENED on the next call after it is gone — disposed (the context's idle quiesce releases every
  // library connection, index.ts) or broken by the far side — so a held or memoized connection is
  // never a dead socket.
  type SessionStub = RemoteMain & { onRpcBroken?: (cb: () => void) => void };
  let session: SessionStub | undefined;
  /** ONE reopen in flight at a time: concurrent calls after the session is gone share it (each
   *  opening its own would leak every socket but the last one assigned). */
  let reopening: Promise<SessionStub> | undefined;
  /** Bumped by close: a reopen that lands after a close disposes what it opened instead of reviving. */
  let generation = 0;
  const dispose = (stub: SessionStub | undefined) =>
    (stub as unknown as { [Symbol.dispose]?: () => void } | undefined)?.[Symbol.dispose]?.();
  const open = async (): Promise<SessionStub> => {
    const stub = (await webSocketSessionOverEgress(itx, url, headers)) as SessionStub;
    stub.onRpcBroken?.(() => {
      if (session === stub) session = undefined;
    });
    return stub;
  };
  const reopen = async (): Promise<SessionStub> => {
    const startedIn = generation;
    try {
      const opened = await open();
      if (startedIn !== generation) {
        dispose(opened);
        throw new Error("capnweb connection closed while it was reconnecting");
      }
      session = opened;
      return opened;
    } finally {
      reopening = undefined;
    }
  };
  session = await open();
  return new CapnwebConnection(
    () => session ?? (reopening ??= reopen()),
    () => {
      generation += 1;
      const gone = session;
      session = undefined;
      dispose(gone);
    },
  );
}

/** A remote capnweb API held across calls: an InvokeHandle, so `conn.a.b(x)` reduces into one dispatch
 *  that walks the capnweb stub step by step — capnweb pipelines property access and calls, so the
 *  chain is one round trip (one WebSocket exchange, or exactly one batch POST). Disposing closes the
 *  WebSocket session (the next call reopens it); a batch connection holds nothing. */
export class CapnwebConnection extends InvokeHandle {
  readonly #closeSession: () => void;
  /** `remoteMain` answers the stub SYNCHRONOUSLY while a session is open — the walk then queues the
   *  whole chain before any batch fires or any await yields — and a promise only while a session is
   *  being (re)opened. */
  constructor(remoteMain: () => RemoteMain | Promise<RemoteMain>, closeSession: () => void) {
    super((steps) => {
      const main = remoteMain();
      return main instanceof Promise
        ? main.then((stub) => walkStepsOnRpcStub(stub, steps))
        : walkStepsOnRpcStub(main, steps);
    });
    this.#closeSession = closeSession;
  }
  /** Close the WebSocket session (the next call reopens it); a batch connection holds nothing. A
   *  DECLARED member on purpose: the dotted fallback beneath `InvokeHandle` answers every unknown
   *  name with a REMOTE path, so a probe for `close` (`releaseConnections`, index.ts) must find this
   *  one — else it would call `close()` on the remote main and leave the local socket open. */
  close(): void {
    this.#closeSession();
  }
  [Symbol.dispose](): void {
    this.close();
  }
}

async function webSocketSessionOverEgress(
  itx: LibraryItx,
  url: string,
  headers: Record<string, string>,
): Promise<RemoteMain> {
  const httpUrl = url.replace(/^ws(s?):/i, "http$1:");
  const response = await itx.fetch(
    new Request(httpUrl, { headers: { ...headers, upgrade: "websocket" } }),
  );
  const webSocket = response.webSocket;
  if (response.status !== 101 || !webSocket)
    throw await responseRefusal(response, `connectToCapnweb: ${url} (no WebSocket)`);
  webSocket.accept();
  return newWebSocketRpcSession(webSocket as unknown as WebSocket);
}

function batchSessionOverEgress(
  itx: LibraryItx,
  url: string,
  headers: Record<string, string>,
): RemoteMain {
  const transport = new EgressBatchTransport(async (batch) => {
    const response = await itx.fetch(
      new Request(url, { method: "POST", headers, body: batch.join("\n") }),
    );
    await refuseUnlessOk(response, `connectToCapnweb: batch to ${url}`);
    const text = await response.text();
    return text === "" ? [] : text.split("\n");
  });
  return new RpcSession(transport).getRemoteMain();
}

/** capnweb's own HTTP batch client transport, over an injected send: every message sent before the
 *  microtask queue drains rides in ONE POST; the answers are received back in order. */
class EgressBatchTransport implements RpcTransport {
  #messagesToSend: string[] | null = [];
  #abortReason: unknown;
  /** The one POST's answers, in order — settled once the macrotask after construction has run. */
  readonly #answersReceived: Promise<string[]>;
  constructor(sendBatch: (batch: string[]) => Promise<string[]>) {
    this.#answersReceived = (async () => {
      // one macrotask, so every `.then()` on the pipelined promises registers before the batch goes
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.#abortReason !== undefined) throw this.#abortReason;
      const batch = this.#messagesToSend!;
      this.#messagesToSend = null;
      return sendBatch(batch);
    })();
  }
  async send(message: string): Promise<void> {
    if (this.#messagesToSend !== null) this.#messagesToSend.push(message);
  }
  async receive(): Promise<string> {
    const received = await this.#answersReceived;
    const message = received.shift();
    if (message === undefined) throw new Error("Batch RPC request ended.");
    return message;
  }
  abort(reason: unknown): void {
    this.#abortReason = reason;
  }
}

// ── mcp ── `itx.connectToMcp(url, { headers? })`: an MCP client over Streamable HTTP, written
// against `itx.fetch` alone (the library rule, above). JSON-RPC 2.0 POSTs to the one endpoint:
// `initialize` → `notifications/initialized` → `tools/list` at connect, then `tools/call` per call. A
// server that answers `initialize` with an `Mcp-Session-Id` header gets it back on every later request
// and a DELETE on close. Responses may be plain JSON or a `text/event-stream` carrying the JSON-RPC
// response as one `data:` event; both are read here. The shape mirrors apps/os's mcp-client.ts
// (tool args = one object; a result's `structuredContent` wins, else its text, JSON-parsed when it
// parses) without the MCP SDK: the whole client is the few requests below.

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
 *  one method per tool (a tool named like one of the connection's own members — `callTool`, `close`,
 *  `then`… — is reachable through `callTool` only; index.ts `subclassWithMethods`). */
export async function connectToMcp(
  itx: LibraryItx,
  url: string,
  options: McpConnectOptions = {},
): Promise<McpConnection> {
  const client = new McpJsonRpcClient(itx, url, options.headers ?? {});
  const serverInfo = await client.initialize();
  const { tools } = (await client.request("tools/list", {})) as { tools: McpTool[] };
  const Connection = subclassWithMethods(
    McpConnection,
    tools.map((tool) => tool.name),
    (self, name, args) => self.callTool(name, args as Record<string, unknown> | undefined),
  );
  return new Connection(client, serverInfo);
}

/** A connected MCP server. Held across calls it is an RpcTarget; disposed, it DELETEs its session. */
export class McpConnection extends RpcTarget {
  readonly #jsonRpcClient: McpJsonRpcClient;
  readonly #serverInfo: McpServerInfo;
  constructor(client: McpJsonRpcClient, serverInfo: McpServerInfo) {
    super();
    this.#jsonRpcClient = client;
    this.#serverInfo = serverInfo;
  }
  /** The `initialize` answer. */
  serverInfo(): McpServerInfo {
    return this.#serverInfo;
  }
  /** Ask the server again — `tools/list` now. */
  async listTools(): Promise<McpTool[]> {
    const { tools } = (await this.#jsonRpcClient.request("tools/list", {})) as { tools: McpTool[] };
    return tools;
  }
  /** `tools/call`: the result's `structuredContent`, else its text content JSON-parsed when it
   *  parses, else the text; an `isError` result throws with that text. */
  async callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
    const result = (await this.#jsonRpcClient.request("tools/call", {
      name,
      arguments: args ?? {},
    })) as McpToolResult;
    return mcpResultToValue(name, result);
  }
  async close(): Promise<void> {
    await this.#jsonRpcClient.close();
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
    return refuseUnlessOk(response, `MCP ${body.method}`);
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

// ── mcp server ── `itx.serveMcp()`: THIS context as an MCP server — the machine lane. A
// handle whose ONE member is `fetch(request)`, the MCP Streamable HTTP endpoint, with ONE tool,
// `itx.invoke({ expression, args? })`: the expression (a dotted string or the parsed form) is
// evaluated exactly as `itx` evaluates it — through this context's own rewrite rules — with `args`
// appended to its terminal call, and the result comes back as JSON. MCP is not a parallel capability
// API: a tool call reaches what an expression reaches, nothing more (v4's lesson).
//
// Mounted by userspace — `itx.provide("itx.apps.mcp", "itx.serveMcp()")` — and served by the
// project-host ingress at `mcp--<projectId>.<base>/` (worker.ts): the fetch lane runs the call under
// the request's principal (a project token as the host cookie or as `Authorization: Bearer`), so
// every event a `tools/call` appends carries `source.principal` with no plumbing of its own — the
// library runs in the context, where the principal is the current call's. A fresh, stateless server
// per request (`createMcpHandler`, the control plane's shape), and NO bearer is required: a request
// with none — or with another project's token — is served and stamps nothing (the ingress refuses
// no one; library-mcp-server.e2e.test.ts). The principal is attribution only: an unattributed call
// reaches everything the context can spell — every platform root, `itx.builtins.*` included, which
// no rule can mask — so a mount is the whole context to whoever can reach the host (in `email`
// login mode a hole the ingress does not close; pinned red in __workers-tests__/control-plane.test.ts,
// a design call: this library cannot see the login mode). Written against `itx` alone (the library
// rule, index.ts): `itx.cd('.')` is this context through its own table, and its handle's
// `invoke(steps)` is the one door on the dotted surface that takes an expression as DATA — the same
// door a loaded worker holds.

/** The tool's input: the expression in either codec half, and the args for its terminal call. */
type InvokeToolInput = { expression: ItxExpressionInput; args?: unknown[] };

const INVOKE_TOOL_INPUT = fromJsonSchema<InvokeToolInput>(
  {
    type: "object",
    properties: {
      expression: {
        description:
          'An itx expression: a dotted string such as itx.kv.get(\'k\') or itx.append({ type: \'note\' }) (call args are JSON5), or its parsed form ["itx","kv",["get","k"]] for anything large.',
        anyOf: [
          { type: "string", minLength: 1 },
          { type: "array", minItems: 1 },
        ],
      },
      args: {
        type: "array",
        description:
          "Appended to the expression's terminal call (a terminal name becomes that call) — an argument that is awkward to spell inline rides here as plain JSON.",
      },
    },
    required: ["expression"],
    additionalProperties: false,
  } as JsonSchemaType,
  new CfWorkerJsonSchemaValidator(),
);

/** What `itx.serveMcp()` returns: the endpoint. An RpcTarget like the connectors, so a holder may
 *  keep it across calls; its one member is `fetch(request)` — which is how the fetch lane calls it
 *  (`itx.apps.mcp ⇒ itx.serveMcp()` makes every request on the host `itx.serveMcp().fetch(req)`). */
export class McpServerHandle extends RpcTarget {
  readonly #handler: ReturnType<typeof createMcpHandler>;
  constructor(itx: LibraryItx) {
    super();
    // The default response mode (`auto`): one JSON body per request unless a notification precedes
    // the result, and the one tool emits none — so no SSE stream is ever held open on a context.
    // (Not `responseMode: "json"`: the SDK warns on every handler built that way, one per request.)
    this.#handler = createMcpHandler(() => buildInvokeServer(itx));
  }
  /** The MCP Streamable HTTP endpoint: POST JSON-RPC (`initialize`, `tools/list`, `tools/call`). */
  fetch(request: Request): Promise<Response> {
    return this.#handler.fetch(request);
  }
}

/** The server one request sees: one tool, `itx.invoke`. A tool FAILURE (an expression that does
 *  not resolve, a refused call, a value JSON cannot carry) is an `isError` result — the protocol's
 *  own channel — never a thrown error and never a 500. */
function buildInvokeServer(itx: LibraryItx): McpServer {
  const server = new McpServer({ name: "iterate-context", version: "1" });
  server.registerTool(
    "itx.invoke",
    {
      title: "Invoke itx",
      description:
        "Evaluate one itx expression in this context, exactly as itx evaluates it (through its rewrite rules): a dotted string such as itx.kv.get('k'), or its parsed form; args are appended to the terminal call. Returns the result as JSON.",
      inputSchema: INVOKE_TOOL_INPUT,
    },
    async ({ expression, args = [] }) => {
      try {
        const value = await evaluateAsItx(itx, expression, args);
        // THE JSON BOUNDARY: a round trip drops what JSON cannot carry (undefined members, a
        // function-valued handle's members) and throws on what it refuses (a cycle, a BigInt).
        const text = JSON.stringify(value) ?? "null";
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { result: JSON.parse(text) as unknown },
        };
      } catch (error) {
        // The failure text leads with the platform's CODE when the error carries one
        // (lib.ts — `NO_ITX_EXPRESSION_MATCH`, `RPC_STUB_OFFLINE`, …): the machine-readable
        // channel a client classifies by, then the message.
        const message = error instanceof Error ? error.message : String(error);
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code: unknown }).code)
            : undefined;
        return {
          content: [{ type: "text" as const, text: code ? `${code}: ${message}` : message }],
          isError: true,
        };
      }
    },
  );
  return server;
}

/** Evaluate `input` as itx does, `args` appended to its terminal call (a terminal NAME becomes
 *  that call — `itx.kv.get` + `["k"]` is `itx.kv.get("k")`). The string half is parsed, the array
 *  half shape-checked; either must be rooted at `itx`. `cd('.')` reaches this context's handle,
 *  whose `invoke` takes the steps after the root — on the dotted surface a `cd` is a dispatch, so
 *  it is awaited. */
async function evaluateAsItx(
  itx: LibraryItx,
  input: ItxExpressionInput,
  args: unknown[],
): Promise<unknown> {
  const expression = normalizedItxExpression(input);
  const [root, ...steps] = expression;
  if (root !== "itx")
    throw new Error(`an itx expression is rooted at itx, not ${JSON.stringify(root)}`);
  const last = steps.at(-1);
  const withArgs: ItxExpression =
    args.length === 0 || last === undefined
      ? steps
      : [...steps.slice(0, -1), typeof last === "string" ? [last, ...args] : [...last, ...args]];
  return (await itx.cd(".")).invoke(withArgs);
}

// ── openapi ── `itx.connectToOpenApi(specOrUrl, { baseUrl?, headers? })`: an OpenAPI 3
// service as an RpcTarget whose methods are its `operationId`s, written against `itx.fetch` alone
// (the library rule, above). Deliberately small, the apps/os shape (rpc-targets.ts
// `executeOperation`): one input OBJECT per call — path parameters substitute into the path, query
// parameters go on the URL, header parameters on the request, and what is left is the JSON body
// when the operation declares one (an input whose only key is `body` sends `input.body` verbatim, for
// a non-object body). A non-2xx answer throws with the status and the first 300 characters. The base
// URL keeps the spec URL's query when it falls back to it, so a service served over the fetch lane
// (`/expression/<path>?context=…&itx=…`) works like any other.

/** Options for `connectToOpenApi`: `baseUrl` overrides the document's first server; `headers` ride on
 *  every operation call (and on the spec fetch only when the spec shares the API's host). */
export type OpenApiConnectOptions = { baseUrl?: string; headers?: Record<string, string> };

/** An OpenAPI 3 document — only `openapi`, `servers` and `paths` are read. */
export type OpenApiDocument = {
  openapi: string;
  servers?: Array<{ url?: string }>;
  paths?: Record<string, Record<string, unknown>>;
};

/** One operation the connection grew a method for. */
export type OpenApiOperation = {
  operationId: string;
  method: string;
  path: string;
  parameters: Array<{ name: string; in: string; required?: boolean }>;
  hasRequestBody: boolean;
  summary?: string;
};

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

/** Connect: fetch the document when given a URL, index its operations, and hand back a connection
 *  whose prototype carries one method per `operationId`. */
export async function connectToOpenApi(
  itx: LibraryItx,
  specOrUrl: string | OpenApiDocument,
  options: OpenApiConnectOptions = {},
): Promise<OpenApiConnection> {
  const specUrl = typeof specOrUrl === "string" ? specOrUrl : undefined;
  const spec =
    typeof specOrUrl === "string" ? await fetchDocument(itx, specOrUrl, options) : specOrUrl;
  if (typeof spec?.openapi !== "string")
    throw new Error(`connectToOpenApi: ${specUrl ?? "the document"} is not an OpenAPI 3 document`);
  const operations = listOperations(spec);
  const Connection = subclassWithMethods(
    OpenApiConnection,
    operations.map((operation) => operation.operationId),
    (self, name, input) => self.call(name, input as Record<string, unknown> | undefined),
  );
  return new Connection(
    itx,
    operations,
    requestBase(spec, specUrl, options),
    options.headers ?? {},
  );
}

/** A connected OpenAPI service. `call(operationId, input)` is the generic door; the operations are
 *  its methods too. */
export class OpenApiConnection extends RpcTarget {
  readonly #itx: LibraryItx;
  readonly #operations: Map<string, OpenApiOperation>;
  readonly #requestBaseUrl: URL;
  readonly #headers: Record<string, string>;
  constructor(
    itx: LibraryItx,
    operations: OpenApiOperation[],
    base: URL,
    headers: Record<string, string>,
  ) {
    super();
    this.#itx = itx;
    this.#operations = new Map(operations.map((operation) => [operation.operationId, operation]));
    this.#requestBaseUrl = base;
    this.#headers = headers;
  }
  /** Every operation the document declares with an `operationId`. */
  operations(): OpenApiOperation[] {
    return [...this.#operations.values()];
  }
  /** Run one operation: the input object's fields become path, query and header parameters, the
   *  rest the JSON body; the answer is JSON when the response says so, else its text. */
  async call(operationId: string, input?: Record<string, unknown>): Promise<unknown> {
    const operation = this.#operations.get(operationId);
    if (!operation) throw new Error(`connectToOpenApi: no operation "${operationId}"`);
    const fields = { ...(input ?? {}) };
    let resolvedPath = operation.path;
    const url = new URL(this.#requestBaseUrl);
    const headers = new Headers(this.#headers);
    const cookieParameters: string[] = [];
    for (const parameter of operation.parameters) {
      const value = fields[parameter.name];
      if (parameter.in === "path") {
        if (value == null) throw new Error(`${operationId} needs "${parameter.name}"`);
        resolvedPath = resolvedPath.replaceAll(
          `{${parameter.name}}`,
          encodeURIComponent(String(value)),
        );
      } else if (parameter.in === "query") {
        if (value == null && parameter.required)
          throw new Error(`${operationId} needs query parameter "${parameter.name}"`);
        if (value != null) url.searchParams.set(parameter.name, String(value));
      } else if (parameter.in === "header") {
        if (value != null) headers.set(parameter.name, String(value));
      } else if (parameter.in === "cookie") {
        if (value != null)
          cookieParameters.push(`${parameter.name}=${encodeURIComponent(String(value))}`);
      } else continue;
      delete fields[parameter.name];
    }
    // ONE Cookie header, `; `-joined (RFC 6265) after any cookie the connection's own headers carry
    // — `Headers.append` would join the pairs with `, `, which no server reads as two cookies.
    if (cookieParameters.length > 0)
      headers.set(
        "cookie",
        [headers.get("cookie"), ...cookieParameters].filter(Boolean).join("; "),
      );
    url.pathname = url.pathname.replace(/\/$/, "") + resolvedPath;
    const leftover = Object.keys(fields);
    let body: string | undefined;
    if (operation.hasRequestBody) {
      if (leftover.length > 0) {
        body = JSON.stringify(leftover.length === 1 && "body" in fields ? fields.body : fields);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      }
    } else if (leftover.length > 0) {
      throw new Error(
        `${operationId} has no request body and got unknown input key${leftover.length > 1 ? "s" : ""} ${leftover.map((k) => JSON.stringify(k)).join(", ")}`,
      );
    }
    const response = await this.#itx.fetch(
      new Request(url, { method: operation.method.toUpperCase(), headers, body }),
    );
    await refuseUnlessOk(
      response,
      `${operation.method.toUpperCase()} ${url.pathname} (${operationId})`,
    );
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.includes("json") ? await response.json() : await response.text();
  }
}

async function fetchDocument(
  itx: LibraryItx,
  specUrl: string,
  options: OpenApiConnectOptions,
): Promise<OpenApiDocument> {
  // auth headers reach the spec only when it lives on the API's host (apps/os `specFetchHeaders`)
  const sameHost = !options.baseUrl || new URL(options.baseUrl).host === new URL(specUrl).host;
  const headers = sameHost ? (options.headers ?? {}) : {};
  const response = await refuseUnlessOk(
    await itx.fetch(new Request(specUrl, { headers })),
    `connectToOpenApi: fetching ${specUrl}`,
  );
  return (await response.json()) as OpenApiDocument;
}

/** `baseUrl`, else the document's first server (resolved against the spec URL), else the spec URL
 *  minus its last path segment — QUERY KEPT, so a fetch-lane URL stays addressed. */
function requestBase(
  spec: OpenApiDocument,
  specUrl: string | undefined,
  options: OpenApiConnectOptions,
): URL {
  if (options.baseUrl) return new URL(options.baseUrl);
  const serverUrl = spec.servers?.[0]?.url;
  const relative = serverUrl !== undefined && !/^[a-z][a-z0-9+.-]*:/i.test(serverUrl);
  if (serverUrl && !(relative && !specUrl)) {
    const base = new URL(serverUrl, specUrl);
    // a RELATIVE server (`/api`, the common spelling) resolved against a fetch-lane spec URL keeps
    // the lane's `?context=&itx=` — dropping it would send every operation to the worker's banner
    if (relative && specUrl) base.search = new URL(specUrl).search;
    return base;
  }
  if (!specUrl)
    throw new Error(
      `connectToOpenApi: a document ${serverUrl ? `whose server is the relative ${JSON.stringify(serverUrl)}` : "without servers"} needs { baseUrl }`,
    );
  const base = new URL(specUrl);
  base.pathname = base.pathname.replace(/\/[^/]*$/, "");
  return base;
}

function listOperations(spec: OpenApiDocument): OpenApiOperation[] {
  const operations: OpenApiOperation[] = [];
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    if (pathItem == null || typeof pathItem !== "object") continue;
    const pathParameters = Array.isArray(pathItem.parameters)
      ? (pathItem.parameters as OpenApiOperation["parameters"])
      : [];
    for (const [method, raw] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || raw == null || typeof raw !== "object") continue;
      const op = raw as Record<string, unknown>;
      if (typeof op.operationId !== "string") continue;
      const own = Array.isArray(op.parameters)
        ? (op.parameters as OpenApiOperation["parameters"])
        : [];
      operations.push({
        operationId: op.operationId,
        method,
        path,
        // An operation's parameter OVERRIDES the path item's of the same (name, in) — the spec's rule.
        parameters: [
          ...pathParameters.filter(
            (inherited) => !own.some((o) => o.name === inherited.name && o.in === inherited.in),
          ),
          ...own,
        ].map(({ name, in: location, required }) => ({ name, in: location, required })),
        hasRequestBody: op.requestBody != null,
        ...(typeof op.summary === "string" && { summary: op.summary }),
      });
    }
  }
  return operations;
}
