import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Register tools that throw errors or return error states.
 * Used for testing error handling.
 */
export function registerErrorTools(server: McpServer) {
  // Error tool - throws different types of errors
  server.tool(
    "mock_error",
    "Throws a specified type of error. Useful for testing error handling flows.",
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

      // TypeScript needs to know this function always returns or throws
      throw new Error(`Unknown error type: ${errorType}`);
    },
  );

  // Conditional error - fails based on input
  server.tool(
    "mock_conditional_error",
    "Returns success or error based on input value. Tests conditional error handling.",
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
