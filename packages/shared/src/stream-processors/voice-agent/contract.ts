import { z } from "zod";
import { assertNever, defineProcessorContract } from "../stream-processor.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import { AgentProcessorContract } from "../agent/contract.ts";

export const VOICE_AGENT_PROVIDER_GEMINI_LIVE = "gemini-live" as const;
export const VOICE_AGENT_PROVIDER_OPENAI_REALTIME = "openai-realtime" as const;
export const VOICE_AGENT_PROVIDER_GROK_REALTIME = "grok-realtime" as const;

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
export const VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE =
  "events.iterate.com/voice-agent/input-text-appended";
export const VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE =
  "events.iterate.com/voice-agent/output-audio-frame-appended";
export const VOICE_AGENT_OUTPUT_TEXT_APPENDED_EVENT_TYPE =
  "events.iterate.com/voice-agent/output-text-appended";
export const VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE =
  "events.iterate.com/voice-agent/speaker-buffer-clear-requested";
export const VOICE_AGENT_ERROR_OCCURRED_EVENT_TYPE =
  "events.iterate.com/voice-agent/error-occurred";
export const VOICE_AGENT_PROVIDER_CONNECTED_EVENT_TYPE =
  "events.iterate.com/voice-agent/provider-connected";
export const VOICE_AGENT_PROVIDER_DISCONNECTED_EVENT_TYPE =
  "events.iterate.com/voice-agent/provider-disconnected";
export const VOICE_AGENT_PROVIDER_SESSION_READY_EVENT_TYPE =
  "events.iterate.com/voice-agent/provider-session-ready";
export const VOICE_AGENT_PROVIDER_MESSAGE_SENT_EVENT_TYPE =
  "events.iterate.com/voice-agent/provider-message-sent";
export const VOICE_AGENT_PROVIDER_MESSAGE_RECEIVED_EVENT_TYPE =
  "events.iterate.com/voice-agent/provider-message-received";
export const VOICE_AGENT_PROVIDER_STATUS_CHANGED_EVENT_TYPE =
  "events.iterate.com/voice-agent/provider-status-changed";
export const AGENT_INPUT_ADDED_EVENT_TYPE = "events.iterate.com/agent/input-added";

export const VoiceAgentProvider = z.enum([
  VOICE_AGENT_PROVIDER_GEMINI_LIVE,
  VOICE_AGENT_PROVIDER_OPENAI_REALTIME,
  VOICE_AGENT_PROVIDER_GROK_REALTIME,
]);

export const VOICE_AGENT_PROVIDER_STATUSES = [
  "speech-started",
  "speech-stopped",
  "output-audio-done",
  "response-done",
  "output-interrupted",
  "turn-completed",
  "going-away",
] as const;

const VoiceAgentProviderStatus = z.enum(VOICE_AGENT_PROVIDER_STATUSES);

const VoiceAgentAudioFramePayload = z.object({
  streamId: z.string().trim().min(1),
  sequence: z.number().int().nonnegative(),
  encoding: z.literal("pcm_s16le"),
  sampleRate: z.number().int().positive(),
  channels: z.literal(1),
  durationMs: z.number().int().nonnegative(),
  dataBase64: z.string().trim().min(1),
});

const VoiceAgentInputTextPayload = z.object({
  text: z.string().trim().min(1),
  source: z.string().trim().min(1).optional(),
});

const VoiceAgentOutputTextPayload = z.object({
  connectionId: z.string().min(1).optional(),
  text: z.string().trim().min(1),
  source: z.enum(["input-transcription", "output-transcription", "provider-text"]).optional(),
});

const MessageAgentToolChoice = z.enum(["auto", "required"]).default("auto");

function providerSetupSchema<const Provider extends string>(
  provider: Provider,
  defaults: { model: string; voiceName: string },
) {
  return z.object({
    provider: z.literal(provider),
    model: z.string().trim().min(1).default(defaults.model),
    voiceName: z.string().trim().min(1).default(defaults.voiceName),
    systemInstruction: z.string().default(DEFAULT_VOICE_AGENT_SYSTEM_INSTRUCTION),
    messageAgentToolChoice: MessageAgentToolChoice,
  });
}

