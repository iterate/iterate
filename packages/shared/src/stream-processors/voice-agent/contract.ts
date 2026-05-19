import { z } from "zod";
import {
  assertNever,
  defineProcessorContract,
  reduceProcessorEvents,
  type StreamEvent,
} from "../stream-processor.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";

export const VOICE_AGENT_PROVIDER_GEMINI_LIVE = "gemini-live";
export const VOICE_AGENT_PROVIDER_OPENAI_REALTIME = "openai-realtime";
export const VOICE_AGENT_PROVIDER_GROK_REALTIME = "grok-realtime";

export const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
export const DEFAULT_GEMINI_LIVE_VOICE = "Zephyr";
export const DEFAULT_OPENAI_REALTIME_MODEL = "gpt-realtime-mini";
export const DEFAULT_OPENAI_REALTIME_VOICE = "marin";
export const DEFAULT_GROK_REALTIME_MODEL = "grok-voice-latest";
export const DEFAULT_GROK_REALTIME_VOICE = "eve";
export const DEFAULT_VOICE_AGENT_SYSTEM_INSTRUCTION =
  "You are a helpful realtime voice agent. Keep responses concise.";
export const VOICE_AGENT_INPUT_SAMPLE_RATE = 16_000;
export const VOICE_AGENT_OUTPUT_SAMPLE_RATE = 24_000;

export const VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE =
  "events.iterate.com/voice-agent/setup-configured";
export const VOICE_AGENT_CONFIG_UPDATED_EVENT_TYPE =
  "events.iterate.com/voice-agent/config-updated";
export const VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE =
  "events.iterate.com/voice-agent/input-audio-frame-appended";
export const VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE =
  "events.iterate.com/voice-agent/output-audio-frame-appended";
export const VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE =
  "events.iterate.com/voice-agent/speaker-buffer-clear-requested";

const VoiceAgentAudioFramePayload = z.object({
  streamId: z.string().trim().min(1),
  sequence: z.number().int().nonnegative(),
  encoding: z.literal("pcm_s16le"),
  sampleRate: z.number().int().positive(),
  channels: z.literal(1),
  durationMs: z.number().int().nonnegative(),
  dataBase64: z.string().trim().min(1),
});

const GeminiSetupPayload = z.object({
  provider: z.literal(VOICE_AGENT_PROVIDER_GEMINI_LIVE),
  model: z.string().trim().min(1).default(DEFAULT_GEMINI_LIVE_MODEL),
  voiceName: z.string().trim().min(1).default(DEFAULT_GEMINI_LIVE_VOICE),
  systemInstruction: z.string().default(DEFAULT_VOICE_AGENT_SYSTEM_INSTRUCTION),
});

const OpenAiSetupPayload = z.object({
  provider: z.literal(VOICE_AGENT_PROVIDER_OPENAI_REALTIME),
  model: z.string().trim().min(1).default(DEFAULT_OPENAI_REALTIME_MODEL),
  voiceName: z.string().trim().min(1).default(DEFAULT_OPENAI_REALTIME_VOICE),
  systemInstruction: z.string().default(DEFAULT_VOICE_AGENT_SYSTEM_INSTRUCTION),
});

const GrokSetupPayload = z.object({
  provider: z.literal(VOICE_AGENT_PROVIDER_GROK_REALTIME),
  model: z.string().trim().min(1).default(DEFAULT_GROK_REALTIME_MODEL),
  voiceName: z.string().trim().min(1).default(DEFAULT_GROK_REALTIME_VOICE),
  systemInstruction: z.string().default(DEFAULT_VOICE_AGENT_SYSTEM_INSTRUCTION),
});

const VoiceAgentSetup = z.discriminatedUnion("provider", [
  GeminiSetupPayload,
  OpenAiSetupPayload,
  GrokSetupPayload,
]);

const ProviderJson = z.json();

