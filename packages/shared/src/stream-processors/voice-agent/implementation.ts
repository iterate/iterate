import { z } from "zod";
import {
  assertNever,
  buildProcessorIdempotencyKey,
  implementProcessor,
  type ConsumedEvent,
  type ProcessorStreamApi,
} from "../stream-processor.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import {
  AGENT_INPUT_ADDED_EVENT_TYPE,
  VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
  VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE,
  VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
  VOICE_AGENT_OUTPUT_TEXT_APPENDED_EVENT_TYPE,
  VOICE_AGENT_OUTPUT_SAMPLE_RATE,
  VOICE_AGENT_PROVIDER_GEMINI_LIVE,
  VOICE_AGENT_PROVIDER_GROK_REALTIME,
  VOICE_AGENT_PROVIDER_OPENAI_REALTIME,
  VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE,
  VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE,
  type VoiceAgentProvider,
  VoiceAgentProcessorContract,
  type VoiceAgentSetup,
  type VoiceAgentState,
} from "./contract.ts";

type VoiceAgentStreamApi = ProcessorStreamApi<typeof VoiceAgentProcessorContract>;
type VoiceAgentConsumedEvent = ConsumedEvent<typeof VoiceAgentProcessorContract>;
type JsonValue = z.infer<ReturnType<typeof z.json>>;

type ProviderConnection = {
  id: string;
  provider: VoiceAgentProvider;
  ready: Promise<void>;
  receiveSequence: number;
  sendSequence: number;
  handledToolCallIds: Set<string>;
  socket: WebSocket;
  urlForLog: string;
};

type ProviderConnectionArgs = {
  connection: ProviderConnection;
  createOutputSequence(): number;
  getLastInputStreamId(): string;
  resolveReady(): void;
  streamApi: VoiceAgentStreamApi;
};

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
    functionCalls?: GeminiFunctionCall[];
  };
  toolCallCancellation?: {
    ids?: string[];
  };
  goAway?: { timeLeft?: string };
};

type GeminiFunctionCall = {
  id?: string;
  name?: string;
  args?: unknown;
};

type RealtimeServerMessage = {
  type?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
  item?: RealtimeFunctionCallItem;
  response?: {
    output?: RealtimeFunctionCallItem[];
    status?: string;
  };
};

type RealtimeFunctionCallItem = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
};

type OpenAiCompatibleEventPrefix = "openai-realtime" | "grok-realtime";
type OpenAiCompatibleStatusEventSuffix =
  | "session-updated"
  | "speech-started"
  | "speech-stopped"
  | "output-audio-done"
  | "response-done";
type OpenAiCompatibleStatusEventType =
  | `events.iterate.com/voice-agent/openai-realtime-${OpenAiCompatibleStatusEventSuffix}`
  | `events.iterate.com/voice-agent/grok-realtime-${OpenAiCompatibleStatusEventSuffix}`;

export type VoiceAgentProcessorDeps = {
  geminiApiKey: string;
  openAiApiKey: string;
  xAiApiKey: string;
  openGeminiLiveWebSocket?: (input: { apiKey: string }) => Promise<WebSocket>;
  openOpenAiRealtimeWebSocket?: (input: { apiKey: string; model: string }) => Promise<WebSocket>;
  openGrokRealtimeWebSocket?: (input: { apiKey: string; model: string }) => Promise<WebSocket>;
};

const ProviderConnectedReadyState = 1;

export function createVoiceAgentProcessor(input: { ensureCodeAgent?: () => Promise<void> } = {}) {
  let ensureCodeAgentPromise: Promise<void> | null = null;

  return implementProcessor(VoiceAgentProcessorContract, {
    async afterAppend({ state, streamApi }) {
      await standardProcessorBehavior.afterAppend({
        contract: VoiceAgentProcessorContract,
        state,
        streamApi,
      });
      if (input.ensureCodeAgent == null) return;
      ensureCodeAgentPromise ??= input.ensureCodeAgent().catch((error) => {
        ensureCodeAgentPromise = null;
        throw error;
      });
      await ensureCodeAgentPromise;
    },
  });
}

export function createVoiceAgentProviderProcessor(
  input: VoiceAgentProcessorDeps & {
    processorSlug: string;
    provider: VoiceAgentProvider;
  },
) {
  return createVoiceAgentRealtimeProcessor({
    contract: {
      ...VoiceAgentProcessorContract,
      slug: input.processorSlug,
      description: `${providerLabel(input.provider)} realtime voice provider adapter for the canonical voice-agent stream protocol.`,
    } as typeof VoiceAgentProcessorContract,
    deps: input,
    provider: input.provider,
  });
}

