import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { resolveProvider } from "@cloudflare/codemode/ai";
import {
  ProjectSlug,
  StreamSocketAppendFrame,
  StreamSocketFrame,
  type EventInput as EventInputValue,
} from "@iterate-com/events-contract";
import { parseAppConfig } from "@iterate-com/shared/apps/config";
import { Agent, type Connection, type WSMessage } from "agents";
import { z } from "zod";
import { getProjectUrl } from "../../../events/src/lib/project-slug.ts";
import { AppConfig } from "~/app.ts";
import { createMcpToolProviders } from "~/lib/mcp-tool-providers.ts";
import { createOpenApiToolProvider } from "~/lib/openapi-tool-provider.ts";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";

const publicMcpServers = [
  { name: "cloudflare-docs", url: "https://docs.mcp.cloudflare.com/mcp" },
  { name: "canuckduck", url: "https://mcp.canuckduck.ca/mcp" },
] as const;

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
  #eventsCodemodeTools: Awaited<ReturnType<typeof resolveProvider>> | null = null;

  /**
   * Events sets `X-Iterate-Events-External-Subscriber` on the upgrade request. Without this,
   * Agents emit identity/state/MCP protocol JSON first; Events' outbound client only accepts
   * stream-socket frames and treats those as invalid.
   */
  shouldSendProtocolMessages(_connection: Connection, ctx: { request: Request }): boolean {
    return ctx.request.headers.get("X-Iterate-Events-External-Subscriber") !== "1";
  }

  async onStart() {
    const appConfig = parseAppConfig(AppConfig, this.env.APP_CONFIG);
    const eventsOrigin = getProjectUrl({
      currentUrl: appConfig.eventsBaseUrl,
      projectSlug: ProjectSlug.parse(appConfig.eventsProjectSlug),
    })
      .toString()
      .replace(/\/+$/, "");

    try {
      const eventsProvider = await createOpenApiToolProvider({
        name: "events",
        spec: new URL("/api/openapi.json", `${eventsOrigin}/`).toString(),
        baseUrl: new URL("/api/", `${eventsOrigin}/`).toString(),
      });
      this.#eventsCodemodeTools = await resolveProvider(eventsProvider);
    } catch (error) {
      console.error("[IterateAgent] events OpenAPI preload failed", error);
    }

    const existingUrls = new Set(this.mcp.listServers().map((server) => server.server_url));

    await Promise.allSettled(
      publicMcpServers
        .filter((server) => !existingUrls.has(server.url))
        .map((server) => this.addMcpServer(server.name, server.url)),
    );
  }

  async onMessage(connection: Connection, message: WSMessage) {
    const text = websocketMessageToString(message);
    if (text == null) return;

    const inbound = parseInboundEventMessage(text);
    if (inbound == null) return;

    const parsedEvent = CodemodeBlockAddedEvent.safeParse(inbound.event);
    if (!parsedEvent.success) return;

    let result: Awaited<ReturnType<DynamicWorkerExecutor["execute"]>>;
    try {
      const executor = new DynamicWorkerExecutor({
        loader: this.env.LOADER,
        globalOutbound: this.env.CODEMODE_OUTBOUND_FETCH,
      });
      const mcpProviders = await createMcpToolProviders({
        mcp: this.mcp,
        waitForConnectionsTimeout: 60_000,
      });
      const mcpResolved = await Promise.all(
        mcpProviders.map((provider) => resolveProvider(provider)),
      );
      const eventsTools = this.#eventsCodemodeTools;
      result = await executor.execute(parsedEvent.data.payload.script, [
        {
          name: "builtin",
          fns: {
            answer: async () => 42,
          },
        },
        ...(eventsTools ? [eventsTools] : []),
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

function websocketMessageToString(message: WSMessage): string | null {
  if (typeof message === "string") {
    return message;
  }
  if (message instanceof ArrayBuffer) {
    return new TextDecoder().decode(message);
  }
  if (ArrayBuffer.isView(message)) {
    const view = message as ArrayBufferView;
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  return null;
}
