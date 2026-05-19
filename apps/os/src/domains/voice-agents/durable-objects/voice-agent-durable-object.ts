import { z } from "zod";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import {
  deriveDurableObjectNameFromStructuredName,
  NotInitializedError,
} from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withStreamProcessor } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor";
import { createVoiceAgentProcessor } from "@iterate-com/shared/stream-processors/voice-agent/implementation";
import type { ProcessorStreamApi, StreamEvent } from "@iterate-com/shared/stream-processors";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers";
import type { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import { StreamSocketFrame } from "@iterate-com/shared/streams/stream-socket-types";
import type { Event, EventInput, StreamCursor } from "@iterate-com/shared/streams/types";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { resolveStreamPath } from "~/domains/streams/entrypoints/streams-capability.ts";

export type VoiceAgentDurableObjectStructuredName = {
  projectId: string;
  streamPath: StreamPath;
};

export const VoiceAgentDurableObjectStructuredName = z.object({
  projectId: z.string().trim().min(1),
  streamPath: StreamPath,
});

export function getVoiceAgentDurableObjectName(input: VoiceAgentDurableObjectStructuredName) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: input,
  });
}

export type VoiceAgentDurableObjectEnv = {
  APP_CONFIG?: string;
  APP_CONFIG_GEMINI_API_KEY?: string;
  APP_CONFIG_OPEN_AI_API_KEY?: string;
  APP_CONFIG_X_AI_API_KEY?: string;
  DO_CATALOG: D1Database;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
  VOICE_AGENT: DurableObjectNamespace<VoiceAgentDurableObject>;
};

type VoiceAgentStreamApi = ProcessorStreamApi<{
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

const VoiceAgentLifecycleBase = createIterateDurableObjectBase<
  typeof VoiceAgentDurableObjectStructuredName,
  Pick<VoiceAgentDurableObjectEnv, "DO_CATALOG">
>({
  className: "VoiceAgentDurableObject",
  getDatabase: (env) => env.DO_CATALOG,
  indexes: {
    projectId: (params) => params.projectId,
    streamPath: (params) => params.streamPath,
  },
  nameSchema: VoiceAgentDurableObjectStructuredName,
});

const VoiceAgentBase = withStreamProcessor<
  VoiceAgentDurableObjectStructuredName,
  VoiceAgentDurableObjectEnv
>({
  streamApi(args) {
    return voiceAgentStreamApiFromNamespace({
      durableObjectNamespace: args.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: args.structuredName.projectId,
      streamPath: StreamPath.parse(String(args.streamPath)),
    });
  },
})(VoiceAgentLifecycleBase);

export class VoiceAgentDurableObject extends VoiceAgentBase<VoiceAgentDurableObjectEnv> {
  #streamSocketMessageQueue = Promise.resolve();

  constructor(ctx: DurableObjectState, env: VoiceAgentDurableObjectEnv) {
    super(ctx, env);

    this.registerOnInstanceWake(async (params) => {
      this.registerStreamProcessor(
        createVoiceAgentProcessor({
          geminiApiKey: readGeminiApiKey(this.env as Record<string, unknown>),
          openAiApiKey: readOpenAiApiKey(this.env as Record<string, unknown>),
          xAiApiKey: readXAiApiKey(this.env as Record<string, unknown>),
        }),
      );
      await this.ensureVoiceAgentSubscription(params);
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
        console.error("[voice-agent] stream websocket event processing failed", {
          error,
          offset: event.offset,
          streamPath: event.streamPath,
          type: event.type,
          voiceAgentName: this.name,
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

  private async ensureVoiceAgentSubscription(params: VoiceAgentDurableObjectStructuredName) {
    await this.ensureStreamProcessorWebSocketSubscription({
      bindingName: "VOICE_AGENT",
      durableObjectName: this.name,
      fetchPath: "/stream-subscription",
      slug: `voice-agent:${params.projectId}:${params.streamPath}`,
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

function voiceAgentStreamApiFromNamespace(args: {
  durableObjectNamespace: StreamDurableObjectNamespace;
  namespace: string;
  streamPath: StreamPath;
}): VoiceAgentStreamApi {
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
      throw new Error("Voice agent processors receive live events through afterAppend RPC.");
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
