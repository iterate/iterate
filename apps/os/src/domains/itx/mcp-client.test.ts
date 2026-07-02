import { describe, expect, it, vi } from "vitest";
import { callMcpToolPath } from "./mcp-client.ts";

describe("itx MCP client", () => {
  it("initializes, calls a tool through egress, and does not list tools first", async () => {
    const methods: string[] = [];
    const authHeaders: string[] = [];
    const egress = {
      fetch: vi.fn(async (request: Request) => {
        authHeaders.push(request.headers.get("authorization") ?? "");

        const payload = (await request.json()) as {
          id?: string | number;
          method?: string;
          params?: { arguments?: { query?: string } };
        };
        methods.push(payload.method ?? "");

        if (payload.method === "initialize") {
          return Response.json({
            id: payload.id,
            jsonrpc: "2.0",
            result: {
              capabilities: { tools: {} },
              protocolVersion: "2025-11-25",
              serverInfo: { name: "mock-mcp", version: "1.0.0" },
            },
          });
        }

        if (payload.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }

        if (payload.method === "tools/call") {
          const result = { answer: `docs:${payload.params?.arguments?.query}` };
          return Response.json({
            id: payload.id,
            jsonrpc: "2.0",
            result: {
              content: [{ text: JSON.stringify(result), type: "text" }],
              structuredContent: result,
            },
          });
        }

        return Response.json({
          error: { code: -32601, message: "Method not found" },
          id: payload.id,
          jsonrpc: "2.0",
        });
      }),
    } as unknown as Fetcher;

    await expect(
      callMcpToolPath({
        args: [{ query: "Workers" }],
        config: {
          headers: { authorization: 'Bearer getSecret({ path: "/secrets/mcp" })' },
          url: "https://example.com/mcp",
        },
        egress,
        path: ["search_docs"],
      }),
    ).resolves.toEqual({ answer: "docs:Workers" });

    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(methods).not.toContain("tools/list");
    expect(authHeaders).toEqual(
      expect.arrayContaining(['Bearer getSecret({ path: "/secrets/mcp" })']),
    );
  });

  it("rejects nested MCP tool paths before connecting", async () => {
    const egress = { fetch: vi.fn() } as unknown as Fetcher;

    await expect(
      callMcpToolPath({
        args: [],
        config: { url: "https://example.com/mcp" },
        egress,
        path: ["search_docs", "nested"],
      }),
    ).rejects.toThrow('MCP tools are flat tool names, got "search_docs.nested".');

    expect(egress.fetch).not.toHaveBeenCalled();
  });
});
