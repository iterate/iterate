import { describe, expect, test } from "vitest";
import { HttpResponse, http, useMockHttpServer } from "@iterate-com/mock-http-proxy";
import {
  connectMcpClient,
  describeMcpToolFunctions,
  executeMcpToolFunction,
} from "./mcp-client-bridge-core.ts";

describe("MCP client bridge core", () => {
  test("lists and executes tools against a mocked streamable HTTP MCP server", async () => {
    await using server = await useMockHttpServer({ transformRequest: false });
    server.use(
      http.get(`${server.url}/mcp`, () => new HttpResponse(null, { status: 405 })),
      http.post(`${server.url}/mcp`, async ({ request }) => {
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

    const connection = await connectMcpClient({ serverUrl: `${server.url}/mcp` });
    try {
      expect(connection.tools).toEqual([
        {
          description: "Echo text",
          inputSchema: { properties: { text: { type: "string" } }, type: "object" },
          name: "echo.text",
        },
      ]);

      await expect(
        executeMcpToolFunction({
          client: connection.client,
          path: ["echo.text"],
          payload: { text: "hello" },
        }),
      ).resolves.toEqual({ echoed: "hello" });

      expect(describeMcpToolFunctions(connection.tools)).toEqual({
        typeDefinitions:
          "{\n  /** Echo text */\n  echo_text(input: Record<string, unknown>): Promise<unknown>;\n}",
      });
    } finally {
      await connection.client.close();
    }
  });
});
