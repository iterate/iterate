import OpenAI from "openai";
import type { ResponsesClientEvent } from "openai/resources/responses/responses";
import { ResponsesWSBase } from "openai/resources/responses/ws-base";
import { z } from "zod";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withStreamProcessor } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor";
import { createAgentChatProcessor } from "@iterate-com/shared/stream-processors/agent-chat/implementation";
import { createAgentProcessor } from "@iterate-com/shared/stream-processors/agent/implementation";
import {
  type CloudflareAiProcessorDeps,
  createCloudflareAiProcessor,
} from "@iterate-com/shared/stream-processors/cloudflare-ai/implementation";
import {
  createOpenAiWsProcessor,
  type OpenAiResponsesWebSocket,
  type OpenAiResponsesWebSocketStreamMessage,
} from "@iterate-com/shared/stream-processors/openai-ws/implementation";
import { createJsonataReactorProcessor } from "@iterate-com/shared/stream-processors/jsonata-reactor/implementation";
import type { ProcessorStreamApi, StreamEvent } from "@iterate-com/shared/stream-processors";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers";
import type { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import { STREAM_CHILD_STREAM_CREATED_TYPE } from "@iterate-com/shared/streams/core-event-types";
import type { Event, EventInput, StreamCursor } from "@iterate-com/shared/streams/types";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { AppConfig } from "~/app.ts";
import {
  createCodemodeSession,
  startCodemodeScriptOnSession,
} from "~/domains/codemode/codemode-session-rpc.ts";
import type { CodemodeSession } from "~/domains/codemode/durable-objects/codemode-session.ts";
import { resolveStreamPath } from "~/domains/streams/entrypoints/streams-capability.ts";

export const AGENTS_STREAM_PATH = StreamPath.parse("/agents");

export type AgentDurableObjectStructuredName = {
  agentPath: StreamPath;
  projectId: string;
};

const AgentDurableObjectStructuredName = z.object({
  agentPath: StreamPath,
  projectId: z.string().trim().min(1),
});

export function getAgentDurableObjectName(input: AgentDurableObjectStructuredName) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: input,
  });
}

