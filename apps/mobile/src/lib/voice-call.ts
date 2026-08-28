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
  pttEnd: "events.iterate.com/voice-agent/ptt-end",
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
  /**
   * The hold-to-talk button's two edges. Press appends the durable
   * ptt-start (the FIRST press is also the mint that dials the provider —
   * the facet holds mic frames through the handshake and commits the held
   * turn on release, so speaking immediately works); release appends the
   * ephemeral ptt-end that commits the turn and asks for the answer. Mic
   * frames flow only while talking.
   */
  setTalking(talking: boolean): void;
}

/** The caption one event contributes, or null when it says nothing a
 * glancing human needs. Exported pure for tests. */
export function captionForEvent(type: string, payload: unknown): string | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (type) {
    case EVENT.callStarted:
    case EVENT.conversationAccepted:
      /* Lifecycle captions are LOCAL state (ringing / hold to talk /
       * listening) — the accepted event lands mid-first-hold and must not
       * overwrite "listening…" under the caller's thumb. */
      return null;
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
  /** Played through the audio session on repeat while ringing (voice-pcm's
   * ringTonePcm16Base64) — doubling as a built-in speaker check. */
  ringPcmBase64?: string;
  now(): number;
}): Promise<VoiceCallHandle> {
  let ended = false;
  let conversationId: string | null = null;
  let connection: unknown;
  let inflightMicAppends = 0;
  let deviceMicFrameSeq = 0;
  let spkFramesHeard = 0;
  let spkMsHeard = 0;
  let ringTimer: ReturnType<typeof setInterval> | null = null;
  const startedAtMs = deps.now();

  const stopRinging = () => {
    if (ringTimer !== null) clearInterval(ringTimer);
    ringTimer = null;
  };

  const finish = (caption: string) => {
    if (ended) return;
    ended = true;
    stopRinging();
    /* The heard tally rides the obituary caption ON PURPOSE (demo-lane
     * diagnostics): round 2 on-device was "no response" with the server
     * provably answering — this line splits "frames never arrived" from
     * "arrived but played silently" at a glance. */
    deps.onStatus({
      phase: "ended",
      caption: `${caption} · heard ${(spkMsHeard / 1000).toFixed(1)}s (${spkFramesHeard} frames)`,
    });
    void deps.audio.stop();
    const open = connection as { close?: () => unknown } & Partial<Disposable>;
    try {
      if (typeof open?.close === "function") open.close();
      else open?.[Symbol.dispose]?.();
    } catch {
      /* A connection that is already gone is a connection that is closed. */
    }
  };

  deps.onStatus({ phase: "connecting", caption: "ringing…" });

  /*
   * AUDIO FIRST, wire second. The mic runs from here (no frames leak —
   * `talking` gates the wire) so the ring tone has a live output path and
   * the first hold has zero start-up latency; a recorder that will not
   * start fails the call before any server-side mint exists.
   */
  let talking = false;
  try {
    await deps.audio.start((frame) => {
      deps.onLevel(talking ? frame.level : 0);
      if (!talking || ended || inflightMicAppends >= MAX_INFLIGHT_MIC_APPENDS) return;
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
  } catch (error) {
    finish("microphone failed");
    throw error;
  }
  if (deps.ringPcmBase64 !== undefined) {
    const ring = deps.ringPcmBase64;
    deps.audio.play(ring);
    ringTimer = setInterval(() => deps.audio.play(ring), 3_000);
  }

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
          if (typeof payload.pcm === "string" && payload.pcm !== "") {
            spkFramesHeard++;
            /* Base64 length → decoded ms without decoding (32 bytes/ms). */
            spkMsHeard += Math.floor((payload.pcm.length / 4) * 3) / 32;
            deps.audio.play(payload.pcm);
          }
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

  /* Connected: the ring stops mid-burst rather than playing into the call. */
  stopRinging();
  deps.audio.clearPlayback();
  if (!ended) deps.onStatus({ phase: "live", caption: "hold the mic to talk" });

  return {
    setTalking: (next: boolean) => {
      if (ended || talking === next) return;
      talking = next;
      if (!next) deps.onLevel(0);
      /* Durable press, ephemeral release — the press is the event whose
       * loss strands a caller (the FIRST one mints the call), the release
       * costs a turn at worst; exactly the boards' durability split. */
      deps.stream
        .append(
          next
            ? { type: EVENT.pttStart, payload: { t: deps.now() - startedAtMs } }
            : { type: EVENT.pttEnd, ephemeral: true, payload: { t: deps.now() - startedAtMs } },
        )
        .catch(() => {
          /* The connection's own failure surfaces carry this. */
        });
      if (!ended) {
        deps.onStatus({ phase: "live", caption: next ? "listening…" : "hold the mic to talk" });
      }
    },
    hangUp: async () => {
      if (ended) return;
      const buriedConversationId = conversationId;
      /* END LOCALLY FIRST. The obituary rides a socket that may be wedged —
       * awaiting it before updating the UI turned the hang-up button into a
       * no-op on the first on-device session. */
      finish("call ended");
      if (buriedConversationId !== null) {
        await deps.stream
          .append({
            type: EVENT.conversationEnded,
            payload: { conversationId: buriedConversationId, reason: "hang-up button" },
          })
          .catch(() => {
            /* Ending locally still ended locally; the idle deadline is the
             * server's backstop for a lost obituary. */
          });
      }
    },
  };
}
