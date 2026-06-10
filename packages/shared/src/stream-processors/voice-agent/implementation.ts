import { z } from "zod";
import {
  assertNever,
  buildProcessorIdempotencyKey,
  defineProcessorContract,
  implementProcessor,
  type ConsumedEvent,
  type ProcessorStreamApi,
} from "../stream-processor.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import {
  AGENT_INPUT_ADDED_EVENT_TYPE,
  VOICE_AGENT_ERROR_OCCURRED_EVENT_TYPE,
  VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
  VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE,
  VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
  VOICE_AGENT_OUTPUT_TEXT_APPENDED_EVENT_TYPE,
  VOICE_AGENT_OUTPUT_SAMPLE_RATE,
  VOICE_AGENT_PROVIDER_CONNECTED_EVENT_TYPE,
  VOICE_AGENT_PROVIDER_DISCONNECTED_EVENT_TYPE,
  VOICE_AGENT_PROVIDER_GEMINI_LIVE,
  VOICE_AGENT_PROVIDER_GROK_REALTIME,
  VOICE_AGENT_PROVIDER_MESSAGE_RECEIVED_EVENT_TYPE,
  VOICE_AGENT_PROVIDER_MESSAGE_SENT_EVENT_TYPE,
  VOICE_AGENT_PROVIDER_OPENAI_REALTIME,
  VOICE_AGENT_PROVIDER_SESSION_READY_EVENT_TYPE,
  VOICE_AGENT_PROVIDER_STATUS_CHANGED_EVENT_TYPE,
  VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE,
  VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE,
  type VoiceAgentProvider,
  type VoiceAgentProviderStatus,
  VoiceAgentProcessorContract,
  type VoiceAgentSetup,
} from "./contract.ts";

type VoiceAgentStreamApi = ProcessorStreamApi<typeof VoiceAgentProcessorContract>;
type VoiceAgentConsumedEvent = ConsumedEvent<typeof VoiceAgentProcessorContract>;
type VoiceAgentInputEvent = Extract<
  VoiceAgentConsumedEvent,
  {
    type:
      | typeof VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE
      | typeof VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE;
  }
>;
type VoiceAgentAppendableEvent = Parameters<VoiceAgentStreamApi["append"]>[0]["event"];
type JsonValue = z.infer<ReturnType<typeof z.json>>;

export type VoiceAgentProcessorDeps = {
  geminiApiKey: string;
  openAiApiKey: string;
  xAiApiKey: string;
  /** Wakes the colocated code agent so messageAgent tool calls have someone listening. */
  ensureCodeAgent?: () => Promise<void>;
  /** Test seam: replaces the outbound fetch-upgrade WebSocket. */
  openProviderWebSocket?: (input: {
    provider: VoiceAgentProvider;
    url: URL;
    headers: Record<string, string>;
  }) => Promise<WebSocket>;
};

type ProviderConnection = {
  id: string;
  provider: VoiceAgentProvider;
  socket: WebSocket;
  urlForLog: string;
  ready: Promise<void>;
  resolveReady: () => void;
  sendSequence: number;
  receiveSequence: number;
  handledToolCallIds: Set<string>;
  /** Serializes incoming provider message handling so appends keep provider order. */
  handlerChain: Promise<void>;
  /** Serializes every stream append from this connection so output frames land in order. */
  appendChain: Promise<unknown>;
};

type ProviderContext = {
  connection: ProviderConnection;
  streamApi: VoiceAgentStreamApi;
  createOutputSequence: () => number;
  getLastInputStreamId: () => string;
};

const WEBSOCKET_OPEN = 1;
const PROVIDER_READY_TIMEOUT_MS = 30_000;
/** Strings longer than this are truncated in provider message audit events. */
export const AUDIT_MAX_STRING_LENGTH = 256;