export type AgentDurableObjectEnv = {
  AGENT: DurableObjectNamespace<AgentDurableObject>;
  AI: CloudflareAiProcessorDeps["ai"];
  APP_CONFIG: string;
  CODEMODE_SESSION: DurableObjectNamespace<CodemodeSession>;
  DO_CATALOG: D1Database;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

type AgentStreamApi = ProcessorStreamApi<{
  emits: readonly string[];
  events: Record<string, unknown>;
  processorDeps?: readonly unknown[];
}> & {
  append(args: { event: EventInput; streamPath?: string }): Promise<Event>;
  read(args?: {
    streamPath?: string;
    afterOffset?: StreamCursor;
    beforeOffset?: StreamCursor;
  }): Promise<Event[]>;
};

const AgentLifecycleBase = createIterateDurableObjectBase<
  typeof AgentDurableObjectStructuredName,
  Pick<AgentDurableObjectEnv, "DO_CATALOG">
>({
  className: "AgentDurableObject",
  getDatabase: (env) => env.DO_CATALOG,
  indexes: {
    agentPath: (params) => params.agentPath,
    projectId: (params) => params.projectId,
  },
  nameSchema: AgentDurableObjectStructuredName,
});

const AgentBase = withStreamProcessor<AgentDurableObjectStructuredName, AgentDurableObjectEnv>({
  streamApi(args) {
    return agentStreamApiFromNamespace({
      durableObjectNamespace: args.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: args.structuredName.projectId,
      streamPath: StreamPath.parse(String(args.streamPath)),
    });
  },
})(AgentLifecycleBase);

export class AgentDurableObject extends AgentBase<AgentDurableObjectEnv> {
  constructor(ctx: DurableObjectState, env: AgentDurableObjectEnv) {
    super(ctx, env);

    this.registerOnInstanceWake(async (params) => {
      if (params.agentPath === AGENTS_STREAM_PATH) {
        this.registerStreamProcessor(createJsonataReactorProcessor());
      } else {
        this.registerStreamProcessor(createAgentChatProcessor());
        this.registerStreamProcessor(
          createAgentProcessor({
            waitUntil: (promise) => this.waitUntilStreamProcessor(promise),
          }),
        );
        this.registerStreamProcessor(this.createDefaultLlmProcessor());
        await this.ensureCodemodeSession(params);
      }
      await this.ensureAgentSubscription(params);
      await this.catchUpStreamProcessors({
        signal: AbortSignal.timeout(30_000),
        streamPath: params.agentPath,
      });
    });
  }

  async afterAppend(input: { event: Event }) {
    await this.ensureStarted();
    const state = await this.consumeStreamProcessorEvent({ event: input.event as StreamEvent });
    await this.ensureChildAgentRunner(input.event);
    await this.handleAgentOutputAddedForCodemode(input.event);
    await this.handleCodemodeScriptExecutionCompleted(input.event);
    return state;
  }

  async getRuntimeState() {
    await this.ensureStarted();
    return this.getStreamProcessorRuntimeState();
  }

  async sendMessage(input: { message: string; channel?: string }) {
    const params = await this.ensureStarted();
    const event = await this.streamsEntrypoint(params.agentPath).append({
      event: {
        type: "events.iterate.com/agent-chat/user-message-added",
        payload: {
          channel: parseAgentChatChannel(input.channel),
          content: input.message,
        },
      },
    });
    return { event };
  }

  async doThing(input: { label: string; value: number }) {
    await this.ensureStarted();
    return {
      agentName: this.name,
      label: input.label,
      value: input.value,
      doubled: input.value * 2,
    };
  }

  private async ensureAgentSubscription(params: AgentDurableObjectStructuredName) {
    await this.ensureStreamProcessorCallableSubscription({
      bindingName: "AGENT",
      durableObjectName: this.name,
      slug: `agent:${params.projectId}:${params.agentPath}`,
      streamPath: params.agentPath,
    });
  }

  private async ensureChildAgentRunner(event: Event) {
    if (this.structuredName.agentPath !== AGENTS_STREAM_PATH) return;
    if (event.type !== STREAM_CHILD_STREAM_CREATED_TYPE) return;

    const payload = event.payload as { childPath?: unknown };
    const childPath = StreamPath.safeParse(payload.childPath);
    if (!childPath.success) return;

    const name = getAgentDurableObjectName({
      agentPath: childPath.data,
      projectId: this.structuredName.projectId,
    });
    const stub = this.env.AGENT.getByName(name);
    await stub.initialize({ name });
  }

  private async ensureCodemodeSession(params: AgentDurableObjectStructuredName) {
    await createCodemodeSession({
      events: [],
      namespace: this.env.CODEMODE_SESSION,
      projectId: params.projectId,
      providers: [],
      streamPath: params.agentPath,
    });
  }

  private async handleAgentOutputAddedForCodemode(event: Event) {
    if (this.structuredName.agentPath === AGENTS_STREAM_PATH) return;
    if (event.type !== "events.iterate.com/agent/output-added") return;

    const payload = event.payload as { content?: unknown };
    if (typeof payload.content !== "string") return;

    const code = extractCodemodeScript(payload.content);
    if (code == null) return;

    await startCodemodeScriptOnSession({
      code,
      events: [],
      namespace: this.env.CODEMODE_SESSION,
      projectId: this.structuredName.projectId,
      providers: [],
      streamPath: this.structuredName.agentPath,
    });
  }

  private async handleCodemodeScriptExecutionCompleted(event: Event) {
    if (this.structuredName.agentPath === AGENTS_STREAM_PATH) return;
    if (event.type !== "events.iterate.com/codemode/script-execution-completed") return;

    const payload = event.payload as {
      outcome?: unknown;
      scriptExecutionId?: unknown;
    };
    const outcome = payload.outcome;
    if (outcome == null || typeof outcome !== "object") return;

    const status = "status" in outcome ? outcome.status : undefined;
    if (status === "succeeded") {
      const output = "output" in outcome ? outcome.output : undefined;
      if (output === undefined) return;
      await this.appendAssistantResponse({
        idempotencyKey: `agent-codemode-script-result:${String(payload.scriptExecutionId)}`,
        message: formatCodemodeOutput(output),
      });
      return;
    }

    if (status === "failed") {
      const error = "error" in outcome ? outcome.error : "Unknown codemode error";
      await this.appendAssistantResponse({
        idempotencyKey: `agent-codemode-script-error:${String(payload.scriptExecutionId)}`,
        message: `Codemode failed: ${formatCodemodeOutput(error)}`,
      });
    }
  }

  private async appendAssistantResponse(input: { idempotencyKey: string; message: string }) {
    await this.streamsEntrypoint(this.structuredName.agentPath).append({
      event: {
        type: "events.iterate.com/agent-chat/assistant-response-added",
        idempotencyKey: input.idempotencyKey,
        payload: {
          channel: "web",
          message: input.message,
        },
      },
    });
  }

  private createDefaultLlmProcessor() {
    const config = this.getAppConfig();
    const apiKey = config.openAiApiKey.exposeSecret();
    if (apiKey.trim() !== "") {
      return createOpenAiWsProcessor({
        openResponsesWebSocket: async () =>
          createOpenAiResponsesWebSocketClient(new OpenAI({ apiKey })),
      });
    }

    return createCloudflareAiProcessor({
      ai: this.env.AI,
    });
  }

  private streamsEntrypoint(streamPath: StreamPath) {
    return agentStreamApiFromNamespace({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: this.structuredName.projectId,
      streamPath,
    });
  }

  private getAppConfig() {
    return parseAppConfigFromEnv({
      configSchema: AppConfig,
      prefix: "APP_CONFIG_",
      env: this.env as unknown as Record<string, unknown>,
    });
  }
}

function agentStreamApiFromNamespace(args: {
  durableObjectNamespace: StreamDurableObjectNamespace;
  namespace: string;
  streamPath: StreamPath;
}): AgentStreamApi {
  return {
    async append(input) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.append(input.event);
    },
    async read(input = {}) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.history({
        after: input.afterOffset,
        before: input.beforeOffset ?? "end",
      });
    },
    async *subscribe(input = {}) {
      void input;
      yield* [];
      throw new Error("Agent processors receive live events through afterAppend RPC.");
    },
  };
}

