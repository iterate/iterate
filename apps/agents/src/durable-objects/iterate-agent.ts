import { resolveProvider } from "@cloudflare/codemode/ai";
import {
  ProjectSlug,
  StreamSocketAppendFrame,
  StreamSocketFrame,
} from "@iterate-com/events-contract";
import { parseAppConfig } from "@iterate-com/shared/apps/config";
import { Agent, type Connection, type WSMessage } from "agents";
import { AppConfig } from "~/app.ts";
import {
  createIterateAgentProcessor,
  iterateAgentProcessorInitialState,
  IterateAgentProcessorState,
} from "~/durable-objects/agent-processor.ts";
import { createOpenApiToolProvider } from "~/lib/openapi-tool-provider.ts";
import { getProjectUrl } from "~/lib/project-slug.ts";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";

const STREAM_PROCESSOR_STATE_KV_KEY = "iterate-agent:stream-processor-state";

export class IterateAgent extends Agent<CloudflareEnv> {
  #eventsCodemodeTools: Awaited<ReturnType<typeof resolveProvider>> | null = null;
  #streamProcessorState: IterateAgentProcessorState = iterateAgentProcessorInitialState;

  async onStart() {
    const t0 = Date.now();
    const log = this.#log.bind(this);
    log("onStart.begin", {});

    this.#streamProcessorState = loadStreamProcessorStateFromKv(this.ctx.storage.kv);
    log("onStart.kvStateLoaded", {
      blocksProcessed: this.#streamProcessorState.blocksProcessed,
      fresh: this.#streamProcessorState === iterateAgentProcessorInitialState,
    });

    const appConfig = parseAppConfig(AppConfig, this.env.APP_CONFIG);
    const eventsOrigin = getProjectUrl({
      currentUrl: appConfig.eventsBaseUrl,
      projectSlug: ProjectSlug.parse(appConfig.eventsProjectSlug),
    })
      .toString()
      .replace(/\/+$/, "");
    log("onStart.eventsOriginResolved", {
      eventsOrigin,
      projectSlug: appConfig.eventsProjectSlug,
    });

    const specUrl = new URL("/api/openapi.json", `${eventsOrigin}/`).toString();
    const specT0 = Date.now();
    const eventsProvider = await createOpenApiToolProvider({
      name: "events",
      spec: specUrl,
      baseUrl: new URL("/api/", `${eventsOrigin}/`).toString(),
    });
    this.#eventsCodemodeTools = await resolveProvider(eventsProvider);
    log("onStart.eventsOpenApiPreloaded", {
      specUrl,
      ms: Date.now() - specT0,
    });

    const existingUrls = new Set(this.mcp.listServers().map((server) => server.server_url));
    const toAdd = publicMcpServers.filter((server) => !existingUrls.has(server.url));
    log("onStart.mcpServersPlan", {
      existing: existingUrls.size,
      adding: toAdd.map((s) => s.name),
    });

    // `allSettled` intentionally — a single flaky public MCP server shouldn't block the DO
    // coming up. The processor's `waitForConnections` call at codemode-execute time gives
    // late restores a second chance. Failed `addMcpServer` calls are logged below.
    const mcpT0 = Date.now();
    const results = await Promise.allSettled(
      toAdd.map((server) => this.addMcpServer(server.name, server.url)),
    );
    results.forEach((result, i) => {
      const { name, url } = toAdd[i];
      if (result.status === "fulfilled") {
        log("onStart.mcpServerAdded", { name, url, state: result.value.state });
      } else {
        this.#logError("onStart.mcpServerFailed", {
          name,
          url,
          reason: stringifyError(result.reason),
        });
      }
    });
    log("onStart.mcpServersDone", { ms: Date.now() - mcpT0 });

    log("onStart.end", { totalMs: Date.now() - t0 });
  }

  /**
   * Inbound traffic on this socket is a mix of (a) Cloudflare Agents SDK protocol JSON
   * (`cf_agent_identity`, `cf_agent_state`, `cf_agent_mcp_servers`, …) and (b) our
   * stream contract (`StreamSocketFrame` in `@iterate-com/events-contract`). We only run
   * codemode when we receive a well-formed `{ type: "event", event: … }` frame; everything
   * else is ignored here so we never treat SDK chatter as stream input.
   *
   * The Events worker's outbound client (`handleSubscriberSocketMessage`) likewise ignores
   * unknown JSON from the peer, so we do not need `shouldSendProtocolMessages` or custom
   * upgrade headers to hide SDK frames from Events.
   *
   * URL shape: `{host}/agents/iterate-agent/{durable-object-name}` (see Agents SDK routing).
   */
  async onMessage(connection: Connection, message: WSMessage) {
    const t0 = Date.now();
    const log = this.#log.bind(this);

    const text = websocketMessageToString(message);
    if (text == null) {
      log("onMessage.skip", { reason: "binary-or-unknown-message-type" });
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      log("onMessage.skip", { reason: "invalid-json", len: text.length });
      return;
    }

    const frame = StreamSocketFrame.safeParse(json);
    if (!frame.success) {
      log("onMessage.skip", {
        reason: "not-stream-socket-frame",
        topLevelType:
          typeof json === "object" && json !== null ? (json as { type?: unknown }).type : undefined,
      });
      return;
    }
    if (frame.data.type !== "event") {
      log("onMessage.skip", { reason: "non-event-frame", frameType: frame.data.type });
      return;
    }
    const event = frame.data.event;
    const eventType = (event as { type?: string }).type;
    log("onMessage.eventReceived", { eventType, len: text.length });

    const processor = createIterateAgentProcessor({
      loader: this.env.LOADER,
      outboundFetch: this.env.CODEMODE_OUTBOUND_FETCH,
      mcp: this.mcp,
      eventsCodemodeTools: this.#eventsCodemodeTools,
      ai: this.env.AI,
    });

    const reduced = processor.reduce({ state: this.#streamProcessorState, event });
    if (reduced !== undefined) {
      this.ctx.storage.kv.put(STREAM_PROCESSOR_STATE_KV_KEY, reduced);
      this.#streamProcessorState = reduced;
      log("onMessage.stateReduced", {
        blocksProcessed: reduced.blocksProcessed,
      });
    } else {
      log("onMessage.stateUnchanged", { eventType });
    }

    const afterT0 = Date.now();
    await processor.afterAppend({
      event,
      state: this.#streamProcessorState,
      append: (input) => {
        // Narrowly-scoped append: wrap the processor's event into a stream-socket append
        // frame and push it over this connection. The processor never touches the WS itself.
        log("onMessage.append", { eventType: input.event.type });
        connection.send(
          JSON.stringify(
            StreamSocketAppendFrame.parse({
              type: "append",
              event: input.event,
            }),
          ),
        );
      },
    });
    log("onMessage.afterAppendDone", {
      eventType,
      afterAppendMs: Date.now() - afterT0,
      totalMs: Date.now() - t0,
    });
  }

  #log(event: string, fields: Record<string, unknown>) {
    console.info(JSON.stringify({ at: `IterateAgent.${event}`, name: this.name, ...fields }));
  }

  #logError(event: string, fields: Record<string, unknown>) {
    console.error(JSON.stringify({ at: `IterateAgent.${event}`, name: this.name, ...fields }));
  }
}

const publicMcpServers = [
  { name: "cloudflare-docs", url: "https://docs.mcp.cloudflare.com/mcp" },
  { name: "canuckduck", url: "https://mcp.canuckduck.ca/mcp" },
] as const;

function loadStreamProcessorStateFromKv(
  kv: DurableObjectState["storage"]["kv"],
): IterateAgentProcessorState {
  const stored = kv.get<unknown>(STREAM_PROCESSOR_STATE_KV_KEY);
  if (stored === undefined) return iterateAgentProcessorInitialState;
  // Corrupted projection is a bug we want loud: let the parse error escape the DO.
  return IterateAgentProcessorState.parse(stored);
}

function websocketMessageToString(message: WSMessage): string | null {
  if (typeof message === "string") return message;
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(message);
  if (ArrayBuffer.isView(message)) {
    const view = message as ArrayBufferView;
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  return null;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
