// Browser I/O pump for the voice ↔ itx bridge. One VoiceSession holds two
// connections:
//
//   - a realtime voice WebSocket (OpenAI Realtime; Grok is wire-compatible)
//     authenticated with a server-minted ephemeral client secret, and
//   - the project's itx socket, over which conversation facts flow to and
//     from the worker agent's stream.
//
// The multiplexing brain lives server-side in the `voice` stream processor
// (apps/os/src/domains/voice/): this client only appends raw facts
// (`voice/user-turn-transcribed`, plus audit events) and relays
// `voice/say-requested` projections into the realtime conversation. An
// `ask_assistant` function tool is registered for when the voice model
// spontaneously calls one (acked, not depended on), and `no_comment` gives it
// a structurally silent out for redundant reports.
//
// Plain class + subscribe/getSnapshot so React renders it with
// useSyncExternalStore; all lifecycle is imperative and owned here.

import { connectItxBrowser } from "~/itx/itx-react.tsx";
import type { VoiceRealtimeConnection } from "~/lib/voice-server-fns.ts";

const USER_TURN_EVENT = "events.iterate.com/voice/user-turn-transcribed";
const ASSISTANT_UTTERANCE_EVENT = "events.iterate.com/voice/assistant-utterance-completed";
const SAY_REQUESTED_EVENT = "events.iterate.com/voice/say-requested";
const REPORT_SUPPRESSED_EVENT = "events.iterate.com/voice/report-suppressed";
const WORKER_REPLY_EVENT = "events.iterate.com/agents/web-message-sent";
const WORKER_IDLE_REPLY = "(idle)";
const AUDIO_SAMPLE_RATE = 24_000;

