// Thin WebSocket client for realtime voice APIs. Two dialects, one wire shape:
// the Grok Voice Agent API (https://docs.x.ai/developers/model-capabilities/audio/voice-agent)
// is compatible with the OpenAI Realtime API, so the only per-provider parts
// are the URL, the auth env var, and the `session.update` payload.

import WebSocket from "ws";

type RealtimeProvider = "grok" | "openai";

type FunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type RealtimeServerEvent = {
  type: string;
  [key: string]: unknown;
};

type RealtimeSessionConfig = {
  provider: RealtimeProvider;
  model: string;
  apiKey: string;
  instructions: string;
  /** Provider voice name. Grok: eve/ara/rex/sal/leo. OpenAI: marin/cedar/alloy/… */
  voice: string;
  tools: FunctionTool[];
  /** True when we will stream mic audio (enables server VAD + input transcription). */
  audioInput: boolean;
  onEvent: (event: RealtimeServerEvent) => void;
  onClose: (info: { code: number; reason: string }) => void;
};

export function resolveProvider(explicit: string | undefined): RealtimeProvider {
  if (explicit === "grok" || explicit === "openai") return explicit;
  if (explicit) throw new Error(`Unknown provider ${JSON.stringify(explicit)}: grok | openai`);
  if (process.env.XAI_API_KEY?.trim()) return "grok";
  if (process.env.OPENAI_API_KEY?.trim()) return "openai";
  throw new Error("Set XAI_API_KEY or OPENAI_API_KEY (or pass --provider explicitly).");
}

export const providerDefaults = {
  grok: { model: "grok-voice-latest", voice: "ara", apiKeyEnvVar: "XAI_API_KEY" },
  openai: { model: "gpt-realtime", voice: "marin", apiKeyEnvVar: "OPENAI_API_KEY" },
} satisfies Record<RealtimeProvider, { model: string; voice: string; apiKeyEnvVar: string }>;

type RealtimeSession = {
  send(event: Record<string, unknown>): void;
  close(): void;
  /** Resolves once the socket is open and `session.update` has been sent. */
  ready: Promise<void>;
};

export function connectRealtime(config: RealtimeSessionConfig): RealtimeSession {
  const url =
    config.provider === "grok"
      ? `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(config.model)}`
      : `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.model)}`;

  const socket = new WebSocket(url, {
    handshakeTimeout: 15_000,
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });

  const send = (event: Record<string, unknown>) => {
    socket.send(JSON.stringify(event));
  };

  const ready = new Promise<void>((resolve, reject) => {
    socket.on("open", () => {
      send(sessionUpdateEvent(config));
      resolve();
    });
    socket.on("error", (error) => reject(error));
  });

  socket.on("message", (data) => {
    config.onEvent(JSON.parse(String(data)) as RealtimeServerEvent);
  });
  socket.on("close", (code, reason) => {
    config.onClose({ code, reason: String(reason) });
  });

  return { send, close: () => socket.close(), ready };
}

// PCM16 mono 24kHz on both legs, both providers.
export const AUDIO_SAMPLE_RATE = 24_000;

function sessionUpdateEvent(config: RealtimeSessionConfig) {
  const audioFormat = { type: "audio/pcm", rate: AUDIO_SAMPLE_RATE };
  if (config.provider === "grok") {
    return {
      type: "session.update",
      session: {
        voice: config.voice,
        instructions: config.instructions,
        turn_detection: config.audioInput ? { type: "server_vad" } : null,
        audio: {
          input: { format: audioFormat, transcription: { language_hint: "en" } },
          output: { format: audioFormat },
        },
        tools: config.tools,
      },
    };
  }
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: config.instructions,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: audioFormat,
          transcription: { model: "gpt-4o-mini-transcribe" },
          turn_detection: config.audioInput ? { type: "server_vad" } : null,
        },
        output: { format: audioFormat, voice: config.voice },
      },
      tools: config.tools,
    },
  };
}
