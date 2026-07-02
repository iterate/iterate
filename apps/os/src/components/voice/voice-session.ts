// Browser port of the voice ↔ itx multiplexer (reference implementation:
// apps/os/scripts/voice/bridge.ts — the Node CLI variant). One VoiceSession
// holds two connections:
//
//   - a realtime voice WebSocket (OpenAI Realtime; Grok is wire-compatible)
//     authenticated with a server-minted ephemeral client secret, and
//   - the project's itx socket, through which a worker agent does the work.
//
// Realtime voice models are unreliable tool callers, so the session does not
// depend on one: every completed user turn is forwarded to the worker agent
// (`agent.sendMessage`), and the agent's reply is injected back into the
// voice conversation as a `[worker report] …` item plus `response.create`,
// so the voice agent relays results out loud. An `ask_assistant` function
// tool is registered too — when the voice model does call it, the call is
// acked immediately.
//
// Plain class + subscribe/getSnapshot so React renders it with
// useSyncExternalStore; all lifecycle is imperative and owned here.

import { connectItx } from "~/itx/itx-react.tsx";
import type { VoiceRealtimeConnection } from "~/lib/voice-server-fns.ts";

const WORKER_REPLY_EVENT = "events.iterate.com/agents/web-message-sent";
const WORKER_IDLE_REPLY = "(idle)";
const WORKER_REPLY_TIMEOUT_MS = 120_000;
const AUDIO_SAMPLE_RATE = 24_000;

const VOICE_AGENT_INSTRUCTIONS = `
You are Iterate's voice assistant — the spoken front-end of a two-agent team.
Alongside you runs a "worker" agent connected to the user's Iterate project.
The worker hears everything the user says and does all actual work: running
scripts, listing files and repos, managing the project. You cannot do any of
that yourself, and you must never invent results.

When the user asks for something actionable, acknowledge briefly and naturally
("on it", "let me get that going") — the worker is already working on it.

Messages starting with "[worker report]" are not from the human: they are
results arriving from the worker. Relay their substance to the user
conversationally and concisely.

Keep every response short. This is a spoken conversation.
`.trim();

const ASK_ASSISTANT_TOOL = {
  type: "function",
  name: "ask_assistant",
  description:
    "Send a natural-language request to the worker agent connected to the user's Iterate project. The worker replies asynchronously as a later [worker report] message; this call returns immediately with an acknowledgement.",
  parameters: {
    type: "object",
    properties: {
      request: { type: "string", description: "The request, phrased for the worker agent." },
    },
    required: ["request"],
  },
};

export type VoiceTranscriptEntry = {
  id: number;
  kind: "you" | "assistant" | "worker-request" | "worker-reply" | "status" | "error";
  text: string;
};

export type VoiceSessionSnapshot = {
  status: "idle" | "connecting" | "live" | "ended";
  micActive: boolean;
  entries: VoiceTranscriptEntry[];
};

export class VoiceSession {
  #projectId: string;
  #agentPath: string;
  #mint: () => Promise<VoiceRealtimeConnection>;

  #socket: WebSocket | null = null;
  #listeners = new Set<() => void>();
  #snapshot: VoiceSessionSnapshot = { status: "idle", micActive: false, entries: [] };
  #nextEntryId = 1;

  // The realtime API rejects `response.create` while a response is active, so
  // worker reports queue until the current response finishes.
  #responseActive = false;
  #injectionQueue: (() => void)[] = [];

  // User-turn transcripts keyed by conversation item id; turn end is
  // `input_audio_transcription.completed` or the VAD starting a response,
  // whichever comes first (the other is deduped).
  #turnTranscripts = new Map<string, string>();
  #forwardedItems = new Set<string>();
  #openAssistantEntryId: number | null = null;

  #micContext: AudioContext | null = null;
  #micStream: MediaStream | null = null;
  #playbackContext: AudioContext | null = null;
  #playbackCursor = 0;
  #playbackSources = new Set<AudioBufferSourceNode>();

