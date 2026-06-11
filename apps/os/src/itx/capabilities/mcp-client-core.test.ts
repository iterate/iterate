import { describe, expect, test } from "vitest";
import { HttpResponse, http, useMockHttpServer } from "@iterate-com/mock-http-proxy";
import { connectMcp, executeMcpToolCall, listMcpTools } from "./mcp-client-core.ts";

describe("mcp client core", () => {
  test("lists and executes tools against a mocked streamable HTTP MCP server", async () => {
    await using server = await useMockHttpServer({ transformRequest: false });
    server.use(
      http.get(`${server.url}/mcp`, () => new HttpResponse(null, { status: 405 })),
      http.post(`${server.url}/mcp`, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer mcp-token");
        const body = (await request.json()) as {
          id?: number;
          method?: string;
          params?: { arguments?: Record<string, unknown> };
        };

        if (body.method === "initialize") {
          return HttpResponse.json({
            id: body.id,
            jsonrpc: "2.0",
            result: {
              capabilities: { tools: {} },
              protocolVersion: "2025-11-25",
              serverInfo: { name: "mock-mcp", version: "1.0.0" },
            },
          });
        }

        if (body.method === "notifications/initialized") {
          return new HttpResponse(null, { status: 202 });
        }

        if (body.method === "tools/list") {
          return HttpResponse.json({
            id: body.id,
            jsonrpc: "2.0",
            result: {
              tools: [
                {
                  description: "Echo text",
                  inputSchema: { properties: { text: { type: "string" } }, type: "object" },
                  name: "echo.text",
                },
              ],
            },
          });
        }

        if (body.method === "tools/call") {
          return HttpResponse.json({
            id: body.id,
            jsonrpc: "2.0",
            result: {
              content: [
                {
                  text: JSON.stringify({
                    echoed: body.params?.arguments?.text,
                  }),
                  type: "text",
                },
              ],
            },
          });
        }

        return HttpResponse.json({
          error: { code: -32601, message: "Method not found" },
          id: body.id,
          jsonrpc: "2.0",
        });
      }),
    );

    const client = await connectMcp({
      headers: { authorization: "Bearer mcp-token" },
      serverUrl: `${server.url}/mcp`,
    });
    try {
      await expect(listMcpTools(client)).resolves.toEqual({
        tools: [
          {
            description: "Echo text",
            inputSchema: { properties: { text: { type: "string" } }, type: "object" },
            name: "echo.text",
          },
        ],
      });

      await expect(
        executeMcpToolCall({
          args: [{ text: "hello" }],
          client,
          path: ["echo.text"],
        }),
      ).resolves.toEqual({ echoed: "hello" });
    } finally {
      await client.close();
    }
  });
});
