// library/mcp.test.ts — the MCP client against a fake server: a `Request → Response` function behind
// a fake `itx.fetch`, recording every request. Rows, not prose.
import { describe, expect, test } from "vitest";
import { connectToMcp, type McpConnection } from "./mcp.ts";
import type { LibraryItx } from "./index.ts";

type Handler = (request: Request, body: any) => Response | Promise<Response>;

/** A fake `itx` whose fetch records requests and answers with `handler`. */
function fakeItx(handler: Handler): {
  itx: LibraryItx;
  requests: Array<{ request: Request; body: any }>;
} {
  const requests: Array<{ request: Request; body: any }> = [];
  const itx = {
    fetch: async (request: Request) => {
      const text = await request.clone().text();
      const body = text ? JSON.parse(text) : undefined;
      requests.push({ request, body });
      return handler(request, body);
    },
  } as unknown as LibraryItx;
  return { itx, requests };
}

const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
  });

const TOOLS = [
  { name: "echo", description: "echo the args", inputSchema: { type: "object" } },
  { name: "add", inputSchema: { type: "object" } },
  { name: "callTool", inputSchema: {} }, // a reserved name: reachable through callTool only
];

/** The reference fake server: hands out a session id on initialize and insists on it afterwards. */
function referenceServer(options: { sse?: boolean } = {}): Handler {
  return (request, body) => {
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (body.method === "initialize")
      return json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "0" },
          },
        },
        { headers: { "mcp-session-id": "s-1" } },
      );
    if (request.headers.get("mcp-session-id") !== "s-1")
      return new Response("no session", { status: 400 });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    let result: unknown;
    if (body.method === "tools/list") result = { tools: TOOLS };
    else if (body.method === "tools/call") {
      const { name, arguments: args } = body.params;
      if (name === "echo")
        result = { content: [{ type: "text", text: JSON.stringify({ echoed: args }) }] };
      else if (name === "add")
        result = {
          content: [{ type: "text", text: "ignored" }],
          structuredContent: { sum: args.a + args.b },
        };
      else if (name === "plain") result = { content: [{ type: "text", text: "just text" }] };
      else if (name === "boom")
        result = { content: [{ type: "text", text: "it broke" }], isError: true };
      else
        return json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32602, message: `unknown tool ${name}` },
        });
    }
    const message = { jsonrpc: "2.0", id: body.id, result };
    return options.sse
      ? new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      : json(message);
  };
}

describe("connectToMcp", () => {
  test("connect: initialize → initialized → tools/list, the session id riding on every later request", async () => {
    const { itx, requests } = fakeItx(referenceServer());
    const conn = await connectToMcp(itx, "https://mcp.example/rpc", {
      headers: { authorization: "Bearer t" },
    });
    expect(requests.map((r) => r.body?.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(requests[0].body.params.protocolVersion).toBe("2025-03-26");
    expect(requests[0].request.headers.get("authorization")).toBe("Bearer t");
    expect(requests[0].request.headers.get("accept")).toBe("application/json, text/event-stream");
    expect(requests[2].request.headers.get("mcp-session-id")).toBe("s-1");
    expect(conn.serverInfo().serverInfo).toEqual({ name: "fake", version: "0" });
    expect(conn.tools().map((t) => t.name)).toEqual(["echo", "add", "callTool"]);
  });

  const rows: Array<{
    call: (c: McpConnection) => Promise<unknown>;
    becomes?: unknown;
    throws?: RegExp;
    sse?: boolean;
  }> = [
    { call: (c) => c.callTool("echo", { text: "hi" }), becomes: { echoed: { text: "hi" } } },
    { call: (c) => (c as any).echo({ text: "dotted" }), becomes: { echoed: { text: "dotted" } } }, // a tool as a method
    { call: (c) => (c as any).add({ a: 2, b: 3 }), becomes: { sum: 5 } }, // structuredContent wins over text
    { call: (c) => c.callTool("plain"), becomes: "just text" }, // text that is not JSON stays text
    { call: (c) => c.callTool("boom"), throws: /MCP tool boom failed: it broke/ },
    { call: (c) => c.callTool("nope"), throws: /MCP tools\/call: unknown tool nope/ },
    {
      call: (c) => c.callTool("echo", { via: "sse" }),
      becomes: { echoed: { via: "sse" } },
      sse: true,
    },
    { call: (c) => c.listTools(), becomes: TOOLS },
  ];
  for (const row of rows)
    test(`${row.call.toString().slice(0, 50)} → ${row.throws ?? JSON.stringify(row.becomes)}`, async () => {
      const { itx } = fakeItx(referenceServer({ sse: row.sse }));
      const conn = await connectToMcp(itx, "https://mcp.example/rpc");
      if (row.throws) await expect(row.call(conn)).rejects.toThrow(row.throws);
      else expect(await row.call(conn)).toEqual(row.becomes);
    });

  test("a tool named like a reserved member does not shadow it: callTool stays callTool", async () => {
    const { itx } = fakeItx(referenceServer());
    const conn = await connectToMcp(itx, "https://mcp.example/rpc");
    expect(await conn.callTool("echo", { x: 1 })).toEqual({ echoed: { x: 1 } });
  });

  test("close DELETEs the session once; a server without a session id gets no DELETE", async () => {
    const withSession = fakeItx(referenceServer());
    const conn = await connectToMcp(withSession.itx, "https://mcp.example/rpc");
    await conn.close();
    await conn.close();
    const deletes = withSession.requests.filter((r) => r.request.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].request.headers.get("mcp-session-id")).toBe("s-1");
    const sessionless = fakeItx((_request, body) => {
      if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
      return json({
        jsonrpc: "2.0",
        id: body?.id,
        result: body?.method === "tools/list" ? { tools: [] } : {},
      });
    });
    await (await connectToMcp(sessionless.itx, "https://mcp.example/rpc")).close();
    expect(sessionless.requests.some((r) => r.request.method === "DELETE")).toBe(false);
  });

  test("a non-2xx answer throws with the status and the body", async () => {
    const { itx } = fakeItx(() => new Response("nope", { status: 503 }));
    await expect(connectToMcp(itx, "https://mcp.example/rpc")).rejects.toThrow(
      /MCP initialize: 503 nope/,
    );
  });
});
