import { z } from "zod";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { NotInitializedError } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withStreamProcessor } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor";
import {
  VOICE_AGENT_PROVIDER_GEMINI_LIVE,
  VOICE_AGENT_PROVIDER_GROK_REALTIME,
  VOICE_AGENT_PROVIDER_OPENAI_REALTIME,
} from "@iterate-com/shared/stream-processors/voice-agent/contract";
import {
  createVoiceAgentProcessor,
  createVoiceAgentProviderProcessor,
} from "@iterate-com/shared/stream-processors/voice-agent/implementation";
import type {
  Processor,
  ProcessorStreamApi,
  StreamEvent,
} from "@iterate-com/shared/stream-processors";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers";
import type { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import { StreamSocketFrame } from "@iterate-com/shared/streams/stream-socket-types";
import type { Event, EventInput, StreamCursor } from "@iterate-com/shared/streams/types";
import { StreamPath } from "@iterate-com/shared/streams/types";
import {
  GEMINI_LIVE_VOICE_PROCESSOR_SLUG,
  GROK_REALTIME_VOICE_PROCESSOR_SLUG,
  OPENAI_REALTIME_VOICE_PROCESSOR_SLUG,
  streamProcessorSubscriptionSlug,
  VOICE_AGENT_PROCESSOR_SLUG,
} from "~/domains/stream-processors/stream-processor-slugs.ts";
import { resolveStreamPath } from "~/domains/streams/entrypoints/streams-capability.ts";
import {
  getAgentDurableObjectName,
  type AgentDurableObject,
} from "~/domains/agents/durable-objects/agent-durable-object.ts";
import { voiceAgentCodeAgentEvents } from "~/domains/voice-agents/voice-agent-code-agent.ts";

export type StreamProcessorDurableObjectStructuredName = {
  processorSlug: string;
  projectId: string;
  streamPath: StreamPath;
};

export const StreamProcessorDurableObjectStructuredName = z.object({
  processorSlug: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  streamPath: StreamPath,
});

export type StreamProcessorDurableObjectEnv = {
  APP_CONFIG?: string;
  APP_CONFIG_GEMINI_API_KEY?: string;
  APP_CONFIG_OPEN_AI_API_KEY?: string;
  APP_CONFIG_X_AI_API_KEY?: string;
  AGENT: DurableObjectNamespace<AgentDurableObject>;
  DO_CATALOG: D1Database;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
  STREAM_PROCESSOR: DurableObjectNamespace<StreamProcessorDurableObject>;
};

type GenericStreamApi = ProcessorStreamApi<{
  emits: readonly string[];
  events: Record<string, unknown>;
  processorDeps?: readonly unknown[];
}> & {
  append(args: { event: EventInput; streamPath?: string }): Promise<Event>;
  appendBatch(args: { events: EventInput[]; streamPath?: string }): Promise<Event[]>;
  read(args?: {
    streamPath?: string;
    afterOffset?: StreamCursor;
    beforeOffset?: StreamCursor;
  }): Promise<Event[]>;
};

type RegistryEntry = {
  create(
    env: StreamProcessorDurableObjectEnv,
    params: StreamProcessorDurableObjectStructuredName,
  ): Processor<unknown>;
};

const StreamProcessorLifecycleBase = createIterateDurableObjectBase<
  typeof StreamProcessorDurableObjectStructuredName,
  Pick<StreamProcessorDurableObjectEnv, "DO_CATALOG">
>({
  className: "StreamProcessorDurableObject",
  getDatabase: (env) => env.DO_CATALOG,
  indexes: {
    processorSlug: (params) => params.processorSlug,
    projectId: (params) => params.projectId,
    streamPath: (params) => params.streamPath,
  },
  nameSchema: StreamProcessorDurableObjectStructuredName,
});

const StreamProcessorBase = withStreamProcessor<
  StreamProcessorDurableObjectStructuredName,
  StreamProcessorDurableObjectEnv
>({
  streamApi(args) {
    return streamApiFromNamespace({
      durableObjectNamespace: args.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: args.structuredName.projectId,
      streamPath: StreamPath.parse(String(args.streamPath)),
    });
  },
})(StreamProcessorLifecycleBase);

export class StreamProcessorDurableObject extends StreamProcessorBase<StreamProcessorDurableObjectEnv> {
  #streamSocketMessageQueue = Promise.resolve();

  constructor(ctx: DurableObjectState, env: StreamProcessorDurableObjectEnv) {
    super(ctx, env);

    this.registerOnInstanceWake(async (params) => {
      const entry = streamProcessorRegistry[params.processorSlug];
      if (entry == null) {
        throw new Error(`Unknown stream processor "${params.processorSlug}".`);
      }

      this.registerStreamProcessor(entry.create(this.env, params));
      await this.ensureProcessorSubscription(params);
      await this.catchUpStreamProcessors({
        signal: AbortSignal.timeout(30_000),
        streamPath: params.streamPath,
      });
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/stream-subscription") {
      const inheritedFetch = super.fetch;
      if (inheritedFetch == null) {
        return new Response("Not found", { status: 404 });
      }
      return await inheritedFetch.call(this, request);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    await this.ensureStartedOrInitializeFromRuntimeName();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = streamProcessorWebSocketMessageToString(message);
    if (text == null) return;

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }

    const frame = StreamSocketFrame.safeParse(json);
    if (!frame.success || frame.data.type !== "event") return;
    const event = frame.data.event;

    const next = this.#streamSocketMessageQueue.then(async () => {
      try {
        await this.afterAppend({ event });
      } catch (error) {
        console.error("[stream-processor] stream websocket event processing failed", {
          error,
          offset: event.offset,
          processorName: this.name,
          streamPath: event.streamPath,
          type: event.type,
        });
        socket.send(
          JSON.stringify({
            type: "error",
            message: error instanceof Error ? error.message : "Failed to process stream event.",
          }),
        );
      }
    });
    this.#streamSocketMessageQueue = next.catch(() => {});
    await next;
  }

  async afterAppend(input: { event: Event }) {
    await this.ensureStartedOrInitializeFromRuntimeName();
    return await this.consumeStreamProcessorEvent({ event: input.event as StreamEvent });
  }

  async getRuntimeState() {
    await this.ensureStarted();
    return this.getStreamProcessorRuntimeState();
  }

  private async ensureProcessorSubscription(params: StreamProcessorDurableObjectStructuredName) {
    await this.ensureStreamProcessorWebSocketSubscription({
      bindingName: "STREAM_PROCESSOR",
      durableObjectName: this.name,
      fetchPath: "/stream-subscription",
      slug: streamProcessorSubscriptionSlug(params),
      streamPath: params.streamPath,
    });
  }

  private async ensureStartedOrInitializeFromRuntimeName() {
    try {
      return await this.ensureStarted();
    } catch (error) {
      if (!(error instanceof NotInitializedError)) throw error;
      const runtimeName = this.getDurableObjectName();
      if (runtimeName == null) throw error;
      return await this.initialize({ name: runtimeName });
    }
  }
}

