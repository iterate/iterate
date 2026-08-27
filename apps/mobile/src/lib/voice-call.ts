// One voice call, as the third dumb client of the voice-agent facet speaks
// it (after the C host CLI and the ESP32 boards): open a live stream
// connection, append one durable ptt-start to mint the call, pump ephemeral
// base64 PCM16 mic-frames up, and obey the speaker lane's three-line buffer
// policy coming down — clear-before-frame throws the queue away, pcm is
// appended to playback, and that is the entire client (see
// apps/os/scripts/voicelab/README.md).
//
// Pure TypeScript with every effect injected (audio seam, stream handle,
// clock), so the SAME module runs on the phone, under vitest with fakes, and
// in the live Node e2e against a real deployment — the grill's "headless
// wire-driver runs the shipped code" requirement, not a parallel
// implementation.
import type { VoiceAudioSession } from "./voice-audio.ts";

const EVENT = {
  callStarted: "events.iterate.com/voice-agent/call-started",
  colleagueNote: "events.iterate.com/voice-agent/colleague-note",
  colleagueStatus: "events.iterate.com/voice-agent/colleague-status",
  conversationAccepted: "events.iterate.com/voice-agent/conversation-accepted",
  conversationEnded: "events.iterate.com/voice-agent/conversation-ended",
  micFrame: "events.iterate.com/voice-agent/mic-frame",
  pttStart: "events.iterate.com/voice-agent/ptt-start",
  spkFrame: "events.iterate.com/voice-agent/spk-frame",
} as const;

export type VoiceCallPhase = "connecting" | "live" | "ended";

export interface VoiceCallStatus {
  phase: VoiceCallPhase;
  /** One quiet line under the pulse — call lifecycle and the colleague
   * status/note lane share it (grill Q6): the sheet never looks dead. */
  caption: string;
}

/**
 * More in-flight mic appends than this and new frames are DROPPED, not
 * queued: on a stalled socket an unbounded promise pile-up trades a moment
 * of lost audio (recoverable — it is a conversation) for minutes of stale
 * audio arriving late (unrecoverable — the model answers the past).
 */
const MAX_INFLIGHT_MIC_APPENDS = 8;

/** The stream surface a call drives — the probe-audio.ts shape plus the
 * head read that keeps history out of a fresh connection. */
export interface VoiceCallStream {
  append(
    ...events: { type: string; ephemeral?: true; payload: Record<string, unknown> }[]
  ): Promise<unknown>;
  openConnection(options: {
    replayAfterOffset: number;
    eventTypes: string[];
    processEventBatch: (batch: { events?: { type: string; payload?: unknown }[] }) => void;
  }): Promise<unknown>;
  getEventPage(options: { afterOffset: number; limit: number }): Promise<{
    streamMaxOffset: number;
  }>;
}

export interface VoiceCallHandle {
  hangUp(): Promise<void>;
}

/** The caption one event contributes, or null when it says nothing a
 * glancing human needs. Exported pure for tests. */
export function captionForEvent(type: string, payload: unknown): string | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (type) {
    case EVENT.callStarted:
    case EVENT.conversationAccepted:
      return "listening";
    case EVENT.colleagueStatus: {
      const status =
        (typeof p.activity === "string" && p.activity) || (typeof p.phase === "string" && p.phase);
      return status ? `backend: ${status}` : null;
    }
    case EVENT.colleagueNote:
      return typeof p.text === "string" && p.text !== ""
        ? `backend: ${p.text.length > 90 ? `${p.text.slice(0, 90)}…` : p.text}`
        : null;
    case EVENT.conversationEnded:
      return typeof p.reason === "string" && p.reason !== ""
        ? `call ended — ${p.reason}`
        : "call ended";
    default:
      return null;
  }
}

