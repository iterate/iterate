import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerDeterministicTools(server: McpServer) {
  server.tool(
    "mock_echo",
    "Returns the provided message exactly as received",
    {
      message: z.string().describe("The message to echo back"),
    },
    async ({ message }) => ({
      content: [{ type: "text", text: `Echo: ${message}` }],
    }),
  );

  server.tool(
    "mock_add",
    "Adds two numbers together",
    {
      a: z.number().describe("First number"),
      b: z.number().describe("Second number"),
    },
    async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
    }),
  );

  server.tool(
    "mock_calculate",
    "Performs basic arithmetic operations",
    {
      operation: z.enum(["add", "subtract", "multiply", "divide"]).describe("Operation to perform"),
      a: z.number().describe("First operand"),
      b: z.number().describe("Second operand"),
    },
    async ({ operation, a, b }) => {
      if (operation === "divide" && b === 0) {
        return {
          content: [{ type: "text", text: "Error: Division by zero" }],
          isError: true,
        };
      }

      const result =
        operation === "add"
          ? a + b
          : operation === "subtract"
            ? a - b
            : operation === "multiply"
              ? a * b
              : a / b;

      return {
        content: [
          {
            type: "text",
            text: `${operation}(${a}, ${b}) = ${result}`,
          },
        ],
      };
    },
  );

  server.tool(
    "mock_json_echo",
    "Returns a JSON representation of the provided data",
    {
      data: z.record(z.string(), z.unknown()).describe("Arbitrary JSON data to echo"),
    },
    async ({ data }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2),
        },
      ],
    }),
  );
}
