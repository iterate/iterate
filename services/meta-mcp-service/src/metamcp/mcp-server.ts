import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { logger } from "../logger.ts";
import { serializeError } from "../errors.ts";
import type { MetaMcpExecutionEnvironment, MetaMcpExecutionResult } from "../execution/types.ts";
import type { MetaMcpTools } from "./tools.ts";

type MetaMcpServerParams = {
  getRuntimeTools: () => Promise<MetaMcpTools>;
  executionEnvironment: MetaMcpExecutionEnvironment;
};

export function createMetaMCPServer(params: MetaMcpServerParams) {
  const MetaMCPServer = new McpServer({
    name: "meta-mcp",
    title: "MetaMCP",
    version: "0.0.1",
    description: [
      "MetaMCP is a runtime-discovery MCP aggregator with one execute tool.",
      "You write javascript to use the tools and compose complex workflows.",
      "See the execute tool for usage instructions.",
    ].join("\n"),
  });

  MetaMCPServer.registerTool(
    "execute",
    {
      title: "Execute",
      description: [
        "JavaScript only. Starter guide:",
        "1) use tools.discover({ query }) to find likely tools for the task and read the returned inputTypeScript/outputTypeScript,",
        "2) inspect the best match with tools.describe.tool({ path, includeSchemas: true }) when you need the exact schema,",
        "3) call it with await tools.<namespace>.<tool>(args),",
        "4) return the result you want from this run.",
        "Use tools.catalog.namespaces(...) and tools.catalog.tools(...) when browsing is more useful than search.",
        "If the needed tool is missing, add a server with tools.metamcp.servers.add({ id: <required-slug>, url: <url>, auth: 'auto' }).",
        "Figure out a short stable slug from the URL hostname (e.g. 'github' from 'https://github.com/mcp'), keep auth as auto it should work in most cases.",
        "After addServer succeeds, the discovered tools are available in the same execution under tools.<namespace>.<tool>(args).",
        "Execution is stateless. Use the tools to complete the task and return the result.",
        "Returned values are already rendered with inspect depth",
      ].join("\n"),
      inputSchema: z.object({
        code: z
          .string()
          .describe(
            "JavaScript code to execute, the code is effectively executed in `async () => { ... }` closure",
          ),
      }),
      outputSchema: z.object({
        result: z.unknown().describe("The result of the executed code"),
        logs: z.array(z.string()).describe("Logs from the executed code"),
        error: z.unknown().describe("Errors thrown from the executed code, if any"),
      }),
    },
    async ({ code }, { sessionId }) => {
      logger.info(`Running execute tool`, { sessionId, code });

      const tools = await params.getRuntimeTools();

      const result = await params.executionEnvironment
        .execute({ code, tools })
        .catch(
          (e) => ({ success: false, logs: [], error: serializeError(e) }) as MetaMcpExecutionResult,
        );

      if (result.success === false) {
        logger.error(`Execute tool failed`, { sessionId, error: result.error });
        return {
          isError: true,
          content: [{ text: JSON.stringify(result, null, 2), type: "text" }],
          structuredContent: result,
        };
      }

      logger.info(`Execute tool completed`, { sessionId, result: result.result });
      return {
        isError: false,
        content: [{ text: JSON.stringify(result, null, 2), type: "text" }],
        structuredContent: result,
      };
    },
  );

  return MetaMCPServer;
}