function createVoiceAgentRealtimeProcessor(args: {
  contract: typeof VoiceAgentProcessorContract;
  deps: VoiceAgentProcessorDeps;
  provider: VoiceAgentProvider;
}) {
  let connection: ProviderConnection | null = null;
  let openingConnection: Promise<ProviderConnection> | null = null;
  let outputSequence = 0;
  let lastInputStreamId = "voice-agent";

  return implementProcessor(args.contract, {
    async afterAppend({ event, state, streamApi, waitUntil }) {
      await standardProcessorBehavior.afterAppend({
        contract: args.contract,
        state,
        streamApi,
      });

      const getConnection = async (setup: VoiceAgentSetup) => {
        if (
          connection?.provider === setup.provider &&
          connection.socket.readyState === ProviderConnectedReadyState
        ) {
          return connection;
        }

        if (openingConnection != null) {
          return await openingConnection;
        }

        connection?.socket.close(1000, "Voice-agent provider changed.");
        openingConnection = openProviderConnection({
          deps: args.deps,
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

      switch (event.type) {
        case CoreProcessorRegisteredEventType:
        case VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE:
        case VOICE_AGENT_OUTPUT_TEXT_APPENDED_EVENT_TYPE:
        case "events.iterate.com/voice-agent/transcription-appended":
        case VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE:
        case "events.iterate.com/voice-agent/error-occurred":
        case "events.iterate.com/voice-agent/gemini-live-websocket-connected":
        case "events.iterate.com/voice-agent/gemini-live-websocket-disconnected":
        case "events.iterate.com/voice-agent/gemini-live-setup-completed":
        case "events.iterate.com/voice-agent/gemini-live-message-sent":
        case "events.iterate.com/voice-agent/gemini-live-message-received":
        case "events.iterate.com/voice-agent/gemini-live-output-interrupted":
        case "events.iterate.com/voice-agent/gemini-live-turn-completed":
        case "events.iterate.com/voice-agent/openai-realtime-websocket-connected":
        case "events.iterate.com/voice-agent/openai-realtime-websocket-disconnected":
        case "events.iterate.com/voice-agent/openai-realtime-session-updated":
        case "events.iterate.com/voice-agent/openai-realtime-message-sent":
        case "events.iterate.com/voice-agent/openai-realtime-message-received":
        case "events.iterate.com/voice-agent/openai-realtime-speech-started":
        case "events.iterate.com/voice-agent/openai-realtime-speech-stopped":
        case "events.iterate.com/voice-agent/openai-realtime-output-audio-done":
        case "events.iterate.com/voice-agent/openai-realtime-response-done":
        case "events.iterate.com/voice-agent/grok-realtime-websocket-connected":
        case "events.iterate.com/voice-agent/grok-realtime-websocket-disconnected":
        case "events.iterate.com/voice-agent/grok-realtime-session-updated":
        case "events.iterate.com/voice-agent/grok-realtime-message-sent":
        case "events.iterate.com/voice-agent/grok-realtime-message-received":
        case "events.iterate.com/voice-agent/grok-realtime-speech-started":
        case "events.iterate.com/voice-agent/grok-realtime-speech-stopped":
        case "events.iterate.com/voice-agent/grok-realtime-output-audio-done":
        case "events.iterate.com/voice-agent/grok-realtime-response-done":
          return;
        case VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE:
        case "events.iterate.com/voice-agent/config-updated":
          connection?.socket.close(1000, "Voice-agent setup changed.");
          connection = null;
          openingConnection = null;
          return;
        case VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE: {
          const task = forwardInputAudioFrame({
            deps: args.deps,
            event,
            getConnection,
            provider: args.provider,
            rememberInputStreamId: (streamId) => {
              lastInputStreamId = streamId;
            },
            state,
            streamApi,
          });
          if (waitUntil == null) {
            await task;
          } else {
            waitUntil(task);
          }
          return;
        }
        case VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE: {
          const task = forwardInputText({
            deps: args.deps,
            event,
            getConnection,
            provider: args.provider,
            state,
            streamApi,
          });
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

async function forwardInputAudioFrame(args: {
  deps: VoiceAgentProcessorDeps;
  event: Extract<
    VoiceAgentConsumedEvent,
    { type: typeof VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE }
  >;
  getConnection(setup: VoiceAgentSetup): Promise<ProviderConnection>;
  provider: VoiceAgentProvider;
  rememberInputStreamId(streamId: string): void;
  state: VoiceAgentState;
  streamApi: VoiceAgentStreamApi;
}) {
  const setup = args.state.setup;
  if (setup == null) {
    await appendProcessorError({
      error: new Error(
        "Voice-agent setup-configured event is required before appending input audio.",
      ),
      event: args.event,
      streamApi: args.streamApi,
    });
    return;
  }
  if (setup.provider !== args.provider) {
    return;
  }

  const missingKeyError = missingApiKeyError({ deps: args.deps, provider: setup.provider });
  if (missingKeyError != null) {
    await appendProcessorError({
      error: new Error(missingKeyError),
      event: args.event,
      streamApi: args.streamApi,
    });
    return;
  }

  args.rememberInputStreamId(args.event.payload.streamId);

  let connection: ProviderConnection;
  try {
    connection = await args.getConnection(setup);
    await withTimeout(
      connection.ready,
      30_000,
      `Timed out waiting for ${providerLabel(setup.provider)} setup.`,
    );
  } catch (error) {
    await appendProcessorError({
      error,
      event: args.event,
      streamApi: args.streamApi,
    });
    return;
  }

  await sendInputAudioFrame({
    connection,
    event: args.event,
    streamApi: args.streamApi,
  });
}

async function sendInputAudioFrame(args: {
  connection: ProviderConnection;
  event: Extract<
    VoiceAgentConsumedEvent,
    { type: typeof VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE }
  >;
  streamApi: VoiceAgentStreamApi;
}) {
  const sequence = args.connection.sendSequence++;
  switch (args.connection.provider) {
    case VOICE_AGENT_PROVIDER_GEMINI_LIVE: {
      const message = {
        realtimeInput: {
          audio: {
            data: args.event.payload.dataBase64,
            mimeType: `audio/pcm;rate=${args.event.payload.sampleRate}`,
          },
        },
      } satisfies JsonValue;
      args.connection.socket.send(JSON.stringify(message));
      await appendProviderMessageSent({
        connection: args.connection,
        eventType: providerMessageSentEventType(args.connection.provider),
        message,
        sequence,
        sourceEventOffset: args.event.offset,
        streamApi: args.streamApi,
      });
      return;
    }
    case VOICE_AGENT_PROVIDER_OPENAI_REALTIME:
    case VOICE_AGENT_PROVIDER_GROK_REALTIME: {
      const message = {
        type: "input_audio_buffer.append",
        audio:
          args.connection.provider === VOICE_AGENT_PROVIDER_OPENAI_REALTIME
            ? resamplePcm16Base64({
                dataBase64: args.event.payload.dataBase64,
                fromSampleRate: args.event.payload.sampleRate,
                toSampleRate: 24_000,
              })
            : args.event.payload.dataBase64,
      } satisfies JsonValue;
      args.connection.socket.send(JSON.stringify(message));
      await appendProviderMessageSent({
        connection: args.connection,
        eventType: providerMessageSentEventType(args.connection.provider),
        message,
        sequence,
        sourceEventOffset: args.event.offset,
        streamApi: args.streamApi,
      });
      return;
    }
    default:
      return assertNever(args.connection.provider);
  }
}

async function forwardInputText(args: {
  deps: VoiceAgentProcessorDeps;
  event: Extract<
    VoiceAgentConsumedEvent,
    { type: typeof VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE }
  >;
  getConnection(setup: VoiceAgentSetup): Promise<ProviderConnection>;
  provider: VoiceAgentProvider;
  state: VoiceAgentState;
  streamApi: VoiceAgentStreamApi;
}) {
  const setup = args.state.setup;
  if (setup == null) {
    await appendProcessorError({
      error: new Error(
        "Voice-agent setup-configured event is required before appending input text.",
      ),
      event: args.event,
      streamApi: args.streamApi,
    });
    return;
  }
  if (setup.provider !== args.provider) return;

  const missingKeyError = missingApiKeyError({ deps: args.deps, provider: setup.provider });
  if (missingKeyError != null) {
    await appendProcessorError({
      error: new Error(missingKeyError),
      event: args.event,
      streamApi: args.streamApi,
    });
    return;
  }

  let connection: ProviderConnection;
  try {
    connection = await args.getConnection(setup);
    await withTimeout(
      connection.ready,
      30_000,
      `Timed out waiting for ${providerLabel(setup.provider)} setup.`,
    );
  } catch (error) {
    await appendProcessorError({
      error,
      event: args.event,
      streamApi: args.streamApi,
    });
    return;
  }

  await sendInputText({
    connection,
    event: args.event,
    streamApi: args.streamApi,
  });
}

async function sendInputText(args: {
  connection: ProviderConnection;
  event: Extract<
    VoiceAgentConsumedEvent,
    { type: typeof VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE }
  >;
  streamApi: VoiceAgentStreamApi;
}) {
  switch (args.connection.provider) {
    case VOICE_AGENT_PROVIDER_GEMINI_LIVE: {
      const sequence = args.connection.sendSequence++;
      const message = {
        clientContent: {
          turns: [{ role: "user", parts: [{ text: providerInputText(args.event) }] }],
          turnComplete: true,
        },
      } satisfies JsonValue;
      args.connection.socket.send(JSON.stringify(message));
      await appendProviderMessageSent({
        connection: args.connection,
        eventType: providerMessageSentEventType(args.connection.provider),
        message,
        sequence,
        sourceEventOffset: args.event.offset,
        streamApi: args.streamApi,
      });
      return;
    }
    case VOICE_AGENT_PROVIDER_OPENAI_REALTIME:
    case VOICE_AGENT_PROVIDER_GROK_REALTIME: {
      const itemSequence = args.connection.sendSequence++;
      const itemMessage = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: providerInputText(args.event) }],
        },
      } satisfies JsonValue;
      args.connection.socket.send(JSON.stringify(itemMessage));
      await appendProviderMessageSent({
        connection: args.connection,
        eventType: providerMessageSentEventType(args.connection.provider),
        message: itemMessage,
        sequence: itemSequence,
        sourceEventOffset: args.event.offset,
        streamApi: args.streamApi,
      });

      const responseSequence = args.connection.sendSequence++;
      const responseMessage = { type: "response.create" } satisfies JsonValue;
      args.connection.socket.send(JSON.stringify(responseMessage));
      await appendProviderMessageSent({
        connection: args.connection,
        eventType: providerMessageSentEventType(args.connection.provider),
        message: responseMessage,
        sequence: responseSequence,
        sourceEventOffset: args.event.offset,
        streamApi: args.streamApi,
      });
      return;
    }
    default:
      return assertNever(args.connection.provider);
  }
}

function providerInputText(
  event: Extract<
    VoiceAgentConsumedEvent,
    { type: typeof VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE }
  >,
) {
  if (event.payload.source !== "code-agent") return event.payload.text;
  return [
    "BACKGROUND AGENT RESULT FOR THE CALLER:",
    event.payload.text,
    "",
    "This message is not from the caller. It is the result from the background code-capable agent you asked for help.",
    "Tell the caller the answer directly and naturally now.",
    "Do not say thanks, thank you, thanks for the update, or any other gratitude/acknowledgement phrase.",
    "Do not say the caller told you this. Do not describe the background agent as if it is another participant in the call.",
  ].join("\n");
}

async function openProviderConnection(args: {
  deps: VoiceAgentProcessorDeps;
  setup: VoiceAgentSetup;
  streamApi: VoiceAgentStreamApi;
  createOutputSequence(): number;
  getLastInputStreamId(): string;
  markConnectionClosed(connection: ProviderConnection): void;
}): Promise<ProviderConnection> {
  const setup = args.setup;
  switch (setup.provider) {
    case VOICE_AGENT_PROVIDER_GEMINI_LIVE:
      return await openGeminiLiveConnection({ ...args, setup });
    case VOICE_AGENT_PROVIDER_OPENAI_REALTIME:
      return await openOpenAiRealtimeConnection({ ...args, setup });
    case VOICE_AGENT_PROVIDER_GROK_REALTIME:
      return await openGrokRealtimeConnection({ ...args, setup });
    default:
      return assertNever(setup);
  }
}

// Gemini Live handlers.

async function openGeminiLiveConnection(args: {
  deps: VoiceAgentProcessorDeps;
  setup: Extract<VoiceAgentSetup, { provider: typeof VOICE_AGENT_PROVIDER_GEMINI_LIVE }>;
  streamApi: VoiceAgentStreamApi;
  createOutputSequence(): number;
  getLastInputStreamId(): string;
  markConnectionClosed(connection: ProviderConnection): void;
}): Promise<ProviderConnection> {
  const connection = await createProviderConnection({
    openSocket:
      args.deps.openGeminiLiveWebSocket == null
        ? () => openGeminiLiveWebSocket({ apiKey: args.deps.geminiApiKey })
        : () => args.deps.openGeminiLiveWebSocket?.({ apiKey: args.deps.geminiApiKey }),
    provider: VOICE_AGENT_PROVIDER_GEMINI_LIVE,
    setup: args.setup,
    streamApi: args.streamApi,
    urlForLog: geminiLiveUrl({ apiKey: "" }).toString(),
    onMessage: handleGeminiMessage,
    markConnectionClosed: args.markConnectionClosed,
    createOutputSequence: args.createOutputSequence,
    getLastInputStreamId: args.getLastInputStreamId,
  });

  await appendProviderConnected({
    connection,
    eventType: "events.iterate.com/voice-agent/gemini-live-websocket-connected",
    model: args.setup.model,
    streamApi: args.streamApi,
  });

  const setupMessage = {
    setup: {
      model: normalizeGeminiModelName(args.setup.model),
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: args.setup.voiceName },
          },
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: {
        parts: [{ text: systemInstructionWithMessageAgent(args.setup.systemInstruction) }],
      },
      tools: [geminiMessageAgentTool()],
    },
  } satisfies JsonValue;
  const sequence = connection.sendSequence++;
  connection.socket.send(JSON.stringify(setupMessage));
  await appendProviderMessageSent({
    connection,
    eventType: "events.iterate.com/voice-agent/gemini-live-message-sent",
    message: setupMessage,
    sequence,
    streamApi: args.streamApi,
  });

  return connection;
}

async function handleGeminiMessage(args: ProviderConnectionArgs & { data: unknown }) {
  const text = await websocketMessageToText(args.data);
  const message = JSON.parse(text) as GeminiServerMessage;
  const sequence = args.connection.receiveSequence++;
  await appendProviderMessageReceived({
    connection: args.connection,
    eventType: providerMessageReceivedEventType(args.connection.provider),
    message: message as JsonValue,
    sequence,
    streamApi: args.streamApi,
  });

  if (message.setupComplete != null) {
    args.resolveReady();
    await args.streamApi.append({
      event: {
        type: "events.iterate.com/voice-agent/gemini-live-setup-completed",
        idempotencyKey: `voice-agent:${args.connection.id}:gemini-live-setup-completed`,
        payload: { connectionId: args.connection.id },
      },
    });
  }

  for (const functionCall of message.toolCall?.functionCalls ?? []) {
    await handleGeminiFunctionCall({
      connection: args.connection,
      functionCall,
      streamApi: args.streamApi,
    });
  }

  const serverContent = message.serverContent;
  if (serverContent == null) return;

  for (const part of serverContent.modelTurn?.parts ?? []) {
    const dataBase64 = part.inlineData?.data;
    if (!dataBase64) continue;
    await appendOutputAudioFrame({
      connection: args.connection,
      createOutputSequence: args.createOutputSequence,
      dataBase64,
      getLastInputStreamId: args.getLastInputStreamId,
      streamApi: args.streamApi,
    });
  }

  if (serverContent.interrupted) {
    const sourceEventType = "events.iterate.com/voice-agent/gemini-live-output-interrupted";
    await args.streamApi.append({
      event: {
        type: sourceEventType,
        idempotencyKey: `voice-agent:${args.connection.id}:gemini-live-output-interrupted:${sequence}`,
        payload: { connectionId: args.connection.id },
      },
    });
    await appendSpeakerBufferClearRequested({
      connection: args.connection,
      reason: "output-interrupted",
      sequence,
      sourceEventType,
      streamApi: args.streamApi,
    });
  }

  if (serverContent.turnComplete) {
    await args.streamApi.append({
      event: {
        type: "events.iterate.com/voice-agent/gemini-live-turn-completed",
        idempotencyKey: `voice-agent:${args.connection.id}:gemini-live-turn-completed:${sequence}`,
        payload: { connectionId: args.connection.id },
      },
    });
  }

  await appendTranscriptionEvents({
    connectionId: args.connection.id,
    inputText: serverContent.inputTranscription?.text,
    sequence,
    outputText: serverContent.outputTranscription?.text,
    streamApi: args.streamApi,
  });
}

// OpenAI Realtime handlers.

async function openOpenAiRealtimeConnection(args: {
  deps: VoiceAgentProcessorDeps;
  setup: Extract<VoiceAgentSetup, { provider: typeof VOICE_AGENT_PROVIDER_OPENAI_REALTIME }>;
  streamApi: VoiceAgentStreamApi;
  createOutputSequence(): number;
  getLastInputStreamId(): string;
  markConnectionClosed(connection: ProviderConnection): void;
}): Promise<ProviderConnection> {
  const connection = await createProviderConnection({
    openSocket:
      args.deps.openOpenAiRealtimeWebSocket == null
        ? () =>
            openOpenAiRealtimeWebSocket({
              apiKey: args.deps.openAiApiKey,
              model: args.setup.model,
            })
        : () =>
            args.deps.openOpenAiRealtimeWebSocket?.({
              apiKey: args.deps.openAiApiKey,
              model: args.setup.model,
            }),
    provider: VOICE_AGENT_PROVIDER_OPENAI_REALTIME,
    setup: args.setup,
    streamApi: args.streamApi,
    urlForLog: openAiRealtimeUrl({ model: args.setup.model }).toString(),
    onMessage: handleOpenAiRealtimeMessage,
    markConnectionClosed: args.markConnectionClosed,
    createOutputSequence: args.createOutputSequence,
    getLastInputStreamId: args.getLastInputStreamId,
  });

  await appendProviderConnected({
    connection,
    eventType: "events.iterate.com/voice-agent/openai-realtime-websocket-connected",
    model: args.setup.model,
    streamApi: args.streamApi,
  });

  const setupMessage = {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: systemInstructionWithMessageAgent(args.setup.systemInstruction),
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
          voice: args.setup.voiceName,
        },
      },
      tools: [openAiCompatibleMessageAgentTool()],
      tool_choice: openAiCompatibleMessageAgentToolChoice(args.setup.messageAgentToolChoice),
    },
  } satisfies JsonValue;
  const sequence = connection.sendSequence++;
  connection.socket.send(JSON.stringify(setupMessage));
  await appendProviderMessageSent({
    connection,
    eventType: "events.iterate.com/voice-agent/openai-realtime-message-sent",
    message: setupMessage,
    sequence,
    streamApi: args.streamApi,
  });

  return connection;
}

