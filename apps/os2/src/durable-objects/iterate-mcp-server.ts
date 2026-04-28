import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { CodemodeExecutor } from "@iterate-com/shared/codemode/executor";
import { validateProviderPaths } from "@iterate-com/shared/codemode/validate";
import type { CodemodeEvent, ToolProvider } from "@iterate-com/shared/codemode/types";
import packageJson from "../../package.json" with { type: "json" };

export class IterateMcpServer extends McpAgent {
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
        const loader = (this.env as Record<string, unknown>).LOADER as WorkerLoader | undefined;
        if (!loader) {
          return {
            content: [{ type: "text" as const, text: "LOADER binding not available" }],
            isError: true,
          };
        }

        const blockId = `cblk_mcp_${crypto.randomUUID().slice(0, 8)}`;
        const logs: string[] = [];
        const toolCalls: string[] = [];

        const executor = new CodemodeExecutor({ loader });
        const result = await executor.execute({
          code,
          providers: [],
          blockId,
          onEvent: (event: CodemodeEvent) => {
            switch (event.type) {
              case "codemode-log-emitted":
                logs.push(`[${event.level}] ${event.message}`);
                break;
              case "codemode-tool-call-requested":
                toolCalls.push(`-> ${event.path.join(".")}(${JSON.stringify(event.payload)})`);
                break;
              case "codemode-tool-call-succeeded":
                toolCalls.push(`<- ${JSON.stringify(event.result)}`);
                break;
              case "codemode-tool-call-failed":
                toolCalls.push(`<! ${event.error}`);
                break;
            }
          },
        });

        const parts: string[] = [];
        if (logs.length > 0) parts.push(`Console:\n${logs.join("\n")}`);
        if (toolCalls.length > 0) parts.push(`Tool calls:\n${toolCalls.join("\n")}`);
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

export default {
  fetch() {
    return new Response("ok");
  },
} satisfies ExportedHandler;