export function createVoiceAgentProcessor(deps: VoiceAgentProcessorDeps) {
  let connection: ProviderConnection | null = null;
  let openingConnection: Promise<ProviderConnection> | null = null;
  let outputSequence = 0;
  let lastInputStreamId = "voice-agent";
  let sendChain: Promise<void> = Promise.resolve();
  let ensureCodeAgentPromise: Promise<void> | null = null;

  const getConnection = async (
    setup: VoiceAgentSetup,
    streamApi: VoiceAgentStreamApi,
  ): Promise<ProviderConnection> => {
    if (
      connection?.provider === setup.provider &&
      connection.socket.readyState === WEBSOCKET_OPEN
    ) {
      return connection;
    }
    if (openingConnection != null) {
      return await openingConnection;
    }

    connection?.socket.close(1000, "Replacing stale voice-agent provider connection.");
    openingConnection = openProviderConnection({
      deps,
      setup,
      streamApi,
      createOutputSequence: () => outputSequence++,
      getLastInputStreamId: () => lastInputStreamId,
      markConnectionClosed: (closedConnection) => {
        if (connection?.id === closedConnection.id) connection = null;
      },
    });
    try {
      connection = await openingConnection;
      return connection;
    } finally {
      openingConnection = null;
    }
  };

  return implementProcessor(VoiceAgentProcessorContract, {
    async afterAppend({ event, state, streamApi, waitUntil }) {
      await standardProcessorBehavior.afterAppend({
        contract: VoiceAgentProcessorContract,
        state,
        streamApi,
      });
      if (deps.ensureCodeAgent != null) {
        ensureCodeAgentPromise ??= deps.ensureCodeAgent().catch((error) => {
          ensureCodeAgentPromise = null;
          throw error;
        });
        await ensureCodeAgentPromise;
      }

      switch (event.type) {
        case CoreProcessorRegisteredEventType:
          return;
        case VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE:
        case "events.iterate.com/voice-agent/config-updated":
          connection?.socket.close(1000, "Voice-agent setup changed.");
          connection = null;
          openingConnection = null;
          return;
        case VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE:
        case VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE: {
          // Frames must reach the provider socket in stream order, so forwarding is
          // serialized; audit appends are enqueued without blocking the next send.
          const task = (sendChain = sendChain.then(() =>
            forwardInputEvent({
              deps,
              event,
              getConnection: (setup) => getConnection(setup, streamApi),
              rememberInputStreamId: (streamId) => {
                lastInputStreamId = streamId;
              },
              setup: state.setup,
              streamApi,
            }),
          ));
          if (waitUntil == null) {
            await task;
          } else {
            waitUntil(task);
          }
          return;
        }
        default:
          return assertNever(event);
      }
    },
  });
}

/**
 * Streams created before the unified voice-agent processor hold WebSocket
 * subscriptions to per-provider slugs (`voice-agent/<provider>`). This no-op
 * processor keeps those subscriptions from erroring on every wake; opening the
 * conversation page subscribes the stream to the unified processor.
 */
export function createRetiredVoiceAgentProviderProcessor(slug: string) {
  return implementProcessor(
    defineProcessorContract({
      slug,
      version: "0.2.0",
      description:
        "Retired per-provider voice-agent processor slug. Superseded by the unified voice-agent processor; consumes nothing.",
      stateSchema: z.object({}),
      initialState: {},
      events: {},
      consumes: [],
      emits: [],
    }),
    {},
  );
}

async function forwardInputEvent(args: {
  deps: VoiceAgentProcessorDeps;
  event: VoiceAgentInputEvent;
  getConnection: (setup: VoiceAgentSetup) => Promise<ProviderConnection>;
  rememberInputStreamId: (streamId: string) => void;
  setup: VoiceAgentSetup | null;
  streamApi: VoiceAgentStreamApi;
}) {
  const { event, setup, streamApi } = args;
  if (setup == null) {
    await appendInputError({
      error: new Error(
        "Voice-agent setup-configured event is required before appending input events.",
      ),
      event,
      streamApi,
    });
    return;
  }

  const endpoint = providerEndpoints[setup.provider];
  if (endpoint.apiKey(args.deps).trim() === "") {
    await appendInputError({
      error: new Error(endpoint.missingKeyMessage),
      event,
      streamApi,
    });
    return;
  }

  if (event.type === VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE) {
    args.rememberInputStreamId(event.payload.streamId);
  }

  let connection: ProviderConnection;
  try {
    connection = await args.getConnection(setup);
    await withTimeout(
      connection.ready,
      PROVIDER_READY_TIMEOUT_MS,
      `Timed out waiting for ${endpoint.label} setup.`,
    );
  } catch (error) {
    await appendInputError({ error, event, streamApi });
    return;
  }

  for (const message of buildInputMessages({ event, provider: connection.provider })) {
    sendProviderMessage({
      connection,
      message,
      sourceEventOffset: event.offset,
      streamApi,
    });
  }
}