export async function startVoiceCall(deps: {
  stream: VoiceCallStream;
  audio: VoiceAudioSession;
  /** voice-setup.ts's ensureVoiceAgentSetup, bound. Throws = no call. */
  ensureSetup(): Promise<void>;
  onStatus(status: VoiceCallStatus): void;
  /** Per-capture-frame loudness for the pulse — high-frequency on purpose,
   * so it must not re-render anything heavy. */
  onLevel(level: number): void;
  now(): number;
}): Promise<VoiceCallHandle> {
  let ended = false;
  let conversationId: string | null = null;
  let connection: unknown;
  let inflightMicAppends = 0;
  let deviceMicFrameSeq = 0;
  const startedAtMs = deps.now();

  const finish = (caption: string) => {
    if (ended) return;
    ended = true;
    deps.onStatus({ phase: "ended", caption });
    void deps.audio.stop();
    const open = connection as { close?: () => unknown } & Partial<Disposable>;
    try {
      if (typeof open?.close === "function") open.close();
      else open?.[Symbol.dispose]?.();
    } catch {
      /* A connection that is already gone is a connection that is closed. */
    }
  };

  deps.onStatus({ phase: "connecting", caption: "setting up…" });
  await deps.ensureSetup();

  /* From the head, not the beginning: this stream is the device's ONE
   * ongoing conversation, so its history holds every previous call's
   * lifecycle events — replayed, last week's conversation-ended would end
   * this call before it starts. */
  const head = (await deps.stream.getEventPage({ afterOffset: 0, limit: 1 })).streamMaxOffset;
  connection = await deps.stream.openConnection({
    replayAfterOffset: head,
    eventTypes: [
      EVENT.spkFrame,
      EVENT.callStarted,
      EVENT.conversationAccepted,
      EVENT.conversationEnded,
      EVENT.colleagueStatus,
      EVENT.colleagueNote,
    ],
    processEventBatch: (batch) => {
      for (const event of batch.events ?? []) {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (event.type === EVENT.spkFrame) {
          /* The three-line buffer policy, lines one and two. Line three
           * (lastFrameOfAnswer) exists for half-duplex clients releasing a
           * fence; an open-mic phone has no fence to release. */
          if (payload.clearSpeakerBufferBeforeFrame === true) deps.audio.clearPlayback();
          if (typeof payload.pcm === "string" && payload.pcm !== "") deps.audio.play(payload.pcm);
          continue;
        }
        if (event.type === EVENT.callStarted && typeof payload.conversationId === "string") {
          conversationId = payload.conversationId;
        }
        if (event.type === EVENT.conversationEnded) {
          /* Ours or unattributed — a fresh connection past the head only
           * sees this call's lifecycle, but the id check keeps a racing
           * stale obituary from ending the wrong call. */
          if (conversationId === null || payload.conversationId === conversationId) {
            finish(captionForEvent(event.type, payload) ?? "call ended");
          }
          continue;
        }
        const caption = captionForEvent(event.type, payload);
        if (caption !== null && !ended) deps.onStatus({ phase: "live", caption });
      }
    },
  });

  /* The one durable press that mints the call — the server dials the
   * provider on it; everything after rides ephemeral lanes. */
  await deps.stream.append({ type: EVENT.pttStart, payload: { t: startedAtMs } });
  if (!ended) deps.onStatus({ phase: "connecting", caption: "connecting…" });

  await deps.audio.start((frame) => {
    deps.onLevel(frame.level);
    if (ended || inflightMicAppends >= MAX_INFLIGHT_MIC_APPENDS) return;
    inflightMicAppends++;
    deps.stream
      .append({
        type: EVENT.micFrame,
        ephemeral: true,
        payload: {
          pcm: frame.pcmBase64,
          deviceMicFrameSeq: ++deviceMicFrameSeq,
          capturedAtDeviceMs: deps.now() - startedAtMs,
        },
      })
      .catch(() => {
        /* A dropped mic frame is a moment of lost audio, not an error the
         * person can act on; the connection's own failure surfaces are the
         * real signal. */
      })
      .finally(() => {
        inflightMicAppends--;
      });
  });

  return {
    hangUp: async () => {
      if (ended) return;
      /* The device-appended obituary — same as a board's hang-up button.
       * With no conversationId yet (hung up mid-handshake) there is nothing
       * to bury; the facet's idle deadline reaps the mint. */
      if (conversationId !== null) {
        await deps.stream
          .append({
            type: EVENT.conversationEnded,
            payload: { conversationId, reason: "hang-up button" },
          })
          .catch(() => {
            /* Ending locally still ends locally. */
          });
      }
      finish("call ended");
    },
  };
}