const ConnectionState = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("idle") }),
    z.object({
      status: z.literal("connected"),
      connectionId: z.string().min(1),
      provider: z.union([
        z.literal(VOICE_AGENT_PROVIDER_GEMINI_LIVE),
        z.literal(VOICE_AGENT_PROVIDER_OPENAI_REALTIME),
        z.literal(VOICE_AGENT_PROVIDER_GROK_REALTIME),
      ]),
    }),
    z.object({
      status: z.literal("disconnected"),
      connectionId: z.string().min(1).optional(),
      provider: z
        .union([
          z.literal(VOICE_AGENT_PROVIDER_GEMINI_LIVE),
          z.literal(VOICE_AGENT_PROVIDER_OPENAI_REALTIME),
          z.literal(VOICE_AGENT_PROVIDER_GROK_REALTIME),
        ])
        .optional(),
      reason: z.string().optional(),
    }),
    z.object({ status: z.literal("error"), message: z.string().min(1) }),
  ])
  .default({ status: "idle" });

const ProviderWebSocketConnectedPayload = z.object({
  connectionId: z.string().min(1),
  model: z.string().min(1),
  url: z.string().url(),
});

const ProviderWebSocketDisconnectedPayload = z.object({
  connectionId: z.string().min(1).optional(),
  code: z.number().int().optional(),
  reason: z.string().optional(),
  wasClean: z.boolean().optional(),
});

const ProviderMessagePayload = z.object({
  connectionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  sourceEventOffset: z.number().int().positive().optional(),
  message: ProviderJson,
});

const ProviderConnectionIdPayload = z.object({
  connectionId: z.string().min(1),
});