function buildInputMessages(args: {
  event: VoiceAgentInputEvent;
  provider: VoiceAgentProvider;
}): JsonValue[] {
  const { event, provider } = args;

  if (event.type === VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE) {
    switch (provider) {
      case VOICE_AGENT_PROVIDER_GEMINI_LIVE:
        return [
          {
            realtimeInput: {
              audio: {
                data: event.payload.dataBase64,
                mimeType: `audio/pcm;rate=${event.payload.sampleRate}`,
              },
            },
          },
        ];
      case VOICE_AGENT_PROVIDER_OPENAI_REALTIME:
        // OpenAI Realtime only accepts 24 kHz PCM16.
        return [
          {
            type: "input_audio_buffer.append",
            audio: resamplePcm16Base64({
              dataBase64: event.payload.dataBase64,
              fromSampleRate: event.payload.sampleRate,
              toSampleRate: 24_000,
            }),
          },
        ];
      case VOICE_AGENT_PROVIDER_GROK_REALTIME:
        return [{ type: "input_audio_buffer.append", audio: event.payload.dataBase64 }];
      default:
        return assertNever(provider);
    }
  }

  const text = providerInputText(event.payload);
  switch (provider) {
    case VOICE_AGENT_PROVIDER_GEMINI_LIVE:
      return [
        {
          clientContent: {
            turns: [{ role: "user", parts: [{ text }] }],
            turnComplete: true,
          },
        },
      ];
    case VOICE_AGENT_PROVIDER_OPENAI_REALTIME:
    case VOICE_AGENT_PROVIDER_GROK_REALTIME:
      return [
        {
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        },
        { type: "response.create" },
      ];
    default:
      return assertNever(provider);
  }
}

function providerInputText(payload: { text: string; source?: string }) {
  if (payload.source !== "code-agent") return payload.text;
  return [
    "BACKGROUND AGENT MESSAGE TO RELAY TO THE HUMAN YOU ARE SPEAKING TO:",
    payload.text,
    "",
    "This message is not from the caller. It is from the background code-capable agent you asked for help.",
    "Your job is to relay this message to the human you are speaking to in natural speech.",
    "If the background agent's message is a question, ask that question to the human you are speaking to. Do not answer the question yourself.",
    "If the background agent's message is an answer or update, tell the human you are speaking to that answer or update directly.",
    "Do not say thanks, thank you, thanks for the update, or any other gratitude/acknowledgement phrase.",
    "Do not say the caller told you this. Do not describe the background agent as if it is another participant in the call.",
  ].join("\n");
}

// Provider endpoints.

type ProviderEndpoint = {
  label: string;
  apiKey: (deps: VoiceAgentProcessorDeps) => string;
  missingKeyMessage: string;
  url: (deps: VoiceAgentProcessorDeps, setup: VoiceAgentSetup) => URL;
  urlForLog: (setup: VoiceAgentSetup) => string;
  headers: (deps: VoiceAgentProcessorDeps) => Record<string, string>;
  buildSessionSetupMessage: (setup: VoiceAgentSetup) => JsonValue;
  handleMessage: (ctx: ProviderContext, data: unknown) => Promise<void>;
};