async function handleOpenAiRealtimeMessage(args: ProviderConnectionArgs & { data: unknown }) {
  await handleOpenAiCompatibleRealtimeMessage({
    ...args,
    eventPrefix: "openai-realtime",
  });
}

// Grok Realtime handlers.

async function openGrokRealtimeConnection(args: {
  deps: VoiceAgentProcessorDeps;
  setup: Extract<VoiceAgentSetup, { provider: typeof VOICE_AGENT_PROVIDER_GROK_REALTIME }>;
  streamApi: VoiceAgentStreamApi;
  createOutputSequence(): number;
  getLastInputStreamId(): string;
  markConnectionClosed(connection: ProviderConnection): void;
}): Promise<ProviderConnection> {
  const connection = await createProviderConnection({
    openSocket:
      args.deps.openGrokRealtimeWebSocket == null
        ? () => openGrokRealtimeWebSocket({ apiKey: args.deps.xAiApiKey, model: args.setup.model })
        : () =>
            args.deps.openGrokRealtimeWebSocket?.({
              apiKey: args.deps.xAiApiKey,
              model: args.setup.model,
            }),
    provider: VOICE_AGENT_PROVIDER_GROK_REALTIME,
    setup: args.setup,
    streamApi: args.streamApi,
    urlForLog: grokRealtimeUrl({ model: args.setup.model }).toString(),
    onMessage: handleGrokRealtimeMessage,
    markConnectionClosed: args.markConnectionClosed,
    createOutputSequence: args.createOutputSequence,
    getLastInputStreamId: args.getLastInputStreamId,
  });

  await appendProviderConnected({
    connection,
    eventType: "events.iterate.com/voice-agent/grok-realtime-websocket-connected",
    model: args.setup.model,
    streamApi: args.streamApi,
  });

  const setupMessage = {
    type: "session.update",
    session: {
      instructions: systemInstructionWithMessageAgent(args.setup.systemInstruction),
      voice: args.setup.voiceName,
      turn_detection: { type: "server_vad" },
      audio: {
        input: { format: { type: "audio/pcm", rate: 16_000 } },
        output: { format: { type: "audio/pcm", rate: VOICE_AGENT_OUTPUT_SAMPLE_RATE } },
      },
      tools: [openAiCompatibleMessageAgentTool()],
      tool_choice: openAiCompatibleMessageAgentToolChoice(args.setup.messageAgentToolChoice),
    },
  } satisfies JsonValue;
  const sequence = connection.sendSequence++;
  connection.socket.send(JSON.stringify(setupMessage));
  await appendProviderMessageSent({
    connection,
    eventType: "events.iterate.com/voice-agent/grok-realtime-message-sent",
    message: setupMessage,
    sequence,
    streamApi: args.streamApi,
  });

  return connection;
}