  constructor(input: {
    projectId: string;
    agentPath: string;
    mint: () => Promise<VoiceRealtimeConnection>;
  }) {
    this.#projectId = input.projectId;
    this.#agentPath = input.agentPath;
    this.#mint = input.mint;
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = () => this.#snapshot;

  get agentPath() {
    return this.#agentPath;
  }

  async start(input: { withMic: boolean }) {
    if (this.#snapshot.status !== "idle" && this.#snapshot.status !== "ended") return;
    this.#update({ status: "connecting" });

    const connection = await this.#mint();
    const socket = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(connection.model)}`,
      ["realtime", `openai-insecure-api-key.${connection.clientSecret}`],
    );
    this.#socket = socket;

    socket.addEventListener("open", () => {
      this.#send({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: VOICE_AGENT_INSTRUCTIONS,
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcm", rate: AUDIO_SAMPLE_RATE },
              transcription: { model: "gpt-4o-mini-transcribe" },
              turn_detection: { type: "server_vad" },
            },
            output: { format: { type: "audio/pcm", rate: AUDIO_SAMPLE_RATE }, voice: "marin" },
          },
          tools: [ASK_ASSISTANT_TOOL],
        },
      });
      this.#update({ status: "live" });
      this.#addEntry("status", `connected (${connection.provider} ${connection.model})`);
    });
    socket.addEventListener("message", (message) => {
      this.#onServerEvent(JSON.parse(String(message.data)) as Record<string, unknown>);
    });
    socket.addEventListener("close", (event) => {
      if (this.#snapshot.status === "live" || this.#snapshot.status === "connecting") {
        this.#addEntry("status", `voice connection closed (${event.code})`);
      }
      this.#update({ status: "ended" });
      this.#teardownAudio();
    });
    socket.addEventListener("error", () => {
      this.#addEntry("error", "voice websocket error — see devtools console");
    });

    if (input.withMic) {
      try {
        await this.#startMic();
      } catch (error) {
        this.#addEntry(
          "error",
          `microphone unavailable (${error instanceof Error ? error.message : String(error)}) — text input still works`,
        );
      }
    }
  }

  stop() {
    this.#socket?.close(1000);
    this.#socket = null;
    this.#teardownAudio();
    this.#update({ status: "ended" });
  }

  /** Text lane: same multiplexing path as speech, minus the audio. */
  sendText(text: string) {
    const trimmed = text.trim();
    if (!trimmed || this.#snapshot.status !== "live") return;
    this.#addEntry("you", trimmed);
    this.#whenResponseIdle(() => {
      this.#send(userTextItem(trimmed));
      this.#send({ type: "response.create" });
    });
    this.#forwardTurn(trimmed);
  }

  #onServerEvent(event: Record<string, unknown>) {
    const type = String(event.type);
    switch (type) {
      case "response.created": {
        this.#responseActive = true;
        // VAD starting a response means the user's turn ended — forward even
        // if the transcription `.completed` event never arrives.
        for (const itemId of this.#turnTranscripts.keys()) this.#forwardTurnFromItem(itemId);
        return;
      }
      case "response.done": {
        this.#openAssistantEntryId = null;
        this.#responseActive = false;
        const inject = this.#injectionQueue.shift();
        inject?.();
        return;
      }
      case "conversation.item.input_audio_transcription.delta":
      case "conversation.item.input_audio_transcription.updated": {
        const itemId = String(event.item_id);
        const previous = type.endsWith("delta") ? this.#turnTranscripts.get(itemId) || "" : "";
        this.#turnTranscripts.set(itemId, previous + String(event.transcript || event.delta || ""));
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const itemId = String(event.item_id);
        this.#turnTranscripts.set(itemId, String(event.transcript || ""));
        this.#forwardTurnFromItem(itemId);
        return;
      }
      case "response.function_call_arguments.done": {
        this.#addEntry("status", `voice model called ${String(event.name)} (acked)`);
        this.#send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: event.call_id,
            output: JSON.stringify({ status: "forwarded to worker; report will follow" }),
          },
        });
        this.#whenResponseIdle(() => this.#send({ type: "response.create" }));
        return;
      }
      case "response.output_audio.delta":
      case "response.audio.delta": {
        this.#playAudioDelta(String(event.delta));
        return;
      }
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
      case "response.output_text.delta": {
        this.#appendAssistantDelta(String(event.delta));
        return;
      }
      case "input_audio_buffer.speech_started": {
        this.#stopPlayback(); // barge-in
        return;
      }
      case "error": {
        this.#addEntry("error", JSON.stringify(event.error || event));
        return;
      }
      default:
        return;
    }
  }

  #forwardTurnFromItem(itemId: string) {
    if (this.#forwardedItems.has(itemId)) return;
    const transcript = this.#turnTranscripts.get(itemId);
    if (!transcript?.trim()) return;
    this.#forwardedItems.add(itemId);
    this.#addEntry("you", transcript.trim());
    this.#forwardTurn(transcript.trim());
  }

  #forwardTurn(text: string) {
    this.#addEntry("worker-request", text);
    void this.#askWorker(text)
      .then((reply) => {
        if (reply === WORKER_IDLE_REPLY) {
          this.#addEntry("worker-reply", "(idle — nothing to report)");
          return;
        }
        this.#addEntry("worker-reply", reply);
        this.#whenResponseIdle(() => {
          this.#send(userTextItem(`[worker report] ${reply}`));
          this.#send({ type: "response.create" });
        });
      })
      .catch((error: Error) => {
        this.#addEntry("error", `worker error: ${error.message}`);
        this.#whenResponseIdle(() => {
          this.#send(userTextItem(`[worker report] The worker hit an error: ${error.message}`));
          this.#send({ type: "response.create" });
        });
      });
  }

  async #askWorker(text: string) {
    const message = [
      text,
      '(You are the worker agent behind a live voice assistant; the message above is one transcribed voice turn. Reply concisely — your reply is read aloud. If it needs no action or answer, reply exactly "(idle)".)',
    ].join("\n\n");
    const itx = await connectItx({ projectId: this.#projectId });
    const agent = itx.agents.get(this.#agentPath);
    const sent = await agent.sendMessage(message);
    const reply = await agent.stream.waitForEvent({
      afterOffset: sent.offset,
      eventTypes: [WORKER_REPLY_EVENT],
      timeoutMs: WORKER_REPLY_TIMEOUT_MS,
    });
    const payload = reply.payload as { message?: unknown };
    return typeof payload.message === "string" ? payload.message.trim() : JSON.stringify(payload);
  }

  // ---------------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------------

  async #startMic() {
    // The browser does the hard part the CLI can't: echo cancellation, so the
    // assistant doesn't hear itself through the speakers and barge-in on itself.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const context = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
    const workletUrl = URL.createObjectURL(
      new Blob([PCM_CAPTURE_WORKLET], { type: "application/javascript" }),
    );
    await context.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, "pcm16-capture");
    // Batch worklet frames (128 samples ≈ 5ms) into ~40ms sends.
    let pending: Float32Array[] = [];
    let pendingSamples = 0;
    capture.port.onmessage = (message) => {
      pending.push(message.data as Float32Array);
      pendingSamples += (message.data as Float32Array).length;
      if (pendingSamples < AUDIO_SAMPLE_RATE / 25) return;
      this.#send({ type: "input_audio_buffer.append", audio: floatChunksToBase64Pcm16(pending) });
      pending = [];
      pendingSamples = 0;
    };
    source.connect(capture);

    this.#micStream = stream;
    this.#micContext = context;
    this.#update({ micActive: true });
    this.#addEntry("status", "microphone live — just talk");
  }

  #playAudioDelta(base64: string) {
    const context = (this.#playbackContext ??= new AudioContext({
      sampleRate: AUDIO_SAMPLE_RATE,
    }));
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer);
    const floats = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i] / 32768;
    const buffer = context.createBuffer(1, floats.length, AUDIO_SAMPLE_RATE);
    buffer.copyToChannel(floats, 0);
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(context.destination);
    this.#playbackCursor = Math.max(this.#playbackCursor, context.currentTime + 0.05);
    node.start(this.#playbackCursor);
    this.#playbackCursor += buffer.duration;
    this.#playbackSources.add(node);
    node.onended = () => this.#playbackSources.delete(node);
  }

  #stopPlayback() {
    for (const node of this.#playbackSources) {
      try {
        node.stop();
      } catch {
        // already stopped
      }
    }
    this.#playbackSources.clear();
    this.#playbackCursor = 0;
  }

  #teardownAudio() {
    this.#stopPlayback();
    this.#micStream?.getTracks().forEach((track) => track.stop());
    void this.#micContext?.close();
    void this.#playbackContext?.close();
    this.#micStream = null;
    this.#micContext = null;
    this.#playbackContext = null;
    this.#update({ micActive: false });
  }

  // ---------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------

  #send(event: Record<string, unknown>) {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(event));
  }

  #whenResponseIdle(inject: () => void) {
    if (this.#responseActive) this.#injectionQueue.push(inject);
    else inject();
  }

  #appendAssistantDelta(delta: string) {
    if (this.#openAssistantEntryId === null) {
      this.#openAssistantEntryId = this.#addEntry("assistant", delta);
      return;
    }
    const id = this.#openAssistantEntryId;
    this.#update({
      entries: this.#snapshot.entries.map((entry) =>
        entry.id === id ? { ...entry, text: entry.text + delta } : entry,
      ),
    });
  }

  #addEntry(kind: VoiceTranscriptEntry["kind"], text: string) {
    const id = this.#nextEntryId++;
    this.#update({ entries: [...this.#snapshot.entries, { id, kind, text }] });
    return id;
  }

  #update(patch: Partial<VoiceSessionSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

const PCM_CAPTURE_WORKLET = `
registerProcessor("pcm16-capture", class extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
});
`;

function floatChunksToBase64Pcm16(chunks: Float32Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const pcm = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const sample = Math.max(-1, Math.min(1, chunk[i]));
      pcm[offset++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
  }
  let binary = "";
  const bytes = new Uint8Array(pcm.buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function userTextItem(text: string) {
  return {
    type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
}
