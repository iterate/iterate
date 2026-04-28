import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { CodemodeExecutor } from "@iterate-com/shared/codemode/executor";
import packageJson from "../../package.json" with { type: "json" };

/**
 * MCP server for os2, exposed at /mcp on the main worker.
 *
 * Runs as a Durable Object in a separate Worker (`iterate-mcp-server-do`)
 * with its own LOADER binding for sandboxed code execution.
 *
 * Tools:
 * - run_code: Execute JavaScript in an isolated dynamic worker sandbox
 */

interface McpServerEnv {
  LOADER: WorkerLoader;
  ITERATE_MCP_SERVER: DurableObjectNamespace;
}

export class IterateMcpServer extends McpAgent<McpServerEnv> {
  server = new McpServer({
    name: "os2",
    version: packageJson.version,
  });

  async init() {
    this.server.registerTool(
      "run_code",
      {
        title: "Run code",
        description:
          "Execute JavaScript code in an isolated sandbox. " +
          "Write an async arrow function that returns a result. " +
          'Example: async () => { console.log("hello"); return 1 + 1; }',
        inputSchema: z.object({
          code: z.string().describe("JavaScript async arrow function to execute"),
        }),
      },
      async ({ code }) => {
        if (!this.env.LOADER) {
          return {
            content: [{ type: "text" as const, text: "LOADER binding not available" }],
            isError: true,
          };
        }

        const blockId = `cblk_mcp_${crypto.randomUUID().slice(0, 8)}`;
        const logs: string[] = [];

        const executor = new CodemodeExecutor({ loader: this.env.LOADER });
        const result = await executor.execute({
          code,
          providers: [],
          blockId,
          onEvent: (event) => {
            if (event.type === "codemode-log-emitted") {
              logs.push(`[${event.level}] ${event.message}`);
            }
          },
        });

        const parts: string[] = [];
        if (logs.length > 0) parts.push(`Console:\n${logs.join("\n")}`);
        if (result.error) {
          parts.push(`Error: ${result.error}`);
        } else {
          parts.push(`Result: ${JSON.stringify(result.result, null, 2)}`);
        }

        return {
          content: [{ type: "text" as const, text: parts.join("\n\n") }],
          isError: !!result.error,
        };
      },
    );
  }
}

/** Health-check handler for direct worker invocations (not via DO). */
export default {
  fetch() {
    return new Response("ok");
  },
} satisfies ExportedHandler;