async function handleGrokRealtimeMessage(args: ProviderConnectionArgs & { data: unknown }) {
  await handleOpenAiCompatibleRealtimeMessage({
    ...args,
    eventPrefix: "grok-realtime",
  });
}

async function handleOpenAiCompatibleRealtimeMessage(
  args: ProviderConnectionArgs & {
    data: unknown;
    eventPrefix: OpenAiCompatibleEventPrefix;
  },
) {
  const text = await websocketMessageToText(args.data);
  const message = JSON.parse(text) as RealtimeServerMessage;
  const sequence = args.connection.receiveSequence++;
  await appendProviderMessageReceived({
    connection: args.connection,
    eventType: providerMessageReceivedEventType(args.connection.provider),
    message: message as JsonValue,
    sequence,
    streamApi: args.streamApi,
  });

  switch (message.type) {
    case "session.updated":
      args.resolveReady();
      await args.streamApi.append({
        event: {
          type: openAiCompatibleEventType(args.eventPrefix, "session-updated"),
          idempotencyKey: `voice-agent:${args.connection.id}:${args.eventPrefix}-session-updated`,
          payload: { connectionId: args.connection.id },
        },
      });
      return;
    case "response.output_audio.delta":
    case "response.audio.delta":
      if (typeof message.delta === "string") {
        await appendOutputAudioFrame({
          connection: args.connection,
          createOutputSequence: args.createOutputSequence,
          dataBase64: message.delta,
          getLastInputStreamId: args.getLastInputStreamId,
          streamApi: args.streamApi,
        });
      }
      return;
    case "conversation.item.input_audio_transcription.completed":
      await appendTranscriptionEvents({
        connectionId: args.connection.id,
        inputText: message.transcript,
        sequence,
        streamApi: args.streamApi,
      });
      return;
    case "response.output_audio_transcript.delta":
    case "response.audio_transcript.delta":
      await appendTranscriptionEvents({
        connectionId: args.connection.id,
        outputText: message.delta,
        sequence,
        streamApi: args.streamApi,
      });
      return;
    case "input_audio_buffer.speech_started":
      {
        const sourceEventType = openAiCompatibleEventType(args.eventPrefix, "speech-started");
        await appendProviderStatusEvent({
          connection: args.connection,
          eventType: sourceEventType,
          sequence,
          streamApi: args.streamApi,
        });
        await appendSpeakerBufferClearRequested({
          connection: args.connection,
          reason: "input-speech-started",
          sequence,
          sourceEventType,
          streamApi: args.streamApi,
        });
      }
      return;
    case "input_audio_buffer.speech_stopped":
      await appendProviderStatusEvent({
        connection: args.connection,
        eventType: openAiCompatibleEventType(args.eventPrefix, "speech-stopped"),
        sequence,
        streamApi: args.streamApi,
      });
      return;
    case "response.output_audio.done":
    case "response.audio.done":
      await appendProviderStatusEvent({
        connection: args.connection,
        eventType: openAiCompatibleEventType(args.eventPrefix, "output-audio-done"),
        sequence,
        streamApi: args.streamApi,
      });
      return;
    case "response.output_item.done":
      await handleOpenAiCompatibleFunctionCallItem({
        connection: args.connection,
        item: message.item,
        streamApi: args.streamApi,
      });
      return;
    case "response.done":
      await appendProviderStatusEvent({
        connection: args.connection,
        eventType: openAiCompatibleEventType(args.eventPrefix, "response-done"),
        sequence,
        streamApi: args.streamApi,
      });
      for (const item of message.response?.output ?? []) {
        await handleOpenAiCompatibleFunctionCallItem({
          connection: args.connection,
          item,
          streamApi: args.streamApi,
        });
      }
      return;
    case "error":
      throw new Error(
        message.error?.message ?? `${providerLabel(args.connection.provider)} returned an error.`,
      );
    default:
      return;
  }
}

