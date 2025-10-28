import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Register tools that have async behavior (delays, timeouts).
 * Used for testing async handling and timeouts.
 */
export function registerAsyncTools(server: McpServer) {
  // Delay tool - waits before responding
  server.tool(
    "mock_delay",
    "Waits for specified milliseconds before responding. Tests async handling and timeouts.",
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

  // Counter tool - returns incrementing counter (stateless)
  server.tool(
    "mock_counter",
    "Returns a counter value based on current timestamp. Tests deterministic but time-based responses.",
    {
      prefix: z.string().optional().describe("Optional prefix for the counter"),
    },
    async ({ prefix }) => {
      // Use timestamp to create pseudo-counter (deterministic for tests with mocked time)
      const counter = Date.now() % 1000;
      const text = prefix ? `${prefix}: ${counter}` : String(counter);

      return {
        content: [{ type: "text", text }],
      };
    },
  );
}