const providerEndpoints: Record<VoiceAgentProvider, ProviderEndpoint> = {
  [VOICE_AGENT_PROVIDER_GEMINI_LIVE]: {
    label: "Gemini Live",
    apiKey: (deps) => deps.geminiApiKey,
    missingKeyMessage: "APP_CONFIG_GEMINI_API_KEY is not configured.",
    url: (deps) => geminiLiveUrl(deps.geminiApiKey),
    urlForLog: () => geminiLiveUrl("").toString(),
    headers: () => ({}),
    buildSessionSetupMessage: (setup) => ({
      setup: {
        model: setup.model.startsWith("models/") ? setup.model : `models/${setup.model}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: setup.voiceName },
            },
          },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: {
          parts: [{ text: systemInstructionWithMessageAgent(setup.systemInstruction) }],
        },
        tools: [
          {
            functionDeclarations: [
              {
                name: "messageAgent",
                description: MESSAGE_AGENT_TOOL_DESCRIPTION,
                parameters: messageAgentParameters(),
              },
            ],
          },
        ],
        ...(setup.messageAgentToolChoice === "required"
          ? {
              toolConfig: {
                functionCallingConfig: {
                  mode: "ANY",
                  allowedFunctionNames: ["messageAgent"],
                },
              },
            }
          : {}),
      },
    }),
    handleMessage: handleGeminiMessage,
  },
  [VOICE_AGENT_PROVIDER_OPENAI_REALTIME]: {
    label: "OpenAI Realtime",
    apiKey: (deps) => deps.openAiApiKey,
    missingKeyMessage: "APP_CONFIG_OPEN_AI_API_KEY is not configured.",
    url: (_deps, setup) => realtimeUrl("https://api.openai.com/v1/realtime", setup.model),
    urlForLog: (setup) => realtimeUrl("https://api.openai.com/v1/realtime", setup.model).toString(),
    headers: (deps) => ({ Authorization: `Bearer ${deps.openAiApiKey}` }),
    buildSessionSetupMessage: (setup) => ({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: systemInstructionWithMessageAgent(setup.systemInstruction),
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: true,
            },
            transcription: { model: "gpt-4o-mini-transcribe" },
          },
          output: {
            format: { type: "audio/pcm", rate: VOICE_AGENT_OUTPUT_SAMPLE_RATE },
            voice: setup.voiceName,
          },
        },
        tools: [openAiCompatibleMessageAgentTool()],
        tool_choice: setup.messageAgentToolChoice === "required" ? "required" : "auto",
      },
    }),
    handleMessage: handleOpenAiCompatibleMessage,
  },
  [VOICE_AGENT_PROVIDER_GROK_REALTIME]: {
    label: "Grok Realtime",
    apiKey: (deps) => deps.xAiApiKey,
    missingKeyMessage: "APP_CONFIG_X_AI_API_KEY is not configured.",
    url: (_deps, setup) => realtimeUrl("https://api.x.ai/v1/realtime", setup.model),
    urlForLog: (setup) => realtimeUrl("https://api.x.ai/v1/realtime", setup.model).toString(),
    headers: (deps) => ({ Authorization: `Bearer ${deps.xAiApiKey}` }),
    buildSessionSetupMessage: (setup) => ({
      type: "session.update",
      session: {
        instructions: systemInstructionWithMessageAgent(setup.systemInstruction),
        voice: setup.voiceName,
        turn_detection: { type: "server_vad" },
        audio: {
          input: { format: { type: "audio/pcm", rate: 16_000 } },
          output: { format: { type: "audio/pcm", rate: VOICE_AGENT_OUTPUT_SAMPLE_RATE } },
        },
        tools: [openAiCompatibleMessageAgentTool()],
        tool_choice: setup.messageAgentToolChoice === "required" ? "required" : "auto",
      },
    }),
    handleMessage: handleOpenAiCompatibleMessage,
  },
};

async function openProviderConnection(args: {
  deps: VoiceAgentProcessorDeps;
  setup: VoiceAgentSetup;
  streamApi: VoiceAgentStreamApi;
  createOutputSequence: () => number;
  getLastInputStreamId: () => string;
  markConnectionClosed: (connection: ProviderConnection) => void;
}): Promise<ProviderConnection> {
  const endpoint = providerEndpoints[args.setup.provider];
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const openSocket = args.deps.openProviderWebSocket ?? openFetchWebSocket;
  const socket = await openSocket({
    provider: args.setup.provider,
    url: endpoint.url(args.deps, args.setup),
    headers: endpoint.headers(args.deps),
  });

  const connection: ProviderConnection = {
    id: crypto.randomUUID(),
    provider: args.setup.provider,
    socket,
    urlForLog: endpoint.urlForLog(args.setup),
    ready,
    resolveReady,
    sendSequence: 0,
    receiveSequence: 0,
    handledToolCallIds: new Set(),
    handlerChain: Promise.resolve(),
    appendChain: Promise.resolve(),
  };
  const ctx: ProviderContext = {
    connection,
    streamApi: args.streamApi,
    createOutputSequence: args.createOutputSequence,
    getLastInputStreamId: args.getLastInputStreamId,
  };

  socket.addEventListener("message", (event) => {
    connection.handlerChain = connection.handlerChain
      .then(() => endpoint.handleMessage(ctx, event.data))
      .catch((error) => {
        enqueueAppend(connection, args.streamApi, {
          type: VOICE_AGENT_ERROR_OCCURRED_EVENT_TYPE,
          idempotencyKey: `voice-agent:${connection.id}:message-handler-error:${connection.receiveSequence}`,
          payload: { message: stringifyError(error) },
        });
      });
  });
  socket.addEventListener("close", (event) => {
    args.markConnectionClosed(connection);
    rejectReady(
      new Error(event.reason || `${endpoint.label} WebSocket closed before setup completed.`),
    );
    enqueueAppend(connection, args.streamApi, {
      type: VOICE_AGENT_PROVIDER_DISCONNECTED_EVENT_TYPE,
      idempotencyKey: `voice-agent:${connection.id}:provider-disconnected`,
      payload: {
        provider: connection.provider,
        connectionId: connection.id,
        code: event.code,
        reason: event.reason || undefined,
        wasClean: event.wasClean,
      },
    });
  });
  socket.addEventListener("error", () => {
    args.markConnectionClosed(connection);
    rejectReady(new Error(`${endpoint.label} WebSocket errored before setup completed.`));
  });

  enqueueAppend(connection, args.streamApi, {
    type: VOICE_AGENT_PROVIDER_CONNECTED_EVENT_TYPE,
    idempotencyKey: `voice-agent:${connection.id}:provider-connected`,
    payload: {
      provider: connection.provider,
      connectionId: connection.id,
      model: args.setup.model,
      url: connection.urlForLog,
    },
  });

  sendProviderMessage({
    connection,
    message: endpoint.buildSessionSetupMessage(args.setup),
    streamApi: args.streamApi,
  });

  return connection;
}

// Gemini Live message handling.

type GeminiServerMessage = {
  setupComplete?: Record<string, unknown>;
  serverContent?: {
    modelTurn?: {
      parts?: Array<{
        inlineData?: { data?: string; mimeType?: string };
        text?: string;
      }>;
    };
    interrupted?: boolean;
    turnComplete?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
  };
  toolCall?: {
    functionCalls?: Array<{ id?: string; name?: string; args?: unknown }>;
  };
  goAway?: { timeLeft?: string };
};

async function handleGeminiMessage(ctx: ProviderContext, data: unknown) {
  const message = JSON.parse(await websocketMessageToText(data)) as GeminiServerMessage;
  const sequence = ctx.connection.receiveSequence++;
  enqueueProviderMessageAudit({
    ctx,
    direction: "received",
    message: message as JsonValue,
    sequence,
  });

  if (message.setupComplete != null) {
    ctx.connection.resolveReady();
    enqueueAppend(ctx.connection, ctx.streamApi, {
      type: VOICE_AGENT_PROVIDER_SESSION_READY_EVENT_TYPE,
      idempotencyKey: `voice-agent:${ctx.connection.id}:provider-session-ready`,
      payload: { provider: ctx.connection.provider, connectionId: ctx.connection.id },
    });
  }

  for (const functionCall of message.toolCall?.functionCalls ?? []) {
    await handleToolCall({
      ctx,
      callId: functionCall.id,
      name: functionCall.name,
      argumentsValue: functionCall.args,
      respond: (callId, output) => ({
        toolResponse: {
          functionResponses: [
            { id: callId, name: functionCall.name ?? "unknown_tool", response: output },
          ],
        },
      }),
    });
  }

  // Gemini terminates Live sessions after a fixed duration; surface the warning
  // instead of silently reconnecting into a fresh session with no context.
  if (message.goAway != null) {
    enqueueProviderStatus(ctx, "going-away", sequence);
  }

  const serverContent = message.serverContent;
  if (serverContent == null) return;

  for (const part of serverContent.modelTurn?.parts ?? []) {
    if (part.inlineData?.data) {
      enqueueOutputAudioFrame(ctx, part.inlineData.data);
    }
  }

  if (serverContent.interrupted) {
    enqueueProviderStatus(ctx, "output-interrupted", sequence);
    enqueueSpeakerBufferClear(ctx, "output-interrupted", sequence);
  }
  if (serverContent.turnComplete) {
    enqueueProviderStatus(ctx, "turn-completed", sequence);
  }

  enqueueTranscription(
    ctx,
    "input-transcription",
    serverContent.inputTranscription?.text,
    sequence,
  );
  enqueueTranscription(
    ctx,
    "output-transcription",
    serverContent.outputTranscription?.text,
    sequence,
  );
}

// OpenAI-compatible (OpenAI Realtime / Grok Realtime) message handling.

type RealtimeServerMessage = {
  type?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
  item?: RealtimeFunctionCallItem;
  response?: { output?: RealtimeFunctionCallItem[] };
};

type RealtimeFunctionCallItem = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
};

async function handleOpenAiCompatibleMessage(ctx: ProviderContext, data: unknown) {
  const message = JSON.parse(await websocketMessageToText(data)) as RealtimeServerMessage;
  const sequence = ctx.connection.receiveSequence++;
  enqueueProviderMessageAudit({
    ctx,
    direction: "received",
    message: message as JsonValue,
    sequence,
  });

  switch (message.type) {
    case "session.updated":
      ctx.connection.resolveReady();
      enqueueAppend(ctx.connection, ctx.streamApi, {
        type: VOICE_AGENT_PROVIDER_SESSION_READY_EVENT_TYPE,
        idempotencyKey: `voice-agent:${ctx.connection.id}:provider-session-ready`,
        payload: { provider: ctx.connection.provider, connectionId: ctx.connection.id },
      });
      return;
    case "response.output_audio.delta":
    case "response.audio.delta":
      if (typeof message.delta === "string") {
        enqueueOutputAudioFrame(ctx, message.delta);
      }
      return;
    case "conversation.item.input_audio_transcription.completed":
      enqueueTranscription(ctx, "input-transcription", message.transcript, sequence);
      return;
    case "response.output_audio_transcript.delta":
    case "response.audio_transcript.delta":
      enqueueTranscription(ctx, "output-transcription", message.delta, sequence);
      return;
    case "input_audio_buffer.speech_started":
      enqueueProviderStatus(ctx, "speech-started", sequence);
      enqueueSpeakerBufferClear(ctx, "input-speech-started", sequence);
      return;
    case "input_audio_buffer.speech_stopped":
      enqueueProviderStatus(ctx, "speech-stopped", sequence);
      return;
    case "response.output_audio.done":
    case "response.audio.done":
      enqueueProviderStatus(ctx, "output-audio-done", sequence);
      return;
    case "response.output_item.done":
      await handleOpenAiCompatibleFunctionCallItem(ctx, message.item);
      return;
    case "response.done":
      enqueueProviderStatus(ctx, "response-done", sequence);
      for (const item of message.response?.output ?? []) {
        await handleOpenAiCompatibleFunctionCallItem(ctx, item);
      }
      return;
    case "error":
      // Providers send recoverable errors (e.g. rejected client events) on a live
      // session; record them without tearing the connection down.
      enqueueAppend(ctx.connection, ctx.streamApi, {
        type: VOICE_AGENT_ERROR_OCCURRED_EVENT_TYPE,
        idempotencyKey: `voice-agent:${ctx.connection.id}:provider-error:${sequence}`,
        payload: {
          message:
            message.error?.message ??
            `${providerEndpoints[ctx.connection.provider].label} returned an error.`,
        },
      });
      return;
    default:
      return;
  }
}

async function handleOpenAiCompatibleFunctionCallItem(
  ctx: ProviderContext,
  item: RealtimeFunctionCallItem | undefined,
) {
  if (item?.type !== "function_call") return;
  await handleToolCall({
    ctx,
    callId: item.call_id,
    name: item.name,
    argumentsValue: item.arguments,
    respond: (callId, output) => ({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    }),
    followUp: { type: "response.create", response: { tool_choice: "none" } },
  });
}

// messageAgent tool plumbing.

const MESSAGE_AGENT_TOOL_DESCRIPTION =
  "Ask the code-capable background agent to do work or answer a question. Use for actions, investigation, code, data lookup, or anything requiring tools.";

async function handleToolCall(args: {
  ctx: ProviderContext;
  callId: string | undefined;
  name: string | undefined;
  argumentsValue: unknown;
  respond: (callId: string, output: JsonValue) => JsonValue;
  followUp?: JsonValue;
}) {
  const { ctx } = args;
  const callId = args.callId;
  if (callId == null || callId.trim() === "") return;
  if (ctx.connection.handledToolCallIds.has(callId)) return;
  ctx.connection.handledToolCallIds.add(callId);

  const toolResult =
    args.name === "messageAgent"
      ? await appendMessageAgentInput({ ctx, callId, argumentsValue: args.argumentsValue })
      : { ok: false, message: `Unknown tool: ${args.name ?? "<missing>"}` };

  sendProviderMessage({
    connection: ctx.connection,
    message: args.respond(callId, toolResult),
    streamApi: ctx.streamApi,
  });
  if (args.followUp != null) {
    sendProviderMessage({
      connection: ctx.connection,
      message: args.followUp,
      streamApi: ctx.streamApi,
    });
  }
}

async function appendMessageAgentInput(args: {
  ctx: ProviderContext;
  callId: string;
  argumentsValue: unknown;
}) {
  const parsed = parseMessageAgentArguments(args.argumentsValue);
  if (!parsed.ok) return parsed;

  await enqueueAppend(args.ctx.connection, args.ctx.streamApi, {
    type: AGENT_INPUT_ADDED_EVENT_TYPE,
    idempotencyKey: `voice-agent:${args.ctx.connection.id}:${args.ctx.connection.provider}:message-agent:${args.callId}:agent-input`,
    payload: {
      content: parsed.message,
      llmRequestPolicy: { behaviour: "after-current-request" },
    },
  });

  return {
    ok: true,
    message:
      "Asked the code-capable background agent. Continue the call while it works; it will respond back into the voice stream when ready.",
  };
}

function parseMessageAgentArguments(
  argumentsValue: unknown,
): { ok: true; message: string } | { ok: false; message: string } {
  if (argumentsValue == null) {
    return { ok: false, message: "messageAgent requires a JSON arguments object." };
  }

  let parsed = argumentsValue;
  if (typeof argumentsValue === "string") {
    if (argumentsValue.trim() === "") {
      return { ok: false, message: "messageAgent requires a JSON arguments object." };
    }
    try {
      parsed = JSON.parse(argumentsValue);
    } catch {
      return { ok: false, message: "messageAgent arguments must be valid JSON." };
    }
  }

  const message = (parsed as { message?: unknown }).message;
  if (typeof message !== "string" || message.trim() === "") {
    return { ok: false, message: "messageAgent requires a non-empty message string." };
  }
  return { ok: true, message: message.trim() };
}

function systemInstructionWithMessageAgent(systemInstruction: string) {
  return [
    systemInstruction,
    "You are speaking directly with a human. In these instructions, 'the caller' means the human you are speaking to. You have a tool named Message Agent. Use it when the caller asks for actions, investigation, code, data lookup, or anything requiring tools. Message Agent sends the request to a code-capable background agent. After calling it, tell the caller you asked the agent and continue the conversation while it works. When the background agent replies, relay its message to the caller; if it replies with a question, ask that question to the caller rather than answering it yourself.",
  ].join("\n\n");
}

function messageAgentParameters(input: { additionalProperties?: boolean } = {}) {
  return {
    type: "object",
    ...(input.additionalProperties == null
      ? {}
      : { additionalProperties: input.additionalProperties }),
    properties: {
      message: {
        type: "string",
        description:
          "The plain-language request for the background code agent. Include relevant context from the call.",
      },
    },
    required: ["message"],
  } satisfies JsonValue;
}

function openAiCompatibleMessageAgentTool() {
  return {
    type: "function",
    name: "messageAgent",
    description: MESSAGE_AGENT_TOOL_DESCRIPTION,
    parameters: messageAgentParameters({ additionalProperties: false }),
  } satisfies JsonValue;
}

// Append helpers. Everything appended on behalf of a connection goes through
// the connection's append chain so events land on the stream in emission order.

function enqueueAppend(
  connection: ProviderConnection,
  streamApi: VoiceAgentStreamApi,
  event: VoiceAgentAppendableEvent,
): Promise<unknown> {
  const next = connection.appendChain.then(() => streamApi.append({ event }));
  connection.appendChain = next.catch((error) => {
    console.error("voice-agent stream append failed", { error, type: event.type });
  });
  return next;
}

function sendProviderMessage(args: {
  connection: ProviderConnection;
  message: JsonValue;
  sourceEventOffset?: number;
  streamApi: VoiceAgentStreamApi;
}) {
  const sequence = args.connection.sendSequence++;
  args.connection.socket.send(JSON.stringify(args.message));
  enqueueAppend(args.connection, args.streamApi, {
    type: VOICE_AGENT_PROVIDER_MESSAGE_SENT_EVENT_TYPE,
    idempotencyKey: `voice-agent:${args.connection.id}:provider-message-sent:${sequence}`,
    payload: {
      provider: args.connection.provider,
      connectionId: args.connection.id,
      sequence,
      sourceEventOffset: args.sourceEventOffset,
      message: redactLargeStringsForAudit(args.message),
    },
  });
}

function enqueueProviderMessageAudit(args: {
  ctx: ProviderContext;
  direction: "received";
  message: JsonValue;
  sequence: number;
}) {
  enqueueAppend(args.ctx.connection, args.ctx.streamApi, {
    type: VOICE_AGENT_PROVIDER_MESSAGE_RECEIVED_EVENT_TYPE,
    idempotencyKey: `voice-agent:${args.ctx.connection.id}:provider-message-received:${args.sequence}`,
    payload: {
      provider: args.ctx.connection.provider,
      connectionId: args.ctx.connection.id,
      sequence: args.sequence,
      message: redactLargeStringsForAudit(args.message),
    },
  });
}

function enqueueProviderStatus(
  ctx: ProviderContext,
  status: VoiceAgentProviderStatus,
  sequence: number,
) {
  enqueueAppend(ctx.connection, ctx.streamApi, {
    type: VOICE_AGENT_PROVIDER_STATUS_CHANGED_EVENT_TYPE,
    idempotencyKey: `voice-agent:${ctx.connection.id}:provider-status:${status}:${sequence}`,
    payload: {
      provider: ctx.connection.provider,
      connectionId: ctx.connection.id,
      status,
    },
  });
}

function enqueueSpeakerBufferClear(
  ctx: ProviderContext,
  reason: "output-interrupted" | "input-speech-started",
  sequence: number,
) {
  enqueueAppend(ctx.connection, ctx.streamApi, {
    type: VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE,
    idempotencyKey: `voice-agent:${ctx.connection.id}:speaker-buffer-clear:${sequence}`,
    payload: {
      provider: ctx.connection.provider,
      connectionId: ctx.connection.id,
      reason,
    },
  });
}

function enqueueOutputAudioFrame(ctx: ProviderContext, dataBase64: string) {
  const bytes = base64ByteLength(dataBase64);
  const sequence = ctx.createOutputSequence();
  enqueueAppend(ctx.connection, ctx.streamApi, {
    type: VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
    idempotencyKey: `voice-agent:${ctx.connection.id}:output-audio:${sequence}`,
    payload: {
      channels: 1,
      dataBase64,
      durationMs: Math.round((bytes / 2 / VOICE_AGENT_OUTPUT_SAMPLE_RATE) * 1000),
      encoding: "pcm_s16le",
      sampleRate: VOICE_AGENT_OUTPUT_SAMPLE_RATE,
      sequence,
      streamId: ctx.getLastInputStreamId(),
    },
  });
}

function enqueueTranscription(
  ctx: ProviderContext,
  source: "input-transcription" | "output-transcription",
  text: string | undefined,
  sequence: number,
) {
  if (!text) return;
  enqueueAppend(ctx.connection, ctx.streamApi, {
    type: VOICE_AGENT_OUTPUT_TEXT_APPENDED_EVENT_TYPE,
    idempotencyKey: `voice-agent:${ctx.connection.id}:${source}:${sequence}`,
    payload: {
      connectionId: ctx.connection.id,
      source,
      text,
    },
  });
}

async function appendInputError(args: {
  error: unknown;
  event: VoiceAgentInputEvent;
  streamApi: VoiceAgentStreamApi;
}) {
  await args.streamApi.append({
    event: {
      type: VOICE_AGENT_ERROR_OCCURRED_EVENT_TYPE,
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: VoiceAgentProcessorContract,
        key:
          args.event.type === VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE
            ? "input-audio-frame-forwarding-failed"
            : "input-text-forwarding-failed",
        sourceEvent: args.event,
      }),
      payload: {
        message: stringifyError(args.error),
        sourceEventOffset: args.event.offset,
      },
    },
  });
}

/**
 * Provider messages embed base64 PCM that would otherwise double the stream's
 * audio storage. Audit copies keep structure but truncate long strings; the
 * canonical audio lives exactly once in input/output frame events.
 */
export function redactLargeStringsForAudit(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    if (value.length <= AUDIT_MAX_STRING_LENGTH) return value;
    return `${value.slice(0, 64)}… [${value.length - 64} more chars redacted]`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactLargeStringsForAudit(item));
  }
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactLargeStringsForAudit(item)]),
    );
  }
  return value;
}

// Transport helpers.

async function openFetchWebSocket(input: {
  provider: VoiceAgentProvider;
  url: URL;
  headers: Record<string, string>;
}): Promise<WebSocket> {
  const response = (await fetch(input.url, {
    headers: {
      ...input.headers,
      Upgrade: "websocket",
    },
  })) as Response & { webSocket?: WebSocket & { accept(): void } };
  if (!response.webSocket) {
    throw new Error(
      `${providerEndpoints[input.provider].label} WebSocket upgrade failed with HTTP ${response.status}.`,
    );
  }
  response.webSocket.accept();
  return response.webSocket;
}

function geminiLiveUrl(apiKey: string) {
  const url = new URL(
    "https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
  );
  if (apiKey) {
    url.searchParams.set("key", apiKey);
  }
  return url;
}

function realtimeUrl(base: string, model: string) {
  const url = new URL(base);
  url.searchParams.set("model", model);
  return url;
}

async function websocketMessageToText(message: unknown): Promise<string> {
  if (typeof message === "string") return message;
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(message);
  if (message instanceof Uint8Array) return new TextDecoder().decode(message);
  if (message instanceof Blob) return await message.text();
  throw new Error(`Unsupported WebSocket message type: ${typeof message}`);
}

function base64ByteLength(base64: string) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function resamplePcm16Base64(input: {
  dataBase64: string;
  fromSampleRate: number;
  toSampleRate: number;
}) {
  if (input.fromSampleRate === input.toSampleRate) return input.dataBase64;

  const bytes = base64ToUint8Array(input.dataBase64);
  const sourceSampleCount = Math.floor(bytes.byteLength / 2);
  const source = new Int16Array(sourceSampleCount);
  const sourceView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < source.length; index += 1) {
    source[index] = sourceView.getInt16(index * 2, true);
  }

  const targetSampleCount = Math.max(
    1,
    Math.round(source.length * (input.toSampleRate / input.fromSampleRate)),
  );
  const target = new Int16Array(targetSampleCount);
  for (let index = 0; index < target.length; index += 1) {
    const sourcePosition = index * (input.fromSampleRate / input.toSampleRate);
    const leftIndex = Math.min(source.length - 1, Math.floor(sourcePosition));
    const rightIndex = Math.min(source.length - 1, leftIndex + 1);
    const fraction = sourcePosition - leftIndex;
    const left = source[leftIndex] ?? 0;
    const right = source[rightIndex] ?? left;
    target[index] = Math.round(left + (right - left) * fraction);
  }

  const outputBytes = new Uint8Array(target.byteLength);
  const outputView = new DataView(outputBytes.buffer);
  for (let index = 0; index < target.length; index += 1) {
    outputView.setInt16(index * 2, target[index] ?? 0, true);
  }
  return uint8ArrayToBase64(outputBytes);
}

function base64ToUint8Array(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout != null) clearTimeout(timeout);
  }
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