async function handleGeminiFunctionCall(args: {
  connection: ProviderConnection;
  functionCall: GeminiFunctionCall;
  streamApi: VoiceAgentStreamApi;
}) {
  const callId = args.functionCall.id;
  if (callId == null || callId.trim() === "") return;
  if (args.connection.handledToolCallIds.has(callId)) return;
  args.connection.handledToolCallIds.add(callId);

  const toolResult =
    args.functionCall.name === "messageAgent"
      ? await appendMessageAgentInput({
          argumentsValue: args.functionCall.args,
          callId,
          connection: args.connection,
          streamApi: args.streamApi,
        })
      : {
          ok: false,
          message: `Unknown tool: ${args.functionCall.name ?? "<missing>"}`,
        };

  await sendGeminiFunctionResponse({
    callId,
    connection: args.connection,
    name: args.functionCall.name ?? "unknown_tool",
    output: toolResult,
    streamApi: args.streamApi,
  });
}

async function handleOpenAiCompatibleFunctionCallItem(args: {
  connection: ProviderConnection;
  item: RealtimeFunctionCallItem | undefined;
  streamApi: VoiceAgentStreamApi;
}) {
  if (args.item?.type !== "function_call") return;
  const callId = args.item.call_id;
  if (callId == null || callId.trim() === "") return;
  if (args.connection.handledToolCallIds.has(callId)) return;
  args.connection.handledToolCallIds.add(callId);

  const toolResult =
    args.item.name === "messageAgent"
      ? await appendMessageAgentInput({
          argumentsValue: args.item.arguments,
          callId,
          connection: args.connection,
          streamApi: args.streamApi,
        })
      : {
          ok: false,
          message: `Unknown tool: ${args.item.name ?? "<missing>"}`,
        };

  await sendOpenAiCompatibleFunctionCallOutput({
    callId,
    connection: args.connection,
    output: toolResult,
    sequenceSourceEventOffset: undefined,
    streamApi: args.streamApi,
  });
}