const streamProcessorRegistry: Record<string, RegistryEntry> = {
  [VOICE_AGENT_PROCESSOR_SLUG]: {
    create: (env, params) =>
      createVoiceAgentProcessor({
        ensureCodeAgent: async () => {
          await ensureVoiceAgentCodeAgent({ env, params });
        },
      }),
  },
  [GEMINI_LIVE_VOICE_PROCESSOR_SLUG]: {
    create: (env) =>
      createVoiceAgentProviderProcessor({
        geminiApiKey: readGeminiApiKey(env as Record<string, unknown>),
        openAiApiKey: readOpenAiApiKey(env as Record<string, unknown>),
        processorSlug: GEMINI_LIVE_VOICE_PROCESSOR_SLUG,
        provider: VOICE_AGENT_PROVIDER_GEMINI_LIVE,
        xAiApiKey: readXAiApiKey(env as Record<string, unknown>),
      }),
  },
  [OPENAI_REALTIME_VOICE_PROCESSOR_SLUG]: {
    create: (env) =>
      createVoiceAgentProviderProcessor({
        geminiApiKey: readGeminiApiKey(env as Record<string, unknown>),
        openAiApiKey: readOpenAiApiKey(env as Record<string, unknown>),
        processorSlug: OPENAI_REALTIME_VOICE_PROCESSOR_SLUG,
        provider: VOICE_AGENT_PROVIDER_OPENAI_REALTIME,
        xAiApiKey: readXAiApiKey(env as Record<string, unknown>),
      }),
  },
  [GROK_REALTIME_VOICE_PROCESSOR_SLUG]: {
    create: (env) =>
      createVoiceAgentProviderProcessor({
        geminiApiKey: readGeminiApiKey(env as Record<string, unknown>),
        openAiApiKey: readOpenAiApiKey(env as Record<string, unknown>),
        processorSlug: GROK_REALTIME_VOICE_PROCESSOR_SLUG,
        provider: VOICE_AGENT_PROVIDER_GROK_REALTIME,
        xAiApiKey: readXAiApiKey(env as Record<string, unknown>),
      }),
  },
};

