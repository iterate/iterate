import { DurableObject } from "cloudflare:workers";
import { generateTypesFromJsonSchema, type JsonSchemaToolDescriptors } from "@cloudflare/codemode";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";

type JsonSchema = JsonSchemaToolDescriptors[string]["inputSchema"];

/**
 * Janky POC: a Durable Object that owns one connection to a single MCP
 * (Model Context Protocol) server. Hardcoded server URL for now. Each DO
 * instance opens its own connection during the first concurrent block of
 * the constructor and caches the tools list.
 *
 * Designed to be addressed via a {@link import("~/lib/callable.ts").Callable}
 * (`{ kind: "rpc", target: { type: "durable-object", binding: { $binding:
 * "MCP_CLIENT" }, address: { ... } }, rpcMethod: "callTool" | "getTypes" }`)
 * so that codemode tool providers can be registered and invoked entirely
 * via JSON-serialisable references.
 *
 * The transport here is a minimal `fetch`-based JSON-RPC over Streamable
 * HTTP (servers reply either with `application/json` or a single-event
 * `text/event-stream` `event: message` frame). Sessions are not yet
 * supported — `https://docs.mcp.cloudflare.com/mcp` is stateless, and the
 * POC doesn't aim to handle anything else. When this graduates we should
 * lean on `@modelcontextprotocol/sdk`'s client + StreamableHTTP transport
 * instead of rolling our own protocol parser.
 */

const MCP_SERVER_URL = "https://docs.mcp.cloudflare.com/mcp";
const PROTOCOL_VERSION = "2025-03-26";

interface McpToolListEntry {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
}

interface McpTextContent {
  type: string;
  text?: string;
}

interface McpToolCallResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: McpTextContent[];
}

export interface GetTypesPayload {
  /**
   * Sandbox namespace the caller intends to register this provider under.
   * `generateTypesFromJsonSchema` always emits `declare const codemode:`,
   * so we rewrite it to `declare const <namespace>:` before returning so
   * the LLM-facing types match the runtime namespace one-to-one.
   */
  namespace?: string;
}

export interface GetTypesResponse {
  types: string;
}

export interface CallToolPayload {
  name: string;
  /**
   * Positional argument array forwarded by codemode `dynamicTools.callTool`.
   * For MCP-style tools — which take a single arguments object — only
   * `args[0]` is consulted. We reject calls that pass a different shape so
   * mismatches surface early instead of being silently dropped.
   */
  args: unknown[];
}

export class MCPClient extends DurableObject<CloudflareEnv> {
  #toolsPromise: Promise<McpToolListEntry[]>;
  #rpcSeq = 0;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Eagerly establish the connection on first activation so the first
    // tool call doesn't pay the handshake cost. `blockConcurrencyWhile`
    // delays *all* incoming RPC handlers until the inner promise settles.
    this.#toolsPromise = state.blockConcurrencyWhile(() => this.#handshake());
  }

  async getTypes(payload: GetTypesPayload | null): Promise<GetTypesResponse> {
    const tools = await this.#toolsPromise;
    const namespace = payload?.namespace ?? "codemode";
    const descriptors: JsonSchemaToolDescriptors = {};
    for (const tool of tools) {
      descriptors[tool.name] = {
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: "object" },
        outputSchema: tool.outputSchema,
      };
    }
    const rawTypes = generateTypesFromJsonSchema(descriptors);
    const types = rawTypes.replace(/declare const codemode:/, `declare const ${namespace}:`);
    return { types };
  }

  async callTool(payload: CallToolPayload): Promise<unknown> {
    const tools = await this.#toolsPromise;
    if (!tools.some((tool) => tool.name === payload.name)) {
      throw new Error(`MCP tool "${payload.name}" not found on ${MCP_SERVER_URL}`);
    }
    const result = await this.#rpc<McpToolCallResult>("tools/call", {
      name: payload.name,
      arguments: extractMcpArguments(payload.args),
    });
    return unwrapToolResult(result);
  }

  async #handshake(): Promise<McpToolListEntry[]> {
    await this.#rpc<unknown>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "iterate-mcp-client", version: "0.0.1" },
    });
    // Stateless `notifications/initialized` is a fire-and-forget formality;
    // skipped here because the docs server doesn't require it. Add when
    // we encounter a server that does.
    const list = await this.#rpc<{ tools: McpToolListEntry[] }>("tools/list", {});
    return list.tools ?? [];
  }

  async #rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.#rpcSeq += 1;
    const id = this.#rpcSeq;
    const response = await fetch(MCP_SERVER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!response.ok) {
      throw new Error(`MCP ${method} HTTP ${response.status}: ${await response.text()}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("text/event-stream")
      ? await readSingleSseMessage(response)
      : await response.text();
    const parsed = JSON.parse(body) as
      | { jsonrpc: "2.0"; id: number; result: T }
      | { jsonrpc: "2.0"; id: number; error: { code: number; message: string; data?: unknown } };
    if ("error" in parsed) {
      throw new Error(`MCP ${method} error ${parsed.error.code}: ${parsed.error.message}`);
    }
    return parsed.result;
  }
}

/**
 * Reads the first `event: message` frame from a Streamable HTTP MCP
 * response, returning the raw `data:` JSON payload. Sufficient for
 * synchronous request/response interactions on stateless servers; servers
 * that emit progress events or multi-frame streams will need a real SSE
 * parser.
 */
async function readSingleSseMessage(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("MCP SSE response had no body");
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "" && dataLines.length > 0) {
        return dataLines.join("\n");
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      newlineIndex = buffer.indexOf("\n");
    }
    if (done) {
      if (dataLines.length > 0) return dataLines.join("\n");
      throw new Error("MCP SSE stream ended before a `message` frame was received");
    }
  }
}

/**
 * Extract the single object argument from a codemode positional-arg array.
 * MCP tool calls take exactly one `arguments` object (per spec); 0 args
 * collapses to `{}`, anything else is rejected so wire-shape drift surfaces
 * loudly.
 */
function extractMcpArguments(args: unknown[]): Record<string, unknown> {
  if (args.length === 0) return {};
  if (args.length > 1) {
    throw new Error(`MCP tool call expects a single arguments object, got ${args.length} args`);
  }
  const first = args[0];
  if (first == null) return {};
  if (typeof first !== "object" || Array.isArray(first)) {
    throw new Error("MCP tool call argument must be a plain object");
  }
  return first as Record<string, unknown>;
}

function unwrapToolResult(result: McpToolCallResult): unknown {
  if (result.isError) {
    const message =
      (result.content ?? [])
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join("\n") || "MCP tool call failed";
    throw new Error(message);
  }
  if (result.structuredContent != null) return result.structuredContent;
  const allText =
    (result.content?.length ?? 0) > 0 &&
    (result.content ?? []).every((item) => item.type === "text");
  if (allText) {
    const text = (result.content ?? []).map((item) => item.text ?? "").join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}
