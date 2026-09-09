// library/mcp-server.ts — `itx.serveMcp()`: THIS context as an MCP server — the machine lane. A
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

import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type JsonSchemaType,
} from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { RpcTarget } from "capnweb";
import {
  normalizedItxExpression,
  type ItxExpression,
  type ItxExpressionInput,
} from "../context/expression.ts";
import type { LibraryItx } from "./index.ts";

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
        // (lib/errors.ts — `NO_ITX_EXPRESSION_MATCH`, `RPC_STUB_OFFLINE`, …): the machine-readable
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
