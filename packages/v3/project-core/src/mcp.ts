import { z } from "zod";

/** Stateless Streamable-HTTP MCP adapter. The root worker owns route and auth. */
export type McpRun = (
  method: string[],
  args: unknown[],
) => Promise<{ result?: unknown; error?: { code: string; message: string; status?: number } }>;

const PROTOCOL = "2025-03-26";
const Id = z.union([z.string(), z.number(), z.null()]);
const Request = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: Id.optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
const Initialize = z.looseObject({
  protocolVersion: z.string().min(1),
  capabilities: z.record(z.string(), z.unknown()),
  clientInfo: z.object({ name: z.string().min(1), version: z.string().min(1) }),
});
const Call = z.strictObject({
  name: z.literal("iterate"),
  arguments: z.strictObject({
    method: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/))
      .min(1)
      .max(24),
    args: z.array(z.unknown()).max(64),
  }),
});
const List = z.strictObject({ cursor: z.string().min(1).optional() });

const tool = {
  name: "iterate",
  description:
    "Invoke one configured Iterate project method. Tutorial contract: method is a non-empty method-name path; args are its positional JSON arguments.",
  inputSchema: z.toJSONSchema(Call.shape.arguments),
};

const error = (id: string | number | null, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } });
const result = (id: string | number | null, result: unknown) =>
  Response.json({ jsonrpc: "2.0", id, result });
/** Handle one POST body. GET deliberately belongs to the root worker and returns 405 there. */
export async function handleMcp(request: Request, run: McpRun): Promise<Response> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return error(null, -32700, "Parse error");
  }
  const parsed = Request.safeParse(input);
  if (!parsed.success) return error(null, -32600, "Invalid Request");
  const notification = parsed.data.id === undefined;
  const id = parsed.data.id ?? null;
  const answer = await dispatch(parsed.data.method, parsed.data.params, id, run);
  return notification ? new Response(null, { status: 202 }) : answer;
}

async function dispatch(method: string, params: unknown, id: string | number | null, run: McpRun) {
  if (method === "initialize") {
    if (!Initialize.safeParse(params).success) return error(id, -32602, "Invalid params");
    // We support this stateless adapter's version; MCP clients disconnect if they cannot use it.
    return result(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: "iterate", version: "1" },
    });
  }
  if (method === "notifications/initialized") return new Response(null, { status: 202 });
  if (method === "tools/list") {
    if (!List.safeParse(params ?? {}).success) return error(id, -32602, "Invalid params");
    return result(id, { tools: [tool] });
  }
  if (method !== "tools/call") return error(id, -32601, "Method not found");
  const call = Call.safeParse(params);
  if (!call.success) return error(id, -32602, "Invalid params");
  try {
    const outcome = await run(call.data.arguments.method, call.data.arguments.args);
    if (outcome.error) return toolError(id, outcome.error);
    const value = outcome.result === undefined ? undefined : z.json().safeParse(outcome.result);
    if (value !== undefined && !value.success)
      return toolError(id, { code: "RESULT", message: "Method returned non-JSON data" });
    const data = value === undefined ? undefined : value.data;
    return result(id, {
      content: [{ type: "text", text: JSON.stringify(data ?? null) }],
      ...(data === undefined ? {} : { structuredContent: { result: data } }),
    });
  } catch (cause) {
    console.error("MCP dispatch failed", cause);
    return error(id, -32603, "Internal error");
  }
}

function toolError(
  id: string | number | null,
  detail: { code: string; message: string; status?: number },
) {
  return result(id, {
    content: [{ type: "text", text: JSON.stringify(detail) }],
    structuredContent: { error: detail },
    isError: true,
  });
}
