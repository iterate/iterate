import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerErrorTools(server: McpServer) {
  server.tool(
    "mock_error",
    "Throws a specified type of error",
    {
      errorType: z
        .enum(["validation", "runtime", "not_found", "permission_denied"])
        .describe("Type of error to throw"),
      message: z.string().optional().describe("Custom error message"),
    },
    async ({ errorType, message }) => {
      const errorMessage = message || `Mock ${errorType} error`;

      switch (errorType) {
        case "validation":
          throw new Error(`ValidationError: ${errorMessage}`);
        case "runtime":
          throw new Error(`RuntimeError: ${errorMessage}`);
        case "not_found":
          throw new Error(`NotFoundError: ${errorMessage}`);
        case "permission_denied":
          throw new Error(`PermissionDeniedError: ${errorMessage}`);
      }

      throw new Error(`Unknown error type: ${errorType}`);
    },
  );

  server.tool(
    "mock_conditional_error",
    "Returns success or error based on input value",
    {
      shouldFail: z.boolean().describe("Whether to throw an error"),
      value: z.string().describe("Value to return if successful"),
    },
    async ({ shouldFail, value }) => {
      if (shouldFail) {
        throw new Error("Conditional failure triggered");
      }

      return {
        content: [{ type: "text", text: `Success: ${value}` }],
      };
    },
  );
}
