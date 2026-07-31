export interface AutonomousVoiceTurnTiming {
  firstMicrophoneFrameAtMonotonicMs?: number;
  firstSpeakerFrameAtMonotonicMs?: number;
  providerResponseCreatedAtMonotonicMs?: number;
  turn: number;
}

export type AutonomousVoiceFrameDirection = "microphone-uplink" | "speaker-downlink";

/**
 * Attributes the first PCM boundary to one autonomous voice turn.
 *
 * Microphone capture belongs to the active PTT epoch immediately. Speaker PCM
 * needs a stronger causal fence: after an interruption, the active PTT epoch
 * changes before cancellation can stop every old-generation byte already in
 * flight. The provider's ordered `response.created` message precedes binary
 * PCM for the replacement response, so only speaker frames observed after
 * that message can start its latency clock. This keeps intentional stale-frame
 * flushing in the conservation ledger without mislabelling it as fresh audio.
 */
export function observeAutonomousVoiceFrameTiming(
  timing: AutonomousVoiceTurnTiming,
  direction: AutonomousVoiceFrameDirection,
  observedAtMonotonicMs: number,
) {
  if (direction === "microphone-uplink") {
    timing.firstMicrophoneFrameAtMonotonicMs ??= observedAtMonotonicMs;
    return;
  }

  const responseCreatedAtMonotonicMs = timing.providerResponseCreatedAtMonotonicMs;
  if (
    responseCreatedAtMonotonicMs === undefined ||
    observedAtMonotonicMs < responseCreatedAtMonotonicMs
  ) {
    return;
  }
  timing.firstSpeakerFrameAtMonotonicMs ??= observedAtMonotonicMs;
}
