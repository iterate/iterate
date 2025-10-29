import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerAsyncTools(server: McpServer) {
  server.tool(
    "mock_delay",
    "Waits for specified milliseconds before responding",
    {
      delayMs: z.number().min(0).max(10000).describe("Delay in milliseconds (max 10s)"),
      message: z.string().describe("Message to return after delay"),
    },
    async ({ delayMs, message }) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      return {
        content: [
          {
            type: "text",
            text: `Delayed ${delayMs}ms: ${message}`,
          },
        ],
      };
    },
  );

  server.tool(
    "mock_counter",
    "Returns a counter value based on current timestamp",
    {
      prefix: z.string().optional().describe("Optional prefix for the counter"),
    },
    async ({ prefix }) => {
      const counter = Date.now() % 1000;
      const text = prefix ? `${prefix}: ${counter}` : String(counter);

      return {
        content: [{ type: "text", text }],
      };
    },
  );
}

