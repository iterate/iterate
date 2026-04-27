import { resolveProvider } from "@cloudflare/codemode/ai";
import {
  type EventInput,
  ProjectSlug,
  StreamSocketAppendFrame,
  StreamSocketFrame,
} from "@iterate-com/events-contract";
import { parseAppConfig } from "@iterate-com/shared/apps/config";
import { Agent, type Connection, type WSMessage } from "agents";
import { AppConfig } from "~/app.ts";
import {
  AgentInputAddedEventInput,
  type AiChatRequest,
  LlmRequestCancelledEventInput,
  LlmRequestCompletedEventInput,
  LlmRequestStartedEventInput,
} from "~/durable-objects/agent-processor-types.ts";
import {
  buildLlmChatRequest,
  createIterateAgentProcessor,
  extractLlmAssistantText,
  IterateAgentProcessorState,
  type ProcessorRuntime,
} from "~/durable-objects/agent-processor.ts";
import { createOpenApiToolProvider } from "~/lib/openapi-tool-provider.ts";
import { getProjectUrl } from "~/lib/project-slug.ts";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";

const STREAM_PROCESSOR_STATE_KV_KEY = "iterate-agent:stream-processor-state";

/**
 * Two-stage in-memory tracking for a request:
 *
 * - `scheduled` while the debounce timer is arming. Cancelled by clearing the
 *   timer; no `ai.run` has been invoked yet.
 * - `running` once the timer fires and `ai.run` is actually in flight.
 *   `controller` is a best-effort abort signal (Workers AI may ignore it),
 *   so we additionally key on `requestId` to discard superseded results.
 */
type InflightLlmRequest =
  | { kind: "scheduled"; requestId: string; timer: ReturnType<typeof setTimeout> }
  | { kind: "running"; requestId: string; controller: AbortController };

export class IterateAgent extends Agent<CloudflareEnv> {
  #eventsCodemodeTools: Awaited<ReturnType<typeof resolveProvider>> | null = null;
  #processor!: ReturnType<typeof createIterateAgentProcessor>;
  #streamProcessorState: IterateAgentProcessorState = IterateAgentProcessorState.parse({});
  #inflight: InflightLlmRequest | null = null;
  #requestSeq = 0;

