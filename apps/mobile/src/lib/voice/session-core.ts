// Ported from apps/os/src/components/voice/voice-session.ts (the browser I/O
// pump for the voice ↔ itx bridge). Modifications for React Native:
//
//   - transport-agnostic: the realtime connection is injected (`connectRealtime`),
//     so the phone uses a WebRTC data channel while tests use a fake. All PCM
//     capture/playback code is gone — WebRTC carries audio natively.
//   - `session.update` omits audio formats (WebRTC negotiates them) but keeps
//     instructions, transcription, VAD, voice, and the two function tools.
//   - new derived snapshot fields for the orb UI: `assistantSpeaking` (from the
//     WebRTC-only `output_audio_buffer.started/stopped` events, cleared on
//     barge-in) and `workerBusy` (a forwarded turn or ask_assistant ack with no
//     worker reply yet).
//   - mute is a snapshot field driving `setMicEnabled` on the transport
//     (track.enabled) instead of tearing down the mic pipeline.
//
// The multiplexing brain stays server-side in the `voice` stream processor
// (apps/os/src/domains/voice/): this client only appends raw facts
// (`voice/user-turn-transcribed`, plus audit events) and relays
// `voice/say-requested` projections into the realtime conversation.

// A VALUE import from apps/os — deliberate: the voice-model prompt and tool
// definitions are quality-critical and tuned from live sessions upstream, and
// keeping a copy here drifted twice in one day. The module is import-free and
// side-effect-free, so Metro bundles it cleanly.
import {
  ASK_ASSISTANT_TOOL,
  NO_COMMENT_TOOL,
  VOICE_AGENT_INSTRUCTIONS,
} from "../../../../os/src/domains/voice/voice-client-prompts.ts";

const USER_TURN_EVENT = "events.iterate.com/voice/user-turn-transcribed";
const CLIENT_CONNECTED_EVENT = "events.iterate.com/voice/client-connected";
const ASSISTANT_UTTERANCE_EVENT = "events.iterate.com/voice/assistant-utterance-completed";
const SAY_REQUESTED_EVENT = "events.iterate.com/voice/say-requested";
const REPORT_SUPPRESSED_EVENT = "events.iterate.com/voice/report-suppressed";
const WORKER_REPLY_EVENT = "events.iterate.com/agents/web-message-sent";
const WORKER_IDLE_REPLY = "(idle)";

export type RealtimeEvent = Record<string, unknown>;

/** What `connectRealtime` resolves to: a live, ready-to-send realtime leg. */
export type RealtimeTransport = {
  send(event: RealtimeEvent): void;
  close(): void;
  /** Mute/unmute the local mic (track.enabled on WebRTC). Absent = no mic. */
  setMicEnabled?: (enabled: boolean) => void;
  /** True when a live mic track is attached. */
  micLive: boolean;
  /** Shown in the transcript's "connected" status entry, e.g. "openai gpt-realtime". */
  label: string;
  /** Non-fatal setup problem worth a transcript entry (e.g. mic permission denied). */
  warning?: string;
};

export type ConnectRealtime = (callbacks: {
  onEvent(event: RealtimeEvent): void;
  onClose(info: { code?: number; reason?: string }): void;
}) => Promise<RealtimeTransport>;

/** The slice of the itx `Stream` surface the session uses (see apps/os/src/types.ts). */
export type WorkerStream = {
  append(event: { type: string; payload: Record<string, unknown> }): Promise<{ offset: number }[]>;
  waitForEvent(input: {
    afterOffset: number;
    eventTypes: readonly string[];
    timeoutMs: number;
  }): Promise<{ offset: number; type: string; payload?: Record<string, unknown> }>;
};

export type VoiceTranscriptEntry = {
  id: number;
  kind: "you" | "assistant" | "worker-request" | "worker-reply" | "status" | "error";
  text: string;
};

export type VoiceSessionSnapshot = {
  status: "idle" | "connecting" | "live" | "ended";
  micLive: boolean;
  muted: boolean;
  assistantSpeaking: boolean;
  workerBusy: boolean;
  entries: VoiceTranscriptEntry[];
};

const INITIAL_SNAPSHOT: VoiceSessionSnapshot = {
  status: "idle",
  micLive: false,
  muted: false,
  assistantSpeaking: false,
  workerBusy: false,
  entries: [],
};

export class VoiceSessionCore {
  #connectRealtime: ConnectRealtime;
  #agentStream: () => Promise<WorkerStream>;
  #retryDelayMs: number;
  #hooks: { onWorkerReport?: () => void };

  #transport: RealtimeTransport | null = null;
  #listeners = new Set<() => void>();
  #snapshot: VoiceSessionSnapshot = INITIAL_SNAPSHOT;
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