export const VoiceAgentProcessorContract = defineProcessorContract({
  slug: "voice-agent",
  version: "0.1.0",
  description:
    "Forwards appended input PCM frames to Gemini Live, OpenAI Realtime, or Grok Realtime and appends returned output PCM frames back into the same stream.",
  stateSchema: z.object({
    ...standardProcessorBehavior.stateShape,
    setup: VoiceAgentSetup.nullable().default(null),
    inputFrameCount: z.number().int().nonnegative().default(0),
    outputFrameCount: z.number().int().nonnegative().default(0),
    connection: ConnectionState,
    lastInputTranscription: z.string().optional(),
    lastOutputTranscription: z.string().optional(),
  }),
  initialState: {
    ...standardProcessorBehavior.initialState,
  },
  processorDeps: [...standardProcessorBehavior.processorDeps],
  events: {
    // Common voice-agent events.
    [VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE]: {
      description:
        "Required voice-agent setup. Selects the realtime voice provider and provider-specific model/voice configuration before audio starts.",
      payloadSchema: VoiceAgentSetup,
    },
    [VOICE_AGENT_CONFIG_UPDATED_EVENT_TYPE]: {
      description: "Legacy Gemini Live configuration event. Prefer setup-configured.",
      payloadSchema: GeminiSetupPayload.omit({ provider: true }),
    },
    [VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE]: {
      description: "One raw little-endian PCM16 mono microphone frame appended by a client.",
      payloadSchema: VoiceAgentAudioFramePayload.extend({
        sampleRate: z.literal(VOICE_AGENT_INPUT_SAMPLE_RATE),
      }),
    },
    [VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE]: {
      description:
        "One raw little-endian PCM16 mono speaker frame returned by the selected realtime voice provider.",
      payloadSchema: VoiceAgentAudioFramePayload.extend({
        sampleRate: z.literal(VOICE_AGENT_OUTPUT_SAMPLE_RATE),
      }),
    },
    "events.iterate.com/voice-agent/transcription-appended": {
      description: "Provider transcription text for either input or output audio.",
      payloadSchema: z.object({
        connectionId: z.string().min(1),
        direction: z.enum(["input", "output"]),
        text: z.string(),
      }),
    },
    [VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE]: {
      description:
        "Provider-neutral command for subscribed voice clients to drop locally queued speaker audio.",
      payloadSchema: z.object({
        connectionId: z.string().min(1),
        provider: z.union([
          z.literal(VOICE_AGENT_PROVIDER_GEMINI_LIVE),
          z.literal(VOICE_AGENT_PROVIDER_OPENAI_REALTIME),
          z.literal(VOICE_AGENT_PROVIDER_GROK_REALTIME),
        ]),
        reason: z.enum(["output-interrupted", "input-speech-started"]),
        sourceEventType: z.string().min(1),
      }),
    },
    "events.iterate.com/voice-agent/error-occurred": {
      description: "The voice-agent processor could not process or forward an audio frame.",
      payloadSchema: z.object({
        message: z.string().min(1),
        sourceEventOffset: z.number().int().positive().optional(),
      }),
    },

    // Gemini Live events.
    "events.iterate.com/voice-agent/gemini-live-websocket-connected": {
      description: "The backend processor opened a Gemini Live WebSocket.",
      payloadSchema: ProviderWebSocketConnectedPayload,
    },
    "events.iterate.com/voice-agent/gemini-live-websocket-disconnected": {
      description: "The Gemini Live WebSocket closed.",
      payloadSchema: ProviderWebSocketDisconnectedPayload,
    },
    "events.iterate.com/voice-agent/gemini-live-setup-completed": {
      description: "Gemini accepted the session setup message.",
      payloadSchema: ProviderConnectionIdPayload,
    },
    "events.iterate.com/voice-agent/gemini-live-message-sent": {
      description: "A JSON message was sent to Gemini Live.",
      payloadSchema: ProviderMessagePayload,
    },
    "events.iterate.com/voice-agent/gemini-live-message-received": {
      description: "A JSON message was received from Gemini Live.",
      payloadSchema: ProviderMessagePayload.omit({ sourceEventOffset: true }),
    },
    "events.iterate.com/voice-agent/gemini-live-output-interrupted": {
      description: "Gemini reported that user activity interrupted current output.",
      payloadSchema: ProviderConnectionIdPayload,
    },
    "events.iterate.com/voice-agent/gemini-live-turn-completed": {
      description: "Gemini reported that the current model turn completed.",
      payloadSchema: ProviderConnectionIdPayload,
    },

    // OpenAI Realtime events.
    "events.iterate.com/voice-agent/openai-realtime-websocket-connected": {
      description: "The backend processor opened an OpenAI Realtime WebSocket.",
      payloadSchema: ProviderWebSocketConnectedPayload,
    },
    "events.iterate.com/voice-agent/openai-realtime-websocket-disconnected": {
      description: "The OpenAI Realtime WebSocket closed.",
      payloadSchema: ProviderWebSocketDisconnectedPayload,
    },
    "events.iterate.com/voice-agent/openai-realtime-session-updated": {
      description: "OpenAI accepted the session.update message.",
      payloadSchema: ProviderConnectionIdPayload,
    },
    "events.iterate.com/voice-agent/openai-realtime-message-sent": {
      description: "A JSON message was sent to OpenAI Realtime.",
      payloadSchema: ProviderMessagePayload,
    },
    "events.iterate.com/voice-agent/openai-realtime-message-received": {
      description: "A JSON message was received from OpenAI Realtime.",
      payloadSchema: ProviderMessagePayload.omit({ sourceEventOffset: true }),
    },
    "events.iterate.com/voice-agent/openai-realtime-speech-started": {
      description: "OpenAI server VAD detected speech start.",
      payloadSchema: ProviderConnectionIdPayload,
    },
    "events.iterate.com/voice-agent/openai-realtime-speech-stopped": {
      description: "OpenAI server VAD detected speech stop.",
      payloadSchema: ProviderConnectionIdPayload,
    },
    "events.iterate.com/voice-agent/openai-realtime-output-audio-done": {
      description: "OpenAI reported that output audio finished streaming.",
      payloadSchema: ProviderConnectionIdPayload,
    },
    "events.iterate.com/voice-agent/openai-realtime-response-done": {
      description: "OpenAI reported that the current response completed.",
      payloadSchema: ProviderConnectionIdPayload,
    },

    // Grok Realtime events.
    "events.iterate.com/voice-agent/grok-realtime-websocket-connected": {
      description: "The backend processor opened a Grok Realtime WebSocket.",
      payloadSchema: ProviderWebSocketConnectedPayload,
    },
    "events.iterate.com/voice-agent/grok-realtime-websocket-disconnected": {
      description: "The Grok Realtime WebSocket closed.",
      payloadSchema: ProviderWebSocketDisconnectedPayload,
    },
    "events.iterate.com/voice-agent/grok-realtime-session-updated": {
      description: "Grok accepted the session.update message.",
      payloadSchema: ProviderConnectionIdPayload,
    },
    "events.iterate.com/voice-agent/grok-realtime-message-sent": {
      description: "A JSON message was sent to Grok Realtime.",
      payloadSchema: ProviderMessagePayload,
    },
    "events.iterate.com/voice-agent/grok-realtime-message-received": {
      description: "A JSON message was received from Grok Realtime.",
      payloadSchema: ProviderMessagePayload.omit({ sourceEventOffset: true }),
    },
    "events.iterate.com/voice-agent/grok-realtime-speech-started": {
      description: "Grok server VAD detected speech start.",
      payloadSchema: ProviderConnectionIdPayload,
    },
    "events.iterate.com/voice-agent/grok-realtime-speech-stopped": {
      description: "Grok server VAD detected speech stop.",
      payloadSchema: ProviderConnectionIdPayload,
    },
    "events.iterate.com/voice-agent/grok-realtime-output-audio-done": {
      description: "Grok reported that output audio finished streaming.",
      payloadSchema: ProviderConnectionIdPayload,
    },
    "events.iterate.com/voice-agent/grok-realtime-response-done": {
      description: "Grok reported that the current response completed.",
      payloadSchema: ProviderConnectionIdPayload,
    },
  },
  consumes: [
    ...standardProcessorBehavior.consumes,
    VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE,
    VOICE_AGENT_CONFIG_UPDATED_EVENT_TYPE,
    VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
    VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
    "events.iterate.com/voice-agent/transcription-appended",
    VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE,
    "events.iterate.com/voice-agent/error-occurred",
    "events.iterate.com/voice-agent/gemini-live-websocket-connected",
    "events.iterate.com/voice-agent/gemini-live-websocket-disconnected",
    "events.iterate.com/voice-agent/gemini-live-setup-completed",
    "events.iterate.com/voice-agent/gemini-live-message-sent",
    "events.iterate.com/voice-agent/gemini-live-message-received",
    "events.iterate.com/voice-agent/gemini-live-output-interrupted",
    "events.iterate.com/voice-agent/gemini-live-turn-completed",
    "events.iterate.com/voice-agent/openai-realtime-websocket-connected",
    "events.iterate.com/voice-agent/openai-realtime-websocket-disconnected",
    "events.iterate.com/voice-agent/openai-realtime-session-updated",
    "events.iterate.com/voice-agent/openai-realtime-message-sent",
    "events.iterate.com/voice-agent/openai-realtime-message-received",
    "events.iterate.com/voice-agent/openai-realtime-speech-started",
    "events.iterate.com/voice-agent/openai-realtime-speech-stopped",
    "events.iterate.com/voice-agent/openai-realtime-output-audio-done",
    "events.iterate.com/voice-agent/openai-realtime-response-done",
    "events.iterate.com/voice-agent/grok-realtime-websocket-connected",
    "events.iterate.com/voice-agent/grok-realtime-websocket-disconnected",
    "events.iterate.com/voice-agent/grok-realtime-session-updated",
    "events.iterate.com/voice-agent/grok-realtime-message-sent",
    "events.iterate.com/voice-agent/grok-realtime-message-received",
    "events.iterate.com/voice-agent/grok-realtime-speech-started",
    "events.iterate.com/voice-agent/grok-realtime-speech-stopped",
    "events.iterate.com/voice-agent/grok-realtime-output-audio-done",
    "events.iterate.com/voice-agent/grok-realtime-response-done",
  ],
  emits: [
    ...standardProcessorBehavior.emits,
    VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
    "events.iterate.com/voice-agent/transcription-appended",
    VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE,
    "events.iterate.com/voice-agent/error-occurred",
    "events.iterate.com/voice-agent/gemini-live-websocket-connected",
    "events.iterate.com/voice-agent/gemini-live-websocket-disconnected",
    "events.iterate.com/voice-agent/gemini-live-setup-completed",
    "events.iterate.com/voice-agent/gemini-live-message-sent",
    "events.iterate.com/voice-agent/gemini-live-message-received",
    "events.iterate.com/voice-agent/gemini-live-output-interrupted",
    "events.iterate.com/voice-agent/gemini-live-turn-completed",
    "events.iterate.com/voice-agent/openai-realtime-websocket-connected",
    "events.iterate.com/voice-agent/openai-realtime-websocket-disconnected",
    "events.iterate.com/voice-agent/openai-realtime-session-updated",
    "events.iterate.com/voice-agent/openai-realtime-message-sent",
    "events.iterate.com/voice-agent/openai-realtime-message-received",
    "events.iterate.com/voice-agent/openai-realtime-speech-started",
    "events.iterate.com/voice-agent/openai-realtime-speech-stopped",
    "events.iterate.com/voice-agent/openai-realtime-output-audio-done",
    "events.iterate.com/voice-agent/openai-realtime-response-done",
    "events.iterate.com/voice-agent/grok-realtime-websocket-connected",
    "events.iterate.com/voice-agent/grok-realtime-websocket-disconnected",
    "events.iterate.com/voice-agent/grok-realtime-session-updated",
    "events.iterate.com/voice-agent/grok-realtime-message-sent",
    "events.iterate.com/voice-agent/grok-realtime-message-received",
    "events.iterate.com/voice-agent/grok-realtime-speech-started",
    "events.iterate.com/voice-agent/grok-realtime-speech-stopped",
    "events.iterate.com/voice-agent/grok-realtime-output-audio-done",
    "events.iterate.com/voice-agent/grok-realtime-response-done",
  ],
  reduce({ contract, state, event }) {
    const nextState = standardProcessorBehavior.reduce({
      state,
      event,
      contract,
    });

    switch (event.type) {
      // Common reducers.
      case CoreProcessorRegisteredEventType:
        return nextState;
      case VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE:
        return {
          ...nextState,
          setup: event.payload,
          connection: { status: "idle" as const },
        };
      case VOICE_AGENT_CONFIG_UPDATED_EVENT_TYPE:
        return {
          ...nextState,
          setup: {
            provider: "gemini-live" as const,
            model: event.payload.model,
            voiceName: event.payload.voiceName,
            systemInstruction: event.payload.systemInstruction,
          },
          connection: { status: "idle" as const },
        };
      case VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE:
        return { ...nextState, inputFrameCount: nextState.inputFrameCount + 1 };
      case VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE:
        return { ...nextState, outputFrameCount: nextState.outputFrameCount + 1 };
      case "events.iterate.com/voice-agent/transcription-appended":
        return event.payload.direction === "input"
          ? { ...nextState, lastInputTranscription: event.payload.text }
          : { ...nextState, lastOutputTranscription: event.payload.text };
      case VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE:
        return nextState;
      case "events.iterate.com/voice-agent/error-occurred":
        return {
          ...nextState,
          connection: { status: "error" as const, message: event.payload.message },
        };

      // Gemini Live reducers.
      case "events.iterate.com/voice-agent/gemini-live-websocket-connected":
        return {
          ...nextState,
          connection: {
            status: "connected" as const,
            connectionId: event.payload.connectionId,
            provider: "gemini-live" as const,
          },
        };
      case "events.iterate.com/voice-agent/gemini-live-websocket-disconnected":
        return {
          ...nextState,
          connection: {
            status: "disconnected" as const,
            connectionId: event.payload.connectionId,
            provider: "gemini-live" as const,
            reason: event.payload.reason,
          },
        };
      case "events.iterate.com/voice-agent/gemini-live-message-sent":
      case "events.iterate.com/voice-agent/gemini-live-message-received":
      case "events.iterate.com/voice-agent/gemini-live-setup-completed":
      case "events.iterate.com/voice-agent/gemini-live-output-interrupted":
      case "events.iterate.com/voice-agent/gemini-live-turn-completed":
        return nextState;

      // OpenAI Realtime reducers.
      case "events.iterate.com/voice-agent/openai-realtime-websocket-connected":
        return {
          ...nextState,
          connection: {
            status: "connected" as const,
            connectionId: event.payload.connectionId,
            provider: "openai-realtime" as const,
          },
        };
      case "events.iterate.com/voice-agent/openai-realtime-websocket-disconnected":
        return {
          ...nextState,
          connection: {
            status: "disconnected" as const,
            connectionId: event.payload.connectionId,
            provider: "openai-realtime" as const,
            reason: event.payload.reason,
          },
        };
      case "events.iterate.com/voice-agent/openai-realtime-session-updated":
      case "events.iterate.com/voice-agent/openai-realtime-message-sent":
      case "events.iterate.com/voice-agent/openai-realtime-message-received":
      case "events.iterate.com/voice-agent/openai-realtime-speech-started":
      case "events.iterate.com/voice-agent/openai-realtime-speech-stopped":
      case "events.iterate.com/voice-agent/openai-realtime-output-audio-done":
      case "events.iterate.com/voice-agent/openai-realtime-response-done":
        return nextState;

      // Grok Realtime reducers.
      case "events.iterate.com/voice-agent/grok-realtime-websocket-connected":
        return {
          ...nextState,
          connection: {
            status: "connected" as const,
            connectionId: event.payload.connectionId,
            provider: "grok-realtime" as const,
          },
        };
      case "events.iterate.com/voice-agent/grok-realtime-websocket-disconnected":
        return {
          ...nextState,
          connection: {
            status: "disconnected" as const,
            connectionId: event.payload.connectionId,
            provider: "grok-realtime" as const,
            reason: event.payload.reason,
          },
        };
      case "events.iterate.com/voice-agent/grok-realtime-session-updated":
      case "events.iterate.com/voice-agent/grok-realtime-message-sent":
      case "events.iterate.com/voice-agent/grok-realtime-message-received":
      case "events.iterate.com/voice-agent/grok-realtime-speech-started":
      case "events.iterate.com/voice-agent/grok-realtime-speech-stopped":
      case "events.iterate.com/voice-agent/grok-realtime-output-audio-done":
      case "events.iterate.com/voice-agent/grok-realtime-response-done":
        return nextState;
      default:
        return assertNever(event);
    }
  },
});

export function reduceVoiceAgentEvents(args: {
  events: readonly StreamEvent[];
  state?: VoiceAgentState;
}): VoiceAgentState {
  return reduceProcessorEvents({
    contract: VoiceAgentProcessorContract,
    events: args.events,
    state: args.state,
  });
}

export type VoiceAgentState = z.infer<typeof VoiceAgentProcessorContract.stateSchema>;
export type VoiceAgentProvider = z.infer<typeof VoiceAgentSetup>["provider"];
export type VoiceAgentSetup = z.infer<typeof VoiceAgentSetup>;
export type VoiceAgentAudioFramePayload = z.infer<typeof VoiceAgentAudioFramePayload>;
