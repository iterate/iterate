import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type FetchLike,
  type RequestOptions,
  type StreamableHTTPClientTransportOptions,
  type Tool,
} from "@modelcontextprotocol/client";

/** Input to `itx.mcp.connect`: the MCP server's streamable-HTTP URL, optional
 * request headers (auth), and an optional per-tool-call timeout in
 * milliseconds. */
export type McpClientConnectInput = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  url: string;
};

/**
 * A connected MCP client. Its tools are dotted method calls
 * (`itx.mcp.<server>.<tool>({...})`) resolved through the dynamic path-call
 * fallback, so this contract deliberately does not re-declare a fixed surface.
 */
export type McpClientRpc = object;

/** Input to `itx.mcp.beginOAuth`: the OAuth-protected MCP server to connect to,
 * an optional secret path to store the token at (defaults to `/secrets/mcp/<host>`),
 * and an optional OAuth scope to request. */
export type McpBeginOAuthInput = {
  /** The MCP server's URL (the same URL you would pass to `connect`). */
  url: string;
  /** Where the resulting token is stored write-only. Defaults to `/secrets/mcp/<host>`. */
  path?: string;
  /** OAuth scope to request; the server's default is used when omitted. */
  scope?: string;
};

/** Result of `itx.mcp.beginOAuth`: a link to send the user through, and the
 * secret path the token lands at once they finish. */
export type McpBeginOAuthResult = {
  /** Send this to the user. Signing in there stores the token and (for an agent)
   * messages you back so you can continue. */
  authorizationUrl: string;
  /** The `/secrets/…` path the token is stored at. Connect afterwards with
   * `headers: { authorization: 'Bearer getSecret({ path: "<path>", field: "accessToken" })' }`. */
  path: string;
};

const CLIENT_INFO = {
  name: "itx-mcp-client",
  version: "1.0.0",
};

type McpClientSessionInput = {
  config: McpClientConnectInput;
  egress: Fetcher;
};

export async function callMcpToolPath(
  input: McpClientSessionInput & {
    args: unknown[];
    path: string[];
  },
) {
  const toolCall = toolCallFromCapabilityPath(input.path, input.args);
  const session = await ItxMcpClientSession.connect(input);
  try {
    return await session.callTool(toolCall);
  } finally {
    await session.close();
  }
}

export async function listMcpTools(input: McpClientSessionInput): Promise<Tool[]> {
  const session = await ItxMcpClientSession.connect(input);
  try {
    return (await session.listTools()).tools;
  } finally {
    await session.close();
  }
}

class ItxMcpClientSession {
  static async connect(input: McpClientSessionInput) {
    const requestOptions = input.config.timeoutMs ? { timeout: input.config.timeoutMs } : undefined;
    const client = new Client(CLIENT_INFO);

    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(input.config.url),
          transportOptionsFor(input.config, input.egress),
        ),
        requestOptions,
      );
      return new ItxMcpClientSession(client, requestOptions);
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  private constructor(
    private readonly client: Client,
    private readonly requestOptions: RequestOptions | undefined,
  ) {}

  async callTool(input: McpToolCall) {
    return mcpResultToItxValue(
      await this.client.callTool(
        {
          arguments: input.arguments,
          name: input.name,
        },
        this.requestOptions,
      ),
    );
  }

  async listTools() {
    return await this.client.listTools(undefined, this.requestOptions);
  }

  async close() {
    await this.client.close().catch(() => {});
  }
}

type McpToolCall = {
  arguments: Record<string, unknown>;
  name: string;
};

function toolCallFromCapabilityPath(path: string[], args: unknown[]): McpToolCall {
  const [name, ...extraPath] = path;
  if (!name) throw new Error("MCP tool calls need a tool name path.");
  if (extraPath.length > 0) {
    throw new Error(`MCP tools are flat tool names, got "${path.join(".")}".`);
  }

  return {
    arguments: toolArgumentsFromRpcArgs(args),
    name,
  };
}

function toolArgumentsFromRpcArgs(args: unknown[]) {
  const [firstArg] = args;
  return firstArg != null && typeof firstArg === "object" && !Array.isArray(firstArg)
    ? (firstArg as Record<string, unknown>)
    : {};
}

function transportOptionsFor(
  input: McpClientConnectInput,
  egress: Fetcher,
): StreamableHTTPClientTransportOptions {
  return {
    fetch: statelessEgressFetch(egress),
    requestInit: input.headers ? { headers: input.headers } : undefined,
  };
}

function statelessEgressFetch(egress: Fetcher): FetchLike {
  return (url, init) => {
    const request = new Request(url, init);
    // Streamable HTTP may probe a standalone GET SSE channel. This adapter is
    // deliberately connect -> call -> close, so answering 405 keeps each
    // invocation stateless and avoids pinning a stream through project egress.
    if (request.method === "GET") {
      return Promise.resolve(new Response(null, { status: 405 }));
    }

    // Headers may contain getSecret({ path }) placeholders. Egress owns
    // substitution and origin checks, so this adapter forwards SDK-built
    // requests unchanged.
    return egress.fetch(request);
  };
}

function mcpResultToItxValue(result: CallToolResult) {
  if (result.isError) {
    const message = textContent(result).join("\n") || "MCP tool call failed";
    throw new Error(message);
  }

  if (result.structuredContent !== undefined) return result.structuredContent;

  const textParts = textContent(result);
  if (textParts.length === 0) return result;

  const text = textParts.join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function textContent(result: CallToolResult) {
  return result.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
}