async function ensureVoiceAgentCodeAgent(input: {
  env: StreamProcessorDurableObjectEnv;
  params: StreamProcessorDurableObjectStructuredName;
}) {
  const streamApi = streamApiFromNamespace({
    durableObjectNamespace: input.env.STREAM as unknown as StreamDurableObjectNamespace,
    namespace: input.params.projectId,
    streamPath: input.params.streamPath,
  });
  await streamApi.appendBatch({
    events: voiceAgentCodeAgentEvents({
      projectId: input.params.projectId,
      streamPath: input.params.streamPath,
    }),
  });

  const structuredName = {
    agentPath: input.params.streamPath,
    projectId: input.params.projectId,
  };
  const name = getAgentDurableObjectName(structuredName);
  await input.env.AGENT.getByName(name).initialize({ name });
}

function streamApiFromNamespace(args: {
  durableObjectNamespace: StreamDurableObjectNamespace;
  namespace: string;
  streamPath: StreamPath;
}): GenericStreamApi {
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
    async appendBatch(input) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.appendBatch(input.events);
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
      throw new Error("Generic stream processors receive live events through websocket frames.");
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

function streamProcessorWebSocketMessageToString(message: string | ArrayBuffer): string | null {
  if (typeof message === "string") return message;
  return new TextDecoder().decode(message);
}

function readGeminiApiKey(env: Record<string, unknown>) {
  const override = env.APP_CONFIG_GEMINI_API_KEY;
  if (typeof override === "string") return override;
  const plainSecret = env.GEMINI_API_KEY;
  if (typeof plainSecret === "string") return plainSecret;

  const rawConfig = env.APP_CONFIG;
  if (typeof rawConfig !== "string" || rawConfig.trim() === "") return "";

  try {
    const parsed = JSON.parse(rawConfig) as { geminiApiKey?: unknown };
    return typeof parsed.geminiApiKey === "string" ? parsed.geminiApiKey : "";
  } catch {
    return "";
  }
}

function readOpenAiApiKey(env: Record<string, unknown>) {
  const override = env.APP_CONFIG_OPEN_AI_API_KEY;
  if (typeof override === "string") return override;
  const plainSecret = env.OPENAI_API_KEY;
  if (typeof plainSecret === "string") return plainSecret;

  const rawConfig = env.APP_CONFIG;
  if (typeof rawConfig !== "string" || rawConfig.trim() === "") return "";

  try {
    const parsed = JSON.parse(rawConfig) as { openAiApiKey?: unknown };
    return typeof parsed.openAiApiKey === "string" ? parsed.openAiApiKey : "";
  } catch {
    return "";
  }
}

function readXAiApiKey(env: Record<string, unknown>) {
  const override = env.APP_CONFIG_X_AI_API_KEY;
  if (typeof override === "string") return override;
  const plainSecret = env.XAI_API_KEY;
  if (typeof plainSecret === "string") return plainSecret;

  const rawConfig = env.APP_CONFIG;
  if (typeof rawConfig !== "string" || rawConfig.trim() === "") return "";

  try {
    const parsed = JSON.parse(rawConfig) as { xAiApiKey?: unknown };
    return typeof parsed.xAiApiKey === "string" ? parsed.xAiApiKey : "";
  } catch {
    return "";
  }
}