const GeminiSetupPayload = providerSetupSchema(VOICE_AGENT_PROVIDER_GEMINI_LIVE, {
  model: DEFAULT_GEMINI_LIVE_MODEL,
  voiceName: DEFAULT_GEMINI_LIVE_VOICE,
});

const VoiceAgentSetup = z.discriminatedUnion("provider", [
  GeminiSetupPayload,
  providerSetupSchema(VOICE_AGENT_PROVIDER_OPENAI_REALTIME, {
    model: DEFAULT_OPENAI_REALTIME_MODEL,
    voiceName: DEFAULT_OPENAI_REALTIME_VOICE,
  }),
  providerSetupSchema(VOICE_AGENT_PROVIDER_GROK_REALTIME, {
    model: DEFAULT_GROK_REALTIME_MODEL,
    voiceName: DEFAULT_GROK_REALTIME_VOICE,
  }),
]);

const ProviderConnectionPayload = z.object({
  provider: VoiceAgentProvider,
  connectionId: z.string().min(1),
});

export const VoiceAgentProcessorContract = defineProcessorContract({
  slug: "voice-agent",
  version: "0.2.0",
  description:
    "Forwards appended input PCM frames and text to the realtime voice provider selected by setup-configured (Gemini Live, OpenAI Realtime, or Grok Realtime) and appends returned output PCM frames back into the same stream.",
  stateSchema: z.object({
    ...standardProcessorBehavior.stateShape,
    setup: VoiceAgentSetup.nullable().default(null),
  }),
  initialState: {
    ...standardProcessorBehavior.initialState,
  },
  processorDeps: [...standardProcessorBehavior.processorDeps, AgentProcessorContract],
  events: {
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
    [VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE]: {
      description:
        "Authoritative text input/context to send to the selected realtime voice model. Voice clients should not speak this text directly.",
      payloadSchema: VoiceAgentInputTextPayload,
    },
    [VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE]: {
      description:
        "One raw little-endian PCM16 mono speaker frame returned by the selected realtime voice provider.",
      payloadSchema: VoiceAgentAudioFramePayload.extend({
        sampleRate: z.literal(VOICE_AGENT_OUTPUT_SAMPLE_RATE),
      }),
    },
    [VOICE_AGENT_OUTPUT_TEXT_APPENDED_EVENT_TYPE]: {
      description:
        "Text produced by the selected realtime voice provider, usually a transcript or diagnostic text.",
      payloadSchema: VoiceAgentOutputTextPayload,
    },
    [VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE]: {
      description:
        "Provider-neutral command for subscribed voice clients to drop locally queued speaker audio.",
      payloadSchema: ProviderConnectionPayload.extend({
        reason: z.enum(["output-interrupted", "input-speech-started"]),
      }),
    },
    [VOICE_AGENT_ERROR_OCCURRED_EVENT_TYPE]: {
      description: "The voice-agent processor could not process or forward an input event.",
      payloadSchema: z.object({
        message: z.string().min(1),
        sourceEventOffset: z.number().int().positive().optional(),
      }),
    },
    [VOICE_AGENT_PROVIDER_CONNECTED_EVENT_TYPE]: {
      description: "The processor opened a WebSocket to the selected realtime voice provider.",
      payloadSchema: ProviderConnectionPayload.extend({
        model: z.string().min(1),
        url: z.string().url(),
      }),
    },
    [VOICE_AGENT_PROVIDER_DISCONNECTED_EVENT_TYPE]: {
      description: "The realtime voice provider WebSocket closed.",
      payloadSchema: ProviderConnectionPayload.extend({
        code: z.number().int().optional(),
        reason: z.string().optional(),
        wasClean: z.boolean().optional(),
      }),
    },
    [VOICE_AGENT_PROVIDER_SESSION_READY_EVENT_TYPE]: {
      description: "The realtime voice provider acknowledged session setup and is ready for audio.",
      payloadSchema: ProviderConnectionPayload,
    },
    [VOICE_AGENT_PROVIDER_MESSAGE_SENT_EVENT_TYPE]: {
      description:
        "Audit copy of a JSON message sent to the provider. Large strings (audio payloads) are redacted.",
      payloadSchema: ProviderConnectionPayload.extend({
        sequence: z.number().int().nonnegative(),
        sourceEventOffset: z.number().int().positive().optional(),
        message: z.json(),
      }),
    },
    [VOICE_AGENT_PROVIDER_MESSAGE_RECEIVED_EVENT_TYPE]: {
      description:
        "Audit copy of a JSON message received from the provider. Large strings (audio payloads) are redacted.",
      payloadSchema: ProviderConnectionPayload.extend({
        sequence: z.number().int().nonnegative(),
        message: z.json(),
      }),
    },
    [VOICE_AGENT_PROVIDER_STATUS_CHANGED_EVENT_TYPE]: {
      description:
        "Provider-neutral session status signal (speech start/stop, turn completion, interruption, imminent provider shutdown).",
      payloadSchema: ProviderConnectionPayload.extend({
        status: VoiceAgentProviderStatus,
      }),
    },
  },
  consumes: [
    ...standardProcessorBehavior.consumes,
    VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE,
    VOICE_AGENT_CONFIG_UPDATED_EVENT_TYPE,
    VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
    VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE,
  ],
  emits: [
    ...standardProcessorBehavior.emits,
    VOICE_AGENT_OUTPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE,
    VOICE_AGENT_OUTPUT_TEXT_APPENDED_EVENT_TYPE,
    VOICE_AGENT_SPEAKER_BUFFER_CLEAR_REQUESTED_EVENT_TYPE,
    VOICE_AGENT_ERROR_OCCURRED_EVENT_TYPE,
    VOICE_AGENT_PROVIDER_CONNECTED_EVENT_TYPE,
    VOICE_AGENT_PROVIDER_DISCONNECTED_EVENT_TYPE,
    VOICE_AGENT_PROVIDER_SESSION_READY_EVENT_TYPE,
    VOICE_AGENT_PROVIDER_MESSAGE_SENT_EVENT_TYPE,
    VOICE_AGENT_PROVIDER_MESSAGE_RECEIVED_EVENT_TYPE,
    VOICE_AGENT_PROVIDER_STATUS_CHANGED_EVENT_TYPE,
    AGENT_INPUT_ADDED_EVENT_TYPE,
  ],
  reduce({ contract, state, event }) {
    const nextState = standardProcessorBehavior.reduce({
      state,
      event,
      contract,
    });

    switch (event.type) {
      case CoreProcessorRegisteredEventType:
      case VOICE_AGENT_INPUT_AUDIO_FRAME_APPENDED_EVENT_TYPE:
      case VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE:
        return nextState;
      case VOICE_AGENT_SETUP_CONFIGURED_EVENT_TYPE:
        return { ...nextState, setup: event.payload };
      case VOICE_AGENT_CONFIG_UPDATED_EVENT_TYPE:
        return {
          ...nextState,
          setup: {
            provider: VOICE_AGENT_PROVIDER_GEMINI_LIVE,
            model: event.payload.model,
            voiceName: event.payload.voiceName,
            systemInstruction: event.payload.systemInstruction,
            messageAgentToolChoice: event.payload.messageAgentToolChoice,
          },
        };
      default:
        return assertNever(event);
    }
  },
});

export type VoiceAgentState = z.infer<typeof VoiceAgentProcessorContract.stateSchema>;
export type VoiceAgentProvider = z.infer<typeof VoiceAgentProvider>;
export type VoiceAgentSetup = z.infer<typeof VoiceAgentSetup>;
export type VoiceAgentProviderStatus = z.infer<typeof VoiceAgentProviderStatus>;
