import { DynamicWorkerExecutor, type ResolvedProvider } from "@cloudflare/codemode";
import { resolveProvider } from "@cloudflare/codemode/ai";
import {
  StreamSocketAppendFrame,
  StreamSocketFrame,
  type EventInput as EventInputValue,
} from "@iterate-com/events-contract";
import { Agent, type Connection, type WSMessage } from "agents";
import { z } from "zod";
import { createMcpToolProviders } from "~/lib/mcp-tool-providers.ts";
import { createOpenApiToolProvider } from "~/lib/openapi-tool-provider.ts";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";

const publicMcpServers = [
  { name: "cloudflare-docs", url: "https://docs.mcp.cloudflare.com/mcp" },
  { name: "canuckduck", url: "https://mcp.canuckduck.ca/mcp" },
] as const;

const eventsProviderPromise = createOpenApiToolProvider({
  name: "events",
  spec: "https://events.iterate.com/api/openapi.json",
  baseUrl: "https://events.iterate.com/api/",
}).then(resolveProvider) satisfies Promise<ResolvedProvider>;

const CodemodeBlockAddedEvent = z.object({
  type: z.literal("codemode-block-added"),
  payload: z.object({
    script: z.string(),
  }),
});

export class IterateAgent extends Agent<CloudflareEnv> {
  async onStart() {
    const existingUrls = new Set(this.mcp.listServers().map((server) => server.server_url));

    await Promise.allSettled(
      publicMcpServers
        .filter((server) => !existingUrls.has(server.url))
        .map((server) => this.addMcpServer(server.name, server.url)),
    );
  }

  async onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;

    const parsedFrame = StreamSocketFrame.safeParse(JSON.parse(message));
    if (!parsedFrame.success || parsedFrame.data.type !== "event") return;

    const parsedEvent = CodemodeBlockAddedEvent.safeParse(parsedFrame.data.event);
    if (!parsedEvent.success) return;

    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });
    const mcpProviders = await createMcpToolProviders({ mcp: this.mcp });
    const result = await executor.execute(parsedEvent.data.payload.script, [
      {
        name: "builtin",
        fns: {
          answer: async () => 42,
        },
      },
      await eventsProviderPromise,
      ...mcpProviders.map(resolveProvider),
    ]);

    connection.send(
      JSON.stringify(
        StreamSocketAppendFrame.parse({
          type: "append",
          event: {
            type: "codemode-result-added",
            payload: result,
          } satisfies EventInputValue,
        }),
      ),
    );
  }
}