  constructor(input: {
    connectRealtime: ConnectRealtime;
    agentStream: () => Promise<WorkerStream>;
    /** Worker-lane redial delay; tests shrink it. */
    retryDelayMs?: number;
    hooks?: { onWorkerReport?: () => void };
  }) {
    this.#connectRealtime = input.connectRealtime;
    this.#agentStream = input.agentStream;
    this.#retryDelayMs = input.retryDelayMs ?? 1_000;
    this.#hooks = input.hooks ?? {};
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = () => this.#snapshot;

  async start() {
    if (this.#snapshot.status !== "idle" && this.#snapshot.status !== "ended") return;
    this.#update({ status: "connecting" });
    void this.#listenToWorker();

    let transport: RealtimeTransport;
    try {
      transport = await this.#connectRealtime({
        onEvent: (event) => this.#onServerEvent(event),
        onClose: (info) => {
          if (this.#snapshot.status === "live" || this.#snapshot.status === "connecting") {
            this.#addEntry(
              "status",
              `voice connection closed${info.code ? ` (${info.code})` : ""}`,
            );
          }
          this.#update({ status: "ended", assistantSpeaking: false });
        },
      });
    } catch (error) {
      this.#addEntry("error", error instanceof Error ? error.message : String(error));
      this.#update({ status: "ended" });
      return;
    }
    this.#transport = transport;

    this.#send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: VOICE_AGENT_INSTRUCTIONS,
        output_modalities: ["audio"],
        audio: {
          input: {
            transcription: { model: "gpt-4o-mini-transcribe", language: "en" },
            turn_detection: { type: "server_vad" },
          },
          output: { voice: "marin" },
        },
        tools: [ASK_ASSISTANT_TOOL, NO_COMMENT_TOOL],
      },
    });
    this.#update({ status: "live", micLive: transport.micLive, muted: false });
    this.#addEntry("status", `connected (${transport.label})`);
    if (transport.warning) this.#addEntry("error", transport.warning);
    if (transport.micLive) this.#addEntry("status", "microphone live — just talk");
  }

  stop() {
    this.#transport?.close();
    this.#transport = null;
    this.#update({ status: "ended", assistantSpeaking: false, micLive: false });
  }

  setMuted(muted: boolean) {
    if (!this.#snapshot.micLive) return;
    this.#transport?.setMicEnabled?.(!muted);
    this.#update({ muted });
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

  #onServerEvent(event: RealtimeEvent) {
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
      // WebRTC-only lifecycle events for the remote audio track — this is what
      // makes "assistant is speaking" knowable without touching audio buffers.
      case "output_audio_buffer.started": {
        this.#responseHadSpeech = true;
        this.#update({ assistantSpeaking: true });
        return;
      }
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared": {
        this.#update({ assistantSpeaking: false });
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
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
      case "response.output_text.delta": {
        this.#responseHadSpeech = true;
        this.#appendAssistantDelta(String(event.delta));
        return;
      }
      case "input_audio_buffer.speech_started": {
        // Barge-in: the server cuts the remote track; the orb should snap to
        // "listening" immediately rather than waiting for buffer.stopped.
        this.#update({ assistantSpeaking: false });
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
   * `voice/user-turn-transcribed` fact. The `voice` stream processor renders
   * it into agent input; this client never talks to the agent directly.
   */
  #forwardTurn(text: string, origin: "speech" | "text", beforeEntryId?: number | null) {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.#addEntry("worker-request", trimmed, beforeEntryId);
    this.#update({ workerBusy: true });
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
    // Unlike the web page (which always mints a fresh agent path), this client
    // can REOPEN an old session's stream — so the cursor must start at the
    // stream's tail, not 0, or the whole say-request history replays into the
    // new realtime conversation. Appending a client-connected audit fact both
    // journals the reconnect and hands back the tail offset in one call.
    let cursor: number | null = null;
    while (this.#snapshot.status === "connecting" || this.#snapshot.status === "live") {
      let event;
      try {
        const stream = await this.#agentStream();
        if (cursor === null) {
          const [marker] = await stream.append({
            type: CLIENT_CONNECTED_EVENT,
            payload: { client: "ios" },
          });
          cursor = marker ? marker.offset : 0;
        }
        event = await stream.waitForEvent({
          afterOffset: cursor,
          eventTypes: [SAY_REQUESTED_EVENT, WORKER_REPLY_EVENT],
          timeoutMs: 60_000,
        });
      } catch {
        // timeout (no worker activity) or transient disconnect — keep
        // listening while the session lives, gently on failure
        await new Promise((resolve) => setTimeout(resolve, this.#retryDelayMs));
        continue;
      }
      cursor = event.offset;
      const message = String(
        (event.payload as { message?: unknown } | undefined)?.message || "",
      ).trim();
      this.#update({ workerBusy: false });
      if (event.type === WORKER_REPLY_EVENT) {
        this.#addEntry(
          "worker-reply",
          message === WORKER_IDLE_REPLY ? "(idle — nothing to report)" : message,
        );
        continue;
      }
      this.#hooks.onWorkerReport?.();
      this.#whenResponseIdle(() => {
        this.#send(userTextItem(`[worker report] ${message}`));
        this.#sendResponseCreate();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------

  #send(event: RealtimeEvent) {
    this.#transport?.send(event);
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

function userTextItem(text: string) {
  return {
    type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
}
