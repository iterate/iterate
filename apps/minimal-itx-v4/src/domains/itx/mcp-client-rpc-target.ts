import { RpcTarget } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  CapabilityDescriptionMetadata,
  McpClientCollection,
  McpClientConnectInput,
  McpClientRpc,
} from "../../types.ts";
import { withInvokeCapabilityFallback } from "./utils.ts";
import { escapeJsDoc, jsonSchemaToTypeString, propertyKey } from "./json-schema-types.ts";

// MCP is common enough to expose as a built-in, but the built-in stays tiny:
// it is an RpcTarget that gets a project egress Fetcher and otherwise uses the
// public MCP SDK. A dynamic worker can implement the same shape by calling
// env.ITX.get().egress.fetch through its single ITX binding.
type McpClientDeps = { egress: Fetcher };

type McpRequestOptions = { timeout?: number };

type McpTool = {
  description?: string;
  inputSchema?: Record<string, unknown>;
  name: string;
};

export class McpClientCollectionRpcTarget extends RpcTarget implements McpClientCollection {
  constructor(readonly props: McpClientDeps) {
    super();
  }

  connect(input: McpClientConnectInput): Promise<McpClientRpc> {
    return McpClientRpcTarget.connect(input, this.props);
  }
}

class McpClientRpcTarget extends RpcTarget implements McpClientRpc {
  static async connect(input: McpClientConnectInput, deps: McpClientDeps) {
    const options = requestOptions(input);
    const client = await connectMcp(input, deps.egress, options);
    try {
      const tools = await listMcpTools(client, options);
      return new McpClientRpcTarget({ config: input, egress: deps.egress, tools });
    } finally {
      await client.close().catch(() => {});
    }
  }

  constructor(
    readonly props: {
      config: McpClientConnectInput;
      egress: Fetcher;
      tools: McpTool[];
    },
  ) {
    super();
    return withInvokeCapabilityFallback(this);
  }

  async __describe(): Promise<CapabilityDescriptionMetadata> {
    return {
      instructions:
        "Call tools directly by tool name with one input object matching the tool schema. " +
        "Call __describe() for this capability's instructions and TypeScript declarations.",
      types: deriveMcpCapabilityTypes(this.props.tools),
    };
  }

  async invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    const options = requestOptions(this.props.config);
    const client = await connectMcp(this.props.config, this.props.egress, options);
    try {
      return await executeMcpToolCall({ args, client, options, path });
    } finally {
      await client.close().catch(() => {});
    }
  }
}

function deriveMcpCapabilityTypes(tools: McpTool[]): string {
  const members = [
    "  __describe(): Promise<{ instructions: string; types: string }>;",
    ...tools.flatMap((tool) => {
      const inputType = jsonSchemaToTypeString(
        tool.inputSchema ?? { type: "object" },
        tool.inputSchema ?? {},
      );
      return [
        "",
        `  /** ${escapeJsDoc(tool.description?.trim() || tool.name)} */`,
        `  ${propertyKey(tool.name)}(input: ${inputType}): Promise<unknown>;`,
      ];
    }),
  ];
  return `export type Capability = {\n${members.join("\n")}\n};`;
}

async function connectMcp(
  input: McpClientConnectInput,
  egress: Fetcher,
  options?: McpRequestOptions,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(input.url), {
    fetch: (fetchInput: Request | string | URL, init?: RequestInit) => {
      const request =
        fetchInput instanceof Request
          ? new Request(fetchInput, init)
          : new Request(String(fetchInput), init);
      // Streamable HTTP may probe a standalone GET SSE channel. This reference
      // client is deliberately connect -> call -> close, so answering 405 keeps
      // every invocation stateless and avoids pinning a stream through egress.
      if (request.method === "GET") {
        return Promise.resolve(new Response(null, { status: 405 }));
      }
      // Headers may contain getSecret({ path }) placeholders. Egress owns
      // substitution and origin checks, so the MCP adapter just forwards the
      // SDK-built Request unchanged.
      return egress.fetch(request);
    },
    requestInit: input.headers ? { headers: input.headers } : undefined,
  });
  const client = new Client({ name: "minimal-itx-v4-mcp-client", version: "1.0.0" });
  try {
    await client.connect(transport, options);
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

async function listMcpTools(client: Client, options?: McpRequestOptions): Promise<McpTool[]> {
  const response = await client.listTools(undefined, options);
  return response.tools.map((tool) => ({
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
    name: tool.name,
  }));
}

async function executeMcpToolCall(input: {
  args: unknown[];
  client: Client;
  options?: McpRequestOptions;
  path: string[];
}) {
  const [name, ...extraPath] = input.path;
  if (!name) throw new Error("MCP tool calls need a tool name path.");
  if (extraPath.length > 0) {
    throw new Error(`MCP tools are flat tool names, got "${input.path.join(".")}".`);
  }
  const [firstArg] = input.args;
  const toolArguments =
    firstArg != null && typeof firstArg === "object" && !Array.isArray(firstArg)
      ? (firstArg as Record<string, unknown>)
      : {};

  const result = await input.client.callTool(
    { name, arguments: toolArguments },
    undefined,
    input.options,
  );
  // Prefer structured content when a server provides it; otherwise fall back to
  // the text content convention used by many simple MCP servers.
  if (result.structuredContent != null) return result.structuredContent;

  if (result.isError) {
    const message = extractTextContent(result.content).join("\n") || "MCP tool call failed";
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

function requestOptions(input: McpClientConnectInput): McpRequestOptions | undefined {
  return input.timeoutMs ? { timeout: input.timeoutMs } : undefined;
}

function extractTextContent(content: unknown) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) =>
    item != null &&
    typeof item === "object" &&
    "type" in item &&
    item.type === "text" &&
    "text" in item &&
    typeof item.text === "string"
      ? [item.text]
      : [],
  );
}
