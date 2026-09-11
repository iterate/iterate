// mcp-server.ts — the standard MCP Streamable HTTP transport around the project's one existing
// invoke door. MCP is not a parallel capability API: dotted ITX expressions resolve exactly as they
// do over `/api`, only OAuth selects the project before this module is reached.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { toItxExpression, type ItxExpressionInput } from "./context/expression.ts";

const InvokeInput = z.object({
  expression: z.union([z.string().min(1), z.array(z.unknown()).min(1)]),
  args: z.array(z.unknown()).max(64).optional(),
});

export type McpInvoker = (expression: ItxExpressionInput, args: unknown[]) => Promise<unknown>;
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Handle one OAuth-authorized MCP request. This intentionally creates a stateless official
 * Streamable HTTP transport per request: OAuth grants are bearer credentials, not worker-isolate
 * session state, and the SDK then owns protocol negotiation, JSON-RPC errors, notifications,
 * content negotiation, and SSE/JSON response rules.
 */
export async function handleMcpRequest(request: Request, invoke: McpInvoker): Promise<Response> {
  const server = new McpServer({ name: "iterate-project", version: "4" });
  server.registerResource(
    "itx-invoke",
    "iterate://docs/itx-invoke",
    {
      title: "Project ITX invocation",
      description:
        "How the project-scoped itx.invoke MCP tool maps to the normal ITX capability surface.",
      mimeType: "text/markdown",
    },
    () => ({
      contents: [
        {
          uri: "iterate://docs/itx-invoke",
          mimeType: "text/markdown",
          text: "Use `itx.invoke` with the same dotted expression accepted by project ITX, such as `itx.kv.get('key')`. Optional `args` are appended to the expression's terminal call. The OAuth grant binds every call to the selected project.",
        },
      ],
    }),
  );
  server.registerTool(
    "itx.invoke",
    {
      title: "Invoke project ITX",
      description:
        "Invoke a project-scoped Iterate capability. expression is a normal dotted ITX expression (for example itx.kv.get('key')) or its structured form; args are appended to its terminal call.",
      inputSchema: InvokeInput,
    },
    async ({ expression, args = [] }) => {
      try {
        const value = await invoke(toItxExpression(expression as ItxExpressionInput), args);
        const json = jsonValue(value);
        if (json === undefined) return toolFailure("ITX returned a non-JSON value");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(json) }],
          structuredContent: { result: json },
        };
      } catch (error) {
        return toolFailure(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // Stateless mode deliberately has no session id; never reuse this transport (the SDK correctly
  // rejects that because JSON-RPC request ids are only unique within a client request).
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

function toolFailure(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** JSON has no undefined. Round-trip so optional undefined members on a legitimate Workers-RPC
 * result are omitted exactly as JSON transports require, while cycles and non-JSON primitives fail. */
function jsonValue(value: unknown): JsonValue | undefined {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : (z.json().parse(JSON.parse(encoded)) as JsonValue);
  } catch {
    return undefined;
  }
}