  async onStart() {
    const t0 = Date.now();
    const log = this.#log.bind(this);
    log("onStart.begin", {});

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

    this.#processor = createIterateAgentProcessor({
      loader: this.env.LOADER,
      outboundFetch: this.env.CODEMODE_OUTBOUND_FETCH,
      mcp: this.mcp,
      eventsCodemodeTools: this.#eventsCodemodeTools,
    });

    const stored = this.ctx.storage.kv.get<unknown>(STREAM_PROCESSOR_STATE_KV_KEY);
    const fresh = stored === undefined;
    this.#streamProcessorState = fresh
      ? (structuredClone(this.#processor.initialState) as IterateAgentProcessorState)
      : IterateAgentProcessorState.parse(stored);
    log("onStart.kvStateLoaded", {
      historyLength: this.#streamProcessorState.history.length,
      fresh,
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

    const reduced = this.#processor.reduce({ state: this.#streamProcessorState, event });
    if (reduced !== undefined) {
      this.ctx.storage.kv.put(STREAM_PROCESSOR_STATE_KV_KEY, reduced);
      this.#streamProcessorState = reduced;
      log("onMessage.stateReduced", {
        historyLength: reduced.history.length,
      });
    } else {
      log("onMessage.stateUnchanged", { eventType });
    }

    const afterT0 = Date.now();
    await this.#processor.afterAppend({
      event,
      state: this.#streamProcessorState,
      append: (input) => this.#appendToStream({ event: input.event, log }),
      runtime: this.#runtime(),
    });
    log("onMessage.afterAppendDone", {
      eventType,
      afterAppendMs: Date.now() - afterT0,
      totalMs: Date.now() - t0,
    });
  }

  /**
   * Append a single event back over the connected websockets so the events
   * server records and re-broadcasts it. Used both from `afterAppend` and from
   * the async LLM runner (where there is no specific `connection` to reply on,
   * so we broadcast).
   */
  #appendToStream(args: {
    event: EventInput;
    log?: (event: string, fields: Record<string, unknown>) => void;
  }) {
    const frame = JSON.stringify(
      StreamSocketAppendFrame.parse({
        type: "append",
        event: args.event,
      }),
    );
    args.log?.("appendToStream", { eventType: args.event.type });
    this.broadcast(frame);
  }

  /**
   * Synchronous view of "what is this DO actually executing right now", plus
   * the levers used by the processor to schedule/cancel runs. See
   * {@link ProcessorRuntime} in `agent-processor.ts`.
   */
  #runtime(): ProcessorRuntime {
    return {
      inflight: () =>
        this.#inflight === null
          ? null
          : { requestId: this.#inflight.requestId, status: this.#inflight.kind },
      scheduleLlmRequest: ({ debounceMs }) => {
        const requestId = this.#mintRequestId();
        this.#armDebounceTimer({ requestId, debounceMs });
        this.#log("runtime.scheduleLlmRequest", { requestId, debounceMs });
        return { requestId };
      },
      extendDebounce: ({ requestId, debounceMs }) => {
        // Defence-in-depth: if the timer just fired (state transitioned to
        // `running`) or was cancelled, the extend is meaningless. Drop it.
        if (this.#inflight?.kind !== "scheduled" || this.#inflight.requestId !== requestId) {
          this.#log("runtime.extendDebounce.skip", {
            requestId,
            reason: this.#inflight === null ? "no-inflight" : "not-scheduled",
          });
          return;
        }
        clearTimeout(this.#inflight.timer);
        this.#armDebounceTimer({ requestId, debounceMs });
        this.#log("runtime.extendDebounce", { requestId, debounceMs });
      },
      cancelLlmRequest: ({ requestId }) => {
        if (this.#inflight?.requestId !== requestId) {
          this.#log("runtime.cancelLlmRequest.skip", { requestId, reason: "not-inflight" });
          return;
        }
        this.#log("runtime.cancelLlmRequest", { requestId, kind: this.#inflight.kind });
        if (this.#inflight.kind === "scheduled") {
          clearTimeout(this.#inflight.timer);
        } else {
          this.#inflight.controller.abort();
        }
        this.#inflight = null;
      },
      armCancelDeadline: ({ requestId, withinMs }) => {
        // Drives `trigger-request-within-time-period`. If the request is
        // still running when the deadline fires, we abort it and emit
        // `llm-request-cancelled` ourselves — the original `afterAppend`
        // callstack is long gone, so there's no `append` to hand back to.
        // Best-effort: the timer is not tracked or cleared on natural
        // settlement; the `requestId` check makes it a no-op in that case.
        setTimeout(() => {
          if (this.#inflight?.requestId !== requestId || this.#inflight.kind !== "running") {
            this.#log("runtime.armCancelDeadline.fired.no-op", {
              requestId,
              reason: this.#inflight === null ? "no-inflight" : "not-running",
            });
            return;
          }
          this.#log("runtime.armCancelDeadline.fired.cancel", { requestId, withinMs });
          this.#inflight.controller.abort();
          this.#inflight = null;
          this.#appendToStream({
            event: LlmRequestCancelledEventInput.parse({
              type: "llm-request-cancelled",
              payload: { requestId, reason: "deadline-exceeded" },
            }),
          });
        }, withinMs);
      },
    };
  }

  /**
   * Arm the debounce timer for the given request and pin `#inflight` to the
   * resulting `scheduled` slot. `setTimeout` is safe here because the DO is
   * kept alive by the open websocket connection that delivered the trigger;
   * if the DO recycles mid-debounce the request silently drops, which is the
   * correct best-effort behavior.
   */
  #armDebounceTimer(args: { requestId: string; debounceMs: number }) {
    const { requestId, debounceMs } = args;
    const timer = setTimeout(() => {
      this.ctx.waitUntil(this.#fireLlmRequest({ requestId }));
    }, debounceMs);
    this.#inflight = { kind: "scheduled", requestId, timer };
  }

  /**
   * Called when the debounce timer fires. Transitions the in-memory slot from
   * `scheduled` → `running`, appends `llm-request-started`, then runs `ai.run`
   * to settle.
   *
   * Bails if `#inflight` no longer references this `requestId` — that means
   * the request was cancelled (or replaced) between the timer being armed and
   * the timer firing. `cancelLlmRequest` clears the timer in the
   * `interrupt-current-request` path so this should be rare in practice;
   * the check is defence-in-depth.
   */
  async #fireLlmRequest(args: { requestId: string }) {
    const { requestId } = args;
    if (this.#inflight?.requestId !== requestId || this.#inflight.kind !== "scheduled") {
      this.#log("fireLlmRequest.superseded", { requestId });
      return;
    }
    const controller = new AbortController();
    this.#inflight = { kind: "running", requestId, controller };
    const stateAtStart = this.#streamProcessorState;
    // Build the chat request once and thread it through both the wire-log
    // event and the actual `ai.run` call. This way the `llm-request-started`
    // payload reflects exactly what was sent, with no risk of drift from
    // calling `buildLlmChatRequest` twice on slightly different inputs.
    const body = buildLlmChatRequest(stateAtStart);
    this.#appendToStream({
      event: LlmRequestStartedEventInput.parse({
        type: "llm-request-started",
        payload: {
          requestId,
          model: stateAtStart.llmConfig.model,
          body,
          runOpts: stateAtStart.llmConfig.runOpts,
        },
      }),
    });
    await this.#runLlmRequestUntilSettled({ requestId, controller, stateAtStart, body });
  }

  #mintRequestId(): string {
    this.#requestSeq += 1;
    // Combines the DO's instance name with a monotonic counter so that ids are
    // both unique-per-DO and easy to recognize in stream dumps.
    return `req_${this.name}_${this.#requestSeq}`;
  }

  /**
   * Drives a single LLM request through to a terminal event:
   * - `agent-input-added` (role: assistant) + `llm-request-completed` on success
   * - nothing on cancel (the cancellation event was already appended by the
   *   processor that called `cancelLlmRequest`)
   * - `llm-request-completed` with empty assistant text on error (TEMP — until
   *   we add a dedicated error event type)
   */
  async #runLlmRequestUntilSettled(args: {
    requestId: string;
    controller: AbortController;
    stateAtStart: IterateAgentProcessorState;
    body: AiChatRequest;
  }) {
    const { requestId, controller, stateAtStart, body } = args;
    const t0 = Date.now();
    try {
      const raw = await this.env.AI.run(
        stateAtStart.llmConfig.model as never,
        body as never,
        stateAtStart.llmConfig.runOpts as never,
      );
      if (controller.signal.aborted || this.#inflight?.requestId !== requestId) {
        this.#log("runLlmRequest.discardSettledAfterCancel", {
          requestId,
          ms: Date.now() - t0,
        });
        return;
      }
      const text = extractLlmAssistantText(raw);
      this.#inflight = null;
      this.#appendToStream({
        event: AgentInputAddedEventInput.parse({
          type: "agent-input-added",
          payload: {
            role: "assistant",
            content: text,
            triggerLlmRequest: { behaviour: "dont-trigger-request" },
          },
        }),
      });
      const durationMs = Date.now() - t0;
      this.#appendToStream({
        event: LlmRequestCompletedEventInput.parse({
          type: "llm-request-completed",
          payload: { requestId, rawResponse: raw, durationMs },
        }),
      });
      this.#log("runLlmRequest.completed", { requestId, ms: durationMs });
    } catch (error) {
      if (this.#inflight?.requestId === requestId) this.#inflight = null;
      this.#logError("runLlmRequest.failed", {
        requestId,
        ms: Date.now() - t0,
        error: stringifyError(error),
      });
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/__debug.yaml")) {
      return new Response(stringifyYaml(this.#streamProcessorState), {
        headers: debugHeaders("text/yaml; charset=utf-8"),
      });
    }
    if (url.pathname.endsWith("/__debug")) {
      return new Response(renderDebugHtml({ agentName: this.name }), {
        headers: debugHeaders("text/html; charset=utf-8"),
      });
    }
    return new Response("Not found", { status: 404 });
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