async function appendMessageAgentInput(args: {
  argumentsValue: unknown;
  callId: string;
  connection: ProviderConnection;
  streamApi: VoiceAgentStreamApi;
}) {
  const parsed = parseMessageAgentArguments(args.argumentsValue);
  if (!parsed.ok) return parsed;

  await args.streamApi.append({
    event: {
      type: AGENT_INPUT_ADDED_EVENT_TYPE,
      idempotencyKey: `voice-agent:${args.connection.id}:${args.connection.provider}:message-agent:${args.callId}:agent-input`,
      payload: {
        content: parsed.message,
        llmRequestPolicy: { behaviour: "after-current-request" },
      },
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

async function sendGeminiFunctionResponse(args: {
  callId: string;
  connection: ProviderConnection;
  name: string;
  output: JsonValue;
  sequenceSourceEventOffset?: number;
  streamApi: VoiceAgentStreamApi;
}) {
  const sequence = args.connection.sendSequence++;
  const message = {
    toolResponse: {
      functionResponses: [
        {
          id: args.callId,
          name: args.name,
          response: args.output,
        },
      ],
    },
  } satisfies JsonValue;
  args.connection.socket.send(JSON.stringify(message));
  await appendProviderMessageSent({
    connection: args.connection,
    eventType: providerMessageSentEventType(args.connection.provider),
    message,
    sequence,
    sourceEventOffset: args.sequenceSourceEventOffset,
    streamApi: args.streamApi,
  });
}

async function sendOpenAiCompatibleFunctionCallOutput(args: {
  callId: string;
  connection: ProviderConnection;
  output: JsonValue;
  sequenceSourceEventOffset?: number;
  streamApi: VoiceAgentStreamApi;
}) {
  const itemSequence = args.connection.sendSequence++;
  const itemMessage = {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: args.callId,
      output: JSON.stringify(args.output),
    },
  } satisfies JsonValue;
  args.connection.socket.send(JSON.stringify(itemMessage));
  await appendProviderMessageSent({
    connection: args.connection,
    eventType: providerMessageSentEventType(args.connection.provider),
    message: itemMessage,
    sequence: itemSequence,
    sourceEventOffset: args.sequenceSourceEventOffset,
    streamApi: args.streamApi,
  });

  const responseSequence = args.connection.sendSequence++;
  const responseMessage = {
    type: "response.create",
    response: { tool_choice: "none" },
  } satisfies JsonValue;
  args.connection.socket.send(JSON.stringify(responseMessage));
  await appendProviderMessageSent({
    connection: args.connection,
    eventType: providerMessageSentEventType(args.connection.provider),
    message: responseMessage,
    sequence: responseSequence,
    sourceEventOffset: args.sequenceSourceEventOffset,
    streamApi: args.streamApi,
  });
}

function systemInstructionWithMessageAgent(systemInstruction: string) {
  return [
    systemInstruction,
    "You have a tool named Message Agent. Use it when the caller asks for actions, investigation, code, data lookup, or anything requiring tools. Message Agent sends the request to a code-capable background agent. After calling it, tell the caller you asked the agent and continue the conversation while it works.",
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
    description:
      "Ask the code-capable background agent to do work or answer a question. Use for actions, investigation, code, data lookup, or anything requiring tools.",
    parameters: messageAgentParameters({ additionalProperties: false }),
  } satisfies JsonValue;
}

function openAiCompatibleMessageAgentToolChoice(choice: VoiceAgentSetup["messageAgentToolChoice"]) {
  return choice === "required" ? "required" : "auto";
}

function geminiMessageAgentTool() {
  return {
    functionDeclarations: [
      {
        name: "messageAgent",
        description:
          "Ask the code-capable background agent to do work or answer a question. Use for actions, investigation, code, data lookup, or anything requiring tools.",
        parameters: messageAgentParameters(),
      },
    ],
  } satisfies JsonValue;
}

// Shared provider helpers.

async function createProviderConnection(args: {
  openSocket(): Promise<WebSocket> | undefined;
  provider: VoiceAgentProvider;
  setup: VoiceAgentSetup;
  streamApi: VoiceAgentStreamApi;
  urlForLog: string;
  onMessage(args: ProviderConnectionArgs & { data: unknown }): Promise<void>;
  createOutputSequence(): number;
  getLastInputStreamId(): string;
  markConnectionClosed(connection: ProviderConnection): void;
}): Promise<ProviderConnection> {
  const connectionId = crypto.randomUUID();
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const socket = await args.openSocket();
  if (socket == null) throw new Error(`Could not open ${providerLabel(args.provider)} WebSocket.`);

  const connection: ProviderConnection = {
    id: connectionId,
    provider: args.provider,
    ready,
    receiveSequence: 0,
    sendSequence: 0,
    handledToolCallIds: new Set(),
    socket,
    urlForLog: args.urlForLog,
  };

  socket.addEventListener("message", (event) => {
    void args
      .onMessage({
        connection,
        createOutputSequence: args.createOutputSequence,
        data: event.data,
        getLastInputStreamId: args.getLastInputStreamId,
        resolveReady,
        streamApi: args.streamApi,
      })
      .catch((error) => {
        void args.streamApi.append({
          event: {
            type: "events.iterate.com/voice-agent/error-occurred",
            idempotencyKey: `voice-agent:${connection.id}:message-handler-error:${connection.receiveSequence}`,
            payload: {
              message: stringifyError(error),
            },
          },
        });
      });
  });
  socket.addEventListener("close", (event) => {
    args.markConnectionClosed(connection);
    rejectReady(
      new Error(
        event.reason || `${providerLabel(args.provider)} WebSocket closed before setup completed.`,
      ),
    );
    const eventType = providerDisconnectedEventType(args.provider);
    void args.streamApi.append({
      event: {
        type: eventType,
        idempotencyKey: `voice-agent:${connection.id}:${eventType.split("/").at(-1)}`,
        payload: {
          connectionId,
          code: event.code,
          reason: event.reason || undefined,
          wasClean: event.wasClean,
        },
      },
    });
  });
  socket.addEventListener("error", () => {
    args.markConnectionClosed(connection);
    rejectReady(
      new Error(`${providerLabel(args.provider)} WebSocket errored before setup completed.`),
    );
  });

  return connection;
}

async function appendProviderConnected(args: {
  connection: ProviderConnection;
  eventType:
    | "events.iterate.com/voice-agent/gemini-live-websocket-connected"
    | "events.iterate.com/voice-agent/openai-realtime-websocket-connected"
    | "events.iterate.com/voice-agent/grok-realtime-websocket-connected";
  model: string;
  streamApi: VoiceAgentStreamApi;
}) {
  await args.streamApi.append({
    event: {
      type: args.eventType,
      idempotencyKey: `voice-agent:${args.connection.id}:${args.eventType.split("/").at(-1)}`,
      payload: {
        connectionId: args.connection.id,
        model: args.model,
        url: args.connection.urlForLog,
      },
    },
  });
}

async function appendProviderMessageSent(args: {
  connection: ProviderConnection;
  eventType:
    | "events.iterate.com/voice-agent/gemini-live-message-sent"
    | "events.iterate.com/voice-agent/openai-realtime-message-sent"
    | "events.iterate.com/voice-agent/grok-realtime-message-sent";
  message: JsonValue;
  sequence: number;
  sourceEventOffset?: number;
  streamApi: VoiceAgentStreamApi;
}) {
  await args.streamApi.append({
    event: {
      type: args.eventType,
      idempotencyKey: `voice-agent:${args.connection.id}:${args.eventType.split("/").at(-1)}:${args.sequence}`,
      payload: {
        connectionId: args.connection.id,
        sequence: args.sequence,
        sourceEventOffset: args.sourceEventOffset,
        message: args.message,
      },
    },
  });
}

async function appendProviderMessageReceived(args: {
  connection: ProviderConnection;
  eventType:
    | "events.iterate.com/voice-agent/gemini-live-message-received"
    | "events.iterate.com/voice-agent/openai-realtime-message-received"
    | "events.iterate.com/voice-agent/grok-realtime-message-received";
  message: JsonValue;
  sequence: number;
  streamApi: VoiceAgentStreamApi;
}) {
  await args.streamApi.append({
    event: {
      type: args.eventType,
      idempotencyKey: `voice-agent:${args.connection.id}:${args.eventType.split("/").at(-1)}:${args.sequence}`,
      payload: {
        connectionId: args.connection.id,
        sequence: args.sequence,
        message: args.message,
      },
    },
  });
}

async function appendProviderStatusEvent(args: {
  connection: ProviderConnection;
  eventType: OpenAiCompatibleStatusEventType;
  sequence: number;
  streamApi: VoiceAgentStreamApi;
}) {
  await args.streamApi.append({
    event: {
      type: args.eventType,
      idempotencyKey: `voice-agent:${args.connection.id}:${args.eventType.split("/").at(-1)}:${args.sequence}`,
      payload: { connectionId: args.connection.id },
    },
  });
}

async function appendSpeakerBufferClearRequested(args: {
  connection: ProviderConnection;
  reason: "output-interrupted" | "input-speech-started";
  sequence: number;
  sourceEventType: string;
  streamApi: VoiceAgentStreamApi;
}) {
  await args.streamApi.append({
    event: {
      type: VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE,
      idempotencyKey: `voice-agent:${args.connection.id}:speaker-buffer-clear-requested:${args.sequence}:${args.sourceEventType}`,
      payload: {
        connectionId: args.connection.id,
        provider: args.connection.provider,
        reason: args.reason,
        sourceEventType: args.sourceEventType,
      },
    },
  });
}

async function appendOutputAudioFrame(args: {
  connection: ProviderConnection;
  createOutputSequence(): number;
  dataBase64: string;
  getLastInputStreamId(): string;
  streamApi: VoiceAgentStreamApi;
}) {
  const bytes = base64ByteLength(args.dataBase64);
  const sequence = args.createOutputSequence();
  await args.streamApi.append({
    event: {
      type: VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
      idempotencyKey: `voice-agent:${args.connection.id}:output-audio:${sequence}`,
      payload: {
        channels: 1,
        dataBase64: args.dataBase64,
        durationMs: Math.round((bytes / 2 / VOICE_AGENT_OUTPUT_SAMPLE_RATE) * 1000),
        encoding: "pcm_s16le",
        sampleRate: VOICE_AGENT_OUTPUT_SAMPLE_RATE,
        sequence,
        streamId: args.getLastInputStreamId(),
      },
    },
  });
}

async function appendTranscriptionEvents(args: {
  connectionId: string;
  inputText?: string;
  sequence: number;
  outputText?: string;
  streamApi: VoiceAgentStreamApi;
}) {
  if (args.inputText) {
    await args.streamApi.append({
      event: {
        type: VOICE_AGENT_OUTPUT_TEXT_APPENDED_EVENT_TYPE,
        idempotencyKey: `voice-agent:${args.connectionId}:input-transcription-output-text:${args.sequence}`,
        payload: {
          connectionId: args.connectionId,
          source: "input-transcription",
          text: args.inputText,
        },
      },
    });
  }
  if (args.outputText) {
    await args.streamApi.append({
      event: {
        type: VOICE_AGENT_OUTPUT_TEXT_APPENDED_EVENT_TYPE,
        idempotencyKey: `voice-agent:${args.connectionId}:output-transcription-output-text:${args.sequence}`,
        payload: {
          connectionId: args.connectionId,
          source: "output-transcription",
          text: args.outputText,
        },
      },
    });
  }
}

async function openGeminiLiveWebSocket(input: { apiKey: string }): Promise<WebSocket> {
  return await openFetchWebSocket({
    headers: {},
    providerLabel: "Gemini Live",
    url: geminiLiveUrl({ apiKey: input.apiKey }),
  });
}

async function openOpenAiRealtimeWebSocket(input: {
  apiKey: string;
  model: string;
}): Promise<WebSocket> {
  return await openFetchWebSocket({
    headers: { Authorization: `Bearer ${input.apiKey}` },
    providerLabel: "OpenAI Realtime",
    url: openAiRealtimeUrl({ model: input.model }),
  });
}

async function openGrokRealtimeWebSocket(input: {
  apiKey: string;
  model: string;
}): Promise<WebSocket> {
  return await openFetchWebSocket({
    headers: { Authorization: `Bearer ${input.apiKey}` },
    providerLabel: "Grok Realtime",
    url: grokRealtimeUrl({ model: input.model }),
  });
}

async function openFetchWebSocket(input: {
  headers: Record<string, string>;
  providerLabel: string;
  url: URL;
}): Promise<WebSocket> {
  const response = (await fetch(input.url, {
    headers: {
      ...input.headers,
      Upgrade: "websocket",
    },
  })) as Response & { webSocket?: WebSocket & { accept(): void } };
  if (!response.webSocket) {
    throw new Error(
      `${input.providerLabel} WebSocket upgrade failed with HTTP ${response.status}.`,
    );
  }
  response.webSocket.accept();
  return response.webSocket;
}

function geminiLiveUrl(input: { apiKey: string }) {
  const url = new URL(
    "https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
  );
  if (input.apiKey) {
    url.searchParams.set("key", input.apiKey);
  }
  return url;
}

function openAiRealtimeUrl(input: { model: string }) {
  const url = new URL("https://api.openai.com/v1/realtime");
  url.searchParams.set("model", input.model);
  return url;
}

function grokRealtimeUrl(input: { model: string }) {
  const url = new URL("https://api.x.ai/v1/realtime");
  url.searchParams.set("model", input.model);
  return url;
}

function normalizeGeminiModelName(model: string) {
  return model.startsWith("models/") ? model : `models/${model}`;
}

function missingApiKeyError(input: {
  deps: VoiceAgentProcessorDeps;
  provider: VoiceAgentProvider;
}) {
  switch (input.provider) {
    case VOICE_AGENT_PROVIDER_GEMINI_LIVE:
      return input.deps.geminiApiKey.trim() === ""
        ? "APP_CONFIG_GEMINI_API_KEY is not configured."
        : null;
    case VOICE_AGENT_PROVIDER_OPENAI_REALTIME:
      return input.deps.openAiApiKey.trim() === ""
        ? "APP_CONFIG_OPEN_AI_API_KEY is not configured."
        : null;
    case VOICE_AGENT_PROVIDER_GROK_REALTIME:
      return input.deps.xAiApiKey.trim() === ""
        ? "APP_CONFIG_X_AI_API_KEY is not configured."
        : null;
    default:
      return assertNever(input.provider);
  }
}

function providerDisconnectedEventType(provider: VoiceAgentProvider) {
  switch (provider) {
    case VOICE_AGENT_PROVIDER_GEMINI_LIVE:
      return "events.iterate.com/voice-agent/gemini-live-websocket-disconnected";
    case VOICE_AGENT_PROVIDER_OPENAI_REALTIME:
      return "events.iterate.com/voice-agent/openai-realtime-websocket-disconnected";
    case VOICE_AGENT_PROVIDER_GROK_REALTIME:
      return "events.iterate.com/voice-agent/grok-realtime-websocket-disconnected";
    default:
      return assertNever(provider);
  }
}

function providerMessageSentEventType(provider: VoiceAgentProvider) {
  switch (provider) {
    case VOICE_AGENT_PROVIDER_GEMINI_LIVE:
      return "events.iterate.com/voice-agent/gemini-live-message-sent";
    case VOICE_AGENT_PROVIDER_OPENAI_REALTIME:
      return "events.iterate.com/voice-agent/openai-realtime-message-sent";
    case VOICE_AGENT_PROVIDER_GROK_REALTIME:
      return "events.iterate.com/voice-agent/grok-realtime-message-sent";
    default:
      return assertNever(provider);
  }
}

function providerMessageReceivedEventType(provider: VoiceAgentProvider) {
  switch (provider) {
    case VOICE_AGENT_PROVIDER_GEMINI_LIVE:
      return "events.iterate.com/voice-agent/gemini-live-message-received";
    case VOICE_AGENT_PROVIDER_OPENAI_REALTIME:
      return "events.iterate.com/voice-agent/openai-realtime-message-received";
    case VOICE_AGENT_PROVIDER_GROK_REALTIME:
      return "events.iterate.com/voice-agent/grok-realtime-message-received";
    default:
      return assertNever(provider);
  }
}

function openAiCompatibleEventType(
  prefix: OpenAiCompatibleEventPrefix,
  suffix: OpenAiCompatibleStatusEventSuffix,
): OpenAiCompatibleStatusEventType {
  return `events.iterate.com/voice-agent/${prefix}-${suffix}`;
}

function providerLabel(provider: VoiceAgentProvider) {
  switch (provider) {
    case VOICE_AGENT_PROVIDER_GEMINI_LIVE:
      return "Gemini Live";
    case VOICE_AGENT_PROVIDER_OPENAI_REALTIME:
      return "OpenAI Realtime";
    case VOICE_AGENT_PROVIDER_GROK_REALTIME:
      return "Grok Realtime";
    default:
      return assertNever(provider);
  }
}

async function appendProcessorError(args: {
  error: unknown;
  event: Extract<
    VoiceAgentConsumedEvent,
    {
      type:
        | typeof VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE
        | typeof VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE;
    }
  >;
  streamApi: VoiceAgentStreamApi;
}) {
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/voice-agent/error-occurred",
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

function resamplePcm16Base64(input: {
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
