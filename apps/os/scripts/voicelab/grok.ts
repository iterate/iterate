// Thin client for the xAI Grok Voice realtime WebSocket.
// transport "binary": mic PCM goes out as binary WS frames and speaker PCM arrives
// as binary frames. transport "json": base64 audio inside input_audio_buffer.append /
// response.output_audio.delta events. Everything else is JSON events either way.
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { SAMPLE_RATE } from "./audio.ts";

export const DEFAULT_GROK_MODEL = "grok-voice-think-fast-2.0";

/** Options for {@link GrokClient}. */
export interface GrokClientOptions {
  apiKey: string;
  /** WebSocket endpoint override (a proxy speaking the Grok realtime protocol). */
  url?: string;
  model?: string;
  voice?: string;
  instructions?: string;
  /** "none" for lowest latency, "high" for thinking answers. */
  reasoningEffort?: "none" | "high";
  transport?: "binary" | "json";
  vadThreshold?: number;
  silenceDurationMs?: number;
  inputRate?: number;
  outputRate?: number;
}

/**
 * Emits: `ready` (session.updated seen), `audio` (Buffer of PCM16), `event`
 * (every parsed JSON event), `close`, `error`.
 */
export class GrokClient extends EventEmitter {
  readonly options: Required<Omit<GrokClientOptions, "apiKey" | "url">> & {
    apiKey: string;
    url?: string;
  };
  ready = false;
  private ws: WebSocket | undefined;

  constructor(options: GrokClientOptions) {
    super();
    this.options = {
      model: DEFAULT_GROK_MODEL,
      voice: "eve",
      instructions:
        "You are a concise voice assistant. Answer in one short sentence unless asked for detail.",
      reasoningEffort: "none",
      transport: "binary",
      vadThreshold: 0.5,
      silenceDurationMs: 500,
      inputRate: SAMPLE_RATE,
      outputRate: SAMPLE_RATE,
      ...options,
    };
  }

  connect(): this {
    const o = this.options;
    const url = o.url ?? `wss://api.x.ai/v1/realtime?model=${o.model}`;
    this.ws = new WebSocket(url, {
      headers: o.apiKey === "" ? {} : { Authorization: `Bearer ${o.apiKey}` },
      perMessageDeflate: false,
    });
    this.ws.on("open", () => {
      this.send({
        type: "session.update",
        session: {
          voice: o.voice,
          instructions: o.instructions,
          reasoning: { effort: o.reasoningEffort },
          turn_detection: {
            type: "server_vad",
            threshold: o.vadThreshold,
            silence_duration_ms: o.silenceDurationMs,
          },
          audio: {
            input: { format: { type: "audio/pcm", rate: o.inputRate }, transport: o.transport },
            output: { format: { type: "audio/pcm", rate: o.outputRate }, transport: o.transport },
          },
        },
      });
    });
    this.ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.emit("audio", Buffer.from(data));
        return;
      }
      const event = JSON.parse(data.toString()) as Record<string, unknown> & { type: string };
      if (event.type === "session.updated" && !this.ready) {
        this.ready = true;
        this.emit("ready");
      }
      if (event.type === "response.output_audio.delta" || event.type === "response.audio.delta") {
        this.emit("audio", Buffer.from(event.delta as string, "base64"));
        return;
      }
      if (event.type === "error") {
        this.emit("error", new Error(`grok: ${JSON.stringify(event.error ?? event)}`));
      }
      this.emit("event", event);
    });
    this.ws.on("close", (code, reason) => this.emit("close", code, reason.toString()));
    this.ws.on("error", (error) => this.emit("error", error));
    return this;
  }

  send(event: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }

  sendAudio(pcm: Buffer) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.options.transport === "binary") this.ws.send(pcm);
    else this.send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
  }

  close() {
    this.ws?.close();
  }
}