function debugHeaders(contentType: string): HeadersInit {
  return {
    "content-type": contentType,
    "cache-control": "no-store, no-cache, must-revalidate",
  };
}

function renderDebugHtml(args: { agentName: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(args.agentName)} debug</title>
    <style>
      :root {
        color-scheme: dark;
      }
      body {
        margin: 0;
        background: #0b1020;
        color: #dbe4ff;
        font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }
      main {
        padding: 16px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 14px;
      }
      p {
        margin: 0 0 12px;
        color: #9fb0e3;
      }
      pre {
        margin: 0;
        padding: 16px;
        overflow: auto;
        border: 1px solid #24304f;
        border-radius: 8px;
        background: #11182b;
        white-space: pre-wrap;
        word-break: break-word;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(args.agentName)} /__debug</h1>
      <p>Refreshing every 100ms.</p>
      <pre id="state">Loading...</pre>
    </main>
    <script>
      const pre = document.getElementById("state");
      const yamlUrl = new URL(window.location.href);
      yamlUrl.pathname = yamlUrl.pathname.replace(/\\/__debug$/, "/__debug.yaml");

      async function refresh() {
        try {
          const response = await fetch(yamlUrl, { cache: "no-store" });
          pre.textContent = await response.text();
        } catch (error) {
          pre.textContent = String(error);
        } finally {
          window.setTimeout(refresh, 100);
        }
      }

      refresh();
    </script>
  </body>
</html>`;
}

function stringifyYaml(value: unknown): string {
  return `${yamlLines(value, 0).join("\n")}\n`;
}

function yamlLines(value: unknown, indent: number): string[] {
  const prefix = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}[]`];
    return value.flatMap((item) => {
      if (isScalar(item)) {
        return scalarLines({ prefix: `${prefix}- `, scalar: item });
      }
      const nested = yamlLines(item, indent + 2);
      return [`${prefix}-`, ...nested];
    });
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${prefix}{}`];
    return entries.flatMap(([key, entryValue]) => {
      const yamlKey = formatYamlKey(key);
      if (isScalar(entryValue)) {
        return scalarLines({ prefix: `${prefix}${yamlKey}: `, scalar: entryValue });
      }
      const nested = yamlLines(entryValue, indent + 2);
      return [`${prefix}${yamlKey}:`, ...nested];
    });
  }
  return [`${prefix}${formatYamlScalar(value)}`];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function formatYamlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function formatYamlScalar(value: string | number | boolean | null | unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return JSON.stringify(value);
  if (value.length === 0) return '""';
  return JSON.stringify(value);
}

function scalarLines(args: { prefix: string; scalar: string | number | boolean | null }): string[] {
  if (typeof args.scalar !== "string" || !args.scalar.includes("\n")) {
    return [`${args.prefix}${formatYamlScalar(args.scalar)}`];
  }
  const indent = " ".repeat(args.prefix.length);
  return [`${args.prefix}|-`, ...args.scalar.split("\n").map((line) => `${indent}${line}`)];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