function resolveProcessorStreamPath(input: { basePath: StreamPath; pathInput?: string }) {
  if (input.pathInput == null) {
    return input.basePath;
  }

  const trimmedPath = input.pathInput.trim();
  if (!trimmedPath) {
    throw new Error("Stream path is required.");
  }

  if (trimmedPath.startsWith("/")) {
    return resolveStreamPath(trimmedPath);
  }

  const relativePath = trimmedPath.replace(/^\.\//, "").replace(/^\/+/, "");
  return StreamPath.parse(
    input.basePath === "/" ? `/${relativePath}` : `${input.basePath}/${relativePath}`,
  );
}

const CODEMODE_FENCE_RE = /^```(?:js|javascript|codemode|ts|typescript)\s*\n([\s\S]*?)\n```\s*$/;

function extractCodemodeScript(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.startsWith("async (ctx) => {") && trimmed.endsWith("}")) {
    return trimmed;
  }

  if (trimmed.startsWith("async () => {") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = CODEMODE_FENCE_RE.exec(trimmed);
  return fenced?.[1]?.trim() || null;
}

function formatCodemodeOutput(output: unknown) {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function parseAgentChatChannel(channel: string | undefined) {
  return channel === "tui" ? "tui" : "web";
}

type CloudflareSocketEventName = "open" | "message" | "close" | "error" | string;
type JsonValue = z.infer<ReturnType<typeof z.json>>;

function createOpenAiResponsesWebSocketClient(client: OpenAI): OpenAiResponsesWebSocket {
  const sdkWebSocket = new CloudflareResponsesWebSocket(client);

  return {
    get url() {
      return sdkWebSocket.url;
    },
    get socket() {
      return sdkWebSocket.socket;
    },
    send(event) {
      sdkWebSocket.send(event as unknown as ResponsesClientEvent);
    },
    stream() {
      return streamOpenAiResponsesWebSocket(sdkWebSocket);
    },
    close(props) {
      sdkWebSocket.close(props);
    },
  };
}

async function* streamOpenAiResponsesWebSocket(
  sdkWebSocket: CloudflareResponsesWebSocket,
): AsyncIterableIterator<OpenAiResponsesWebSocketStreamMessage> {
  for await (const event of sdkWebSocket.stream()) {
    switch (event.type) {
      case "connecting":
      case "open":
      case "closing":
      case "reconnected":
        yield { type: event.type };
        break;
      case "close":
        yield { type: "close", code: event.code, reason: event.reason };
        break;
      case "reconnecting":
        yield { type: "reconnecting", reconnect: toJsonValue(event.reconnect) };
        break;
      case "message":
        yield { type: "message", message: toJsonValue(event.message) };
        break;
      case "raw":
        yield { type: "raw", data: event.data };
        break;
      case "error":
        yield { type: "error", error: event.error };
        break;
      default:
        event satisfies never;
    }
  }
}

function toJsonValue(value: unknown): JsonValue {
  return z.json().parse(value);
}

class CloudflareResponsesWebSocket extends ResponsesWSBase<CloudflareFetchWebSocket> {
  constructor(client: OpenAI) {
    super(client, { reconnect: null });
    this._connectInitial();
  }

  protected _createSocket(url: URL, authHeaders: Record<string, string>): CloudflareFetchWebSocket {
    return new CloudflareFetchWebSocket(url, {
      ...authHeaders,
      "OpenAI-Beta": "responses_websockets=2026-02-06",
    });
  }
}

class CloudflareFetchWebSocket {
  #listeners = new Map<CloudflareSocketEventName, Set<unknown>>();
  #onceListeners = new Map<CloudflareSocketEventName, Map<unknown, unknown>>();
  #readyState = 0;
  #socket: WebSocket | undefined;

  constructor(
    private readonly url: URL,
    private readonly authHeaders: Record<string, string>,
  ) {
    void this.#connect();
  }

  get readyState(): number {
    return this.#socket?.readyState ?? this.#readyState;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.#socket == null) throw new Error("OpenAI WebSocket is not open.");
    this.#socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#readyState = 2;
    this.#socket?.close(code, reason);
  }

  on(event: "open", listener: () => void): void;
  on(
    event: "message",
    listener: (data: string | ArrayBuffer | ArrayBufferView, isBinary: boolean) => void,
  ): void;
  on(event: "close", listener: (code: number, reason: string) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: CloudflareSocketEventName, listener: (...args: never[]) => void): void;
  on(event: CloudflareSocketEventName, listener: unknown): void {
    this.#listenersFor(event).add(listener);
  }

  off(event: "open", listener: () => void): void;
  off(
    event: "message",
    listener: (data: string | ArrayBuffer | ArrayBufferView, isBinary: boolean) => void,
  ): void;
  off(event: "close", listener: (code: number, reason: string) => void): void;
  off(event: "error", listener: (error: Error) => void): void;
  off(event: CloudflareSocketEventName, listener: (...args: never[]) => void): void;
  off(event: CloudflareSocketEventName, listener: unknown): void {
    this.#removeListener(event, listener);
  }

  once(event: "open", listener: () => void): void;
  once(
    event: "message",
    listener: (data: string | ArrayBuffer | ArrayBufferView, isBinary: boolean) => void,
  ): void;
  once(event: "close", listener: (code: number, reason: string) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: CloudflareSocketEventName, listener: (...args: never[]) => void): void;
  once(event: CloudflareSocketEventName, listener: unknown): void {
    const onceListener = (...args: never[]) => {
      this.#removeListener(event, listener);
      (listener as (...args: never[]) => void)(...args);
    };
    this.#onceListenersFor(event).set(listener, onceListener);
    this.on(event, onceListener);
  }

  get socket(): { readonly readyState: number } {
    return { readyState: this.readyState };
  }

  async #connect() {
    try {
      const response = (await fetch(this.url.toString().replace("wss://", "https://"), {
        headers: {
          ...this.authHeaders,
          Upgrade: "websocket",
        },
      })) as Response & { webSocket?: WebSocket | null };

      if (response.webSocket == null) {
        throw new Error(`OpenAI WebSocket upgrade failed with status ${response.status}.`);
      }

      this.#socket = response.webSocket;
      this.#socket.accept();
      this.#bindSocket(this.#socket);
      this.#readyState = this.#socket.readyState;
      this.#emit("open");
    } catch (error) {
      this.#readyState = 3;
      this.#emit("error", error instanceof Error ? error : new Error(String(error)));
      this.#emit("close", 1006, "OpenAI WebSocket upgrade failed.");
    }
  }

  #bindSocket(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      this.#emit("message", event.data, event.data instanceof ArrayBuffer);
    });
    socket.addEventListener("close", (event) => {
      this.#readyState = 3;
      this.#emit("close", event.code, event.reason);
    });
    socket.addEventListener("error", () => {
      this.#emit("error", new Error("OpenAI WebSocket errored."));
    });
  }

  #listenersFor(event: CloudflareSocketEventName): Set<unknown> {
    const existing = this.#listeners.get(event);
    if (existing != null) return existing;

    const listeners = new Set<unknown>();
    this.#listeners.set(event, listeners);
    return listeners;
  }

  #onceListenersFor(event: CloudflareSocketEventName): Map<unknown, unknown> {
    const existing = this.#onceListeners.get(event);
    if (existing != null) return existing;

    const listeners = new Map<unknown, unknown>();
    this.#onceListeners.set(event, listeners);
    return listeners;
  }

  #removeListener(event: CloudflareSocketEventName, listener: unknown) {
    const listeners = this.#listeners.get(event);
    listeners?.delete(listener);
    const onceListener = this.#onceListeners.get(event)?.get(listener);
    if (onceListener == null) return;
    listeners?.delete(onceListener);
    this.#onceListeners.get(event)?.delete(listener);
  }

  #emit(event: CloudflareSocketEventName, ...args: unknown[]) {
    for (const listener of this.#listeners.get(event) ?? []) {
      (listener as (...args: unknown[]) => void)(...args);
    }
  }
}
