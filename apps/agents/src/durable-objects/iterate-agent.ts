import { DynamicWorkerExecutor } from "@cloudflare/codemode";
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

const eventsCodemodeTools = createOpenApiToolProvider({
  name: "events",
  spec: "https://events.iterate.com/api/openapi.json",
  baseUrl: "https://events.iterate.com/api/",
}).then(resolveProvider);

const CodemodeBlockAddedEvent = z.object({
  type: z.literal("codemode-block-added"),
  payload: z.object({
    script: z.string(),
  }),
});

const LooseStreamSocketEventFrame = z.strictObject({
  type: z.literal("event"),
  event: z.unknown(),
});

/**
 * `StreamSocketFrame` requires a full `Event` (streamPath, offset, …). Production
 * `events.iterate.com` sends that; local CLI probes often send only `{ type, payload }`.
 */
function parseInboundEventMessage(message: string): { event: unknown } | null {
  let json: unknown;
  try {
    json = JSON.parse(message);
  } catch {
    return null;
  }

  const strict = StreamSocketFrame.safeParse(json);
  if (strict.success && strict.data.type === "event") {
    return { event: strict.data.event };
  }

  const loose = LooseStreamSocketEventFrame.safeParse(json);
  if (!loose.success) {
    return null;
  }

  return { event: loose.data.event };
}

export class IterateAgent extends Agent<CloudflareEnv> {
  async onStart() {
    void eventsCodemodeTools.catch((error) => {
      console.error("[IterateAgent] events OpenAPI preload failed", error);
    });

    const existingUrls = new Set(this.mcp.listServers().map((server) => server.server_url));

    await Promise.allSettled(
      publicMcpServers
        .filter((server) => !existingUrls.has(server.url))
        .map((server) => this.addMcpServer(server.name, server.url)),
    );
  }

  async onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;

    const inbound = parseInboundEventMessage(message);
    if (inbound == null) return;

    const parsedEvent = CodemodeBlockAddedEvent.safeParse(inbound.event);
    if (!parsedEvent.success) return;

    let result: Awaited<ReturnType<DynamicWorkerExecutor["execute"]>>;
    try {
      const executor = new DynamicWorkerExecutor({
        loader: this.env.LOADER,
        globalOutbound: this.env.CODEMODE_OUTBOUND_FETCH,
      });
      const mcpProviders = await createMcpToolProviders({ mcp: this.mcp });
      const mcpResolved = await Promise.all(
        mcpProviders.map((provider) => resolveProvider(provider)),
      );
      result = await executor.execute(parsedEvent.data.payload.script, [
        {
          name: "builtin",
          fns: {
            answer: async () => 42,
          },
        },
        await eventsCodemodeTools,
        ...mcpResolved,
      ]);
    } catch (error) {
      result = {
        result: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }

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
