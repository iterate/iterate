export type PlaybackRecoveryAcousticAssessment =
  | {
      kind: "healthy";
      maximumExplainedMissingToneMs: number;
    }
  | {
      kind: "failure";
      reasons: string[];
    };

/**
 * Judges the deliberately non-gapless acoustic side of a recovery proof.
 *
 * A recovery descriptor is exactly one silent PCM frame, so the strict
 * endurance oracle must reject it. This narrower diagnostic still requires the
 * microphone to observe output spanning the complete response and permits only
 * the silence that device counters account for, plus an explicit small
 * correlation/room-tail allowance. It intentionally does not relax phase-step
 * or amplitude-step limits globally: dropping the stale source frame changes
 * sine phase by design, and only this named recovery result interprets it.
 */
export function assessPlaybackRecoveryAcoustics(options: {
  expectedDurationMs: number;
  frameDurationMs: number;
  longestInternalGapMs: number;
  maximumDurationErrorMs: number;
  maximumUnattributedMissingToneMs: number;
  missingToneMs: number;
  observedSpanMs: number;
  recoveryFrameCount: number;
}): PlaybackRecoveryAcousticAssessment {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Playback recovery acoustic ${name} must be a nonnegative finite number.`);
    }
  }
  if (!Number.isSafeInteger(options.recoveryFrameCount) || options.recoveryFrameCount <= 0) {
    throw new Error("Playback recovery acoustics require a positive whole recovery-frame count.");
  }
  if (options.frameDurationMs <= 0 || options.expectedDurationMs <= 0) {
    throw new Error("Playback recovery acoustic durations must be positive.");
  }

  const maximumExplainedMissingToneMs =
    options.recoveryFrameCount * options.frameDurationMs + options.maximumUnattributedMissingToneMs;
  const reasons: string[] = [];
  const durationErrorMs = Math.abs(options.observedSpanMs - options.expectedDurationMs);
  if (durationErrorMs > options.maximumDurationErrorMs) {
    reasons.push(
      `observed tone span ${options.observedSpanMs} ms differs from expected ` +
        `${options.expectedDurationMs} ms by ${durationErrorMs} ms`,
    );
  }
  if (options.missingToneMs > maximumExplainedMissingToneMs) {
    reasons.push(
      `missing tone ${options.missingToneMs} ms exceeds the recovery-accounted maximum ` +
        `${maximumExplainedMissingToneMs} ms`,
    );
  }
  if (options.longestInternalGapMs > maximumExplainedMissingToneMs) {
    reasons.push(
      `longest internal gap ${options.longestInternalGapMs} ms exceeds the ` +
        `recovery-accounted maximum ${maximumExplainedMissingToneMs} ms`,
    );
  }

  return reasons.length === 0
    ? { kind: "healthy", maximumExplainedMissingToneMs }
    : { kind: "failure", reasons };
}