const VOICE_AGENT_INSTRUCTIONS = `
You are Iterate's voice assistant. You do real work in the user's Iterate
project through a background channel: actionable requests get worked on
automatically, and results arrive moments later as messages starting with
"[worker report]". You know nothing else about how this works.

Golden rule: you never know what you can or can't do, what tools exist or
don't, or any current facts (scores, news, prices) — so never claim, deny,
guess, or explain any of that. Your only jobs: small talk, brief
acknowledgements, and relaying reports.

How to respond, by situation:
- Small talk or timeless general knowledge: answer directly, briefly.
- Anything actionable, or any question about tools, capabilities, or current
  events: a short ack ONLY — "On it.", "Let me check.", "One sec." Never add
  explanations, limitations, methods, or promises.
- User pushes back or doubts your last answer: "Let me double-check." and
  nothing more — never defend, never re-explain.
- [worker report] with substance: relay it faithfully in first person, no
  additions or extrapolations. Long lists: give the first few, then offer the
  rest ("…and seven more — want them all?").
- [worker report] asking a question: ask the user that question as your own.
- [worker report] adding nothing the user hasn't heard: call no_comment.

Speak as one assistant: "I", never "we", "us", "they", "the worker", or "the
system". Everything you say is heard only by the user — never address anyone
else. One or two short spoken sentences. Always speak English unless the
user clearly asks for another language — never switch languages based on a
short or ambiguous utterance.

Examples:
User: "do you have a way to add tools?" → "Let me check."
User: "what's the score in the game?" → "One sec, checking."
User: "i thought you added a tool - use it" → "Let me double-check."
[worker report] "I added a research tool and tested it." → "Done — I've added a research tool."
[worker report] "It didn't return results; I'll repair it." → "Hit a snag — fixing it now."
[worker report] "Which competition do you mean?" → "Which competition do you mean — men's, women's, or clubs?"
[worker report] "Yes — Portugal beat Croatia 2–1." right after you already told the user exactly that → call no_comment.
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

// A function-call response produces no audio, so this is the structurally
// guaranteed way for the voice model to stay silent when a worker report is
// redundant. Worst case it ignores the tool and talks — today's behavior.
const NO_COMMENT_TOOL = {
  type: "function",
  name: "no_comment",
  description:
    "Stay silent instead of responding. Call this when the latest [worker report] adds nothing the user hasn't already been told.",
  parameters: { type: "object", properties: {} },
};

export type VoiceTranscriptEntry = {
  id: number;
  kind: "you" | "assistant" | "worker-request" | "worker-reply" | "status" | "error";
  text: string;
};

type VoiceSessionSnapshot = {
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
  // Whether the in-flight response produced any audible/visible output —
  // a function-call-only response is silent, and silence needs handling.
  #responseHadSpeech = false;

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
    void this.#listenToWorker();

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
              transcription: { model: "gpt-4o-mini-transcribe", language: "en" },
              turn_detection: { type: "server_vad" },
            },
            output: { format: { type: "audio/pcm", rate: AUDIO_SAMPLE_RATE }, voice: "marin" },
          },
          tools: [ASK_ASSISTANT_TOOL, NO_COMMENT_TOOL],
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
      this.#sendResponseCreate();
    });
    this.#forwardTurn(trimmed, "text");
  }

  #onServerEvent(event: Record<string, unknown>) {
    const type = String(event.type);
    switch (type) {
      case "response.created": {
        this.#responseActive = true;
        this.#responseHadSpeech = false;
        // VAD starting a response means the user's turn ended — forward even
        // if the transcription `.completed` event never arrives.
        for (const itemId of this.#turnTranscripts.keys()) this.#forwardTurnFromItem(itemId);
        return;
      }
      case "response.done": {
        const openEntryId = this.#openAssistantEntryId;
        const utterance = this.#snapshot.entries.find((entry) => entry.id === openEntryId);
        if (utterance?.text.trim()) {
          // Audit fact only — nothing consumes it; it makes the voice side of
          // the conversation visible in the journal alongside the worker side.
          void this.#agentStream()
            .then((stream) =>
              stream.append({ type: ASSISTANT_UTTERANCE_EVENT, payload: { text: utterance.text } }),
            )
            .catch(() => {});
        }
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
        if (String(event.name) === "no_comment") {
          // Complete the call but do NOT trigger a response — the silence is
          // the point. The report stays in context for later turns.
          this.#send({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: event.call_id, output: "{}" },
          });
          this.#addEntry("status", "(worker report noted silently)");
          void this.#agentStream()
            .then((stream) => stream.append({ type: REPORT_SUPPRESSED_EVENT, payload: {} }))
            .catch(() => {});
          return;
        }
        this.#addEntry("status", `voice model called ${String(event.name)} (acked)`);
        // If the model already spoke its ack in the same response as the tool
        // call, a forced follow-up would make it say "working on it" twice —
        // so stay quiet. But a function-call-ONLY response is silent, and the
        // user deserves an ack, so force one exactly then.
        this.#send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: event.call_id,
            output: JSON.stringify({ status: "forwarded to worker; report will follow" }),
          },
        });
        if (!this.#responseHadSpeech) this.#whenResponseIdle(() => this.#sendResponseCreate());
        return;
      }
      case "response.output_audio.delta":
      case "response.audio.delta": {
        this.#responseHadSpeech = true;
        this.#playAudioDelta(String(event.delta));
        return;
      }
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
      case "response.output_text.delta": {
        this.#responseHadSpeech = true;
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
    // Transcription often completes after the assistant has started replying —
    // slot the user's turn in front of the open assistant entry, where it
    // actually happened.
    const beforeId = this.#openAssistantEntryId;
    this.#addEntry("you", transcript.trim(), beforeId);
    this.#forwardTurn(transcript.trim(), "speech", beforeId);
  }

  /**
   * The worker lane is stream-native: forwarding a turn is appending a
   * `voice/user-turn-transcribed` fact. The `voice` stream processor (see
   * apps/os/src/domains/voice/) renders it into agent input; this client
   * never talks to the agent directly.
   */
  #forwardTurn(text: string, origin: "speech" | "text", beforeEntryId?: number | null) {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.#addEntry("worker-request", trimmed, beforeEntryId);
    void this.#agentStream()
      .then((stream) =>
        stream.append({ type: USER_TURN_EVENT, payload: { transcript: trimmed, origin } }),
      )
      .catch((error: Error) => {
        this.#addEntry("error", `failed to reach the worker stream: ${error.message}`);
      });
  }

  /**
   * The other half of the stream-native lane: the voice processor projects
   * agent replies into `voice/say-requested` events; this loop relays them
   * into the realtime conversation. Raw `web-message-sent` events (including
   * the "(idle)" sentinel the processor swallows) are shown in the transcript
   * for visibility but never injected — injection follows say-requests only.
   */
  async #listenToWorker() {
    let cursor = 0;
    while (this.#snapshot.status === "connecting" || this.#snapshot.status === "live") {
      let event;
      try {
        const stream = await this.#agentStream();
        event = await stream.waitForEvent({
          afterOffset: cursor,
          eventTypes: [SAY_REQUESTED_EVENT, WORKER_REPLY_EVENT],
          timeoutMs: 60_000,
        });
      } catch {
        // timeout (no worker activity) or transient disconnect — keep
        // listening while the session lives, gently on failure
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      cursor = event.offset;
      const message = String((event.payload as { message?: unknown }).message || "").trim();
      if (event.type === WORKER_REPLY_EVENT) {
        this.#addEntry(
          "worker-reply",
          message === WORKER_IDLE_REPLY ? "(idle — nothing to report)" : message,
        );
        continue;
      }
      this.#whenResponseIdle(() => {
        this.#send(userTextItem(`[worker report] ${message}`));
        this.#sendResponseCreate();
      });
    }
  }

  async #agentStream() {
    const itx = await connectItxBrowser({ projectId: this.#projectId });
    return itx.agents.get(this.#agentPath).stream;
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

  /**
   * Mark the response active BEFORE the server confirms it — waiting for
   * `response.created` leaves a window where a second injection races in and
   * the API rejects it with `conversation_already_has_active_response`.
   */
  #sendResponseCreate() {
    this.#responseActive = true;
    this.#send({ type: "response.create" });
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

  #addEntry(kind: VoiceTranscriptEntry["kind"], text: string, beforeEntryId?: number | null) {
    const id = this.#nextEntryId++;
    const entries = [...this.#snapshot.entries];
    const at =
      beforeEntryId == null ? -1 : entries.findIndex((entry) => entry.id === beforeEntryId);
    if (at === -1) entries.push({ id, kind, text });
    else entries.splice(at, 0, { id, kind, text });
    this.#update({ entries });
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
