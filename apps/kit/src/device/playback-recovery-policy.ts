import { assessPlaybackCounterPolicy } from "./playback-counter-policy.ts";

const uint32Maximum = 0xffff_ffff;
const recoverableCounterNames = new Set([
  "playback_underrun_incidents",
  "playback_underrun_late_frames_dropped",
  "playback_underrun_silence_frames_completed",
  "playback_underrun_silence_frames_retired",
  "playback_underrun_silence_frames_submitted",
]);
const accountingCounterNames = [
  "downlink_accepted",
  "playback_completed",
  "playback_end_of_stream_markers_consumed",
  "playback_end_of_stream_responses",
  "playback_submitted",
  ...recoverableCounterNames,
] as const;

export type PlaybackRecoveryProofAssessment =
  | {
      incidentCount: number;
      kind: "healthy";
      recoveryFrameCount: number;
    }
  | {
      kind: "failure";
      reasons: string[];
    };

/**
 * Derives the live fail-fast policy for an explicitly named recovery proof.
 *
 * Only counters describing the intended one-silence/one-drop mechanism are
 * removed. Queue overflow, an ordinary flush, driver failure, deadline miss,
 * destructive reset, freshness loss, and every other strict counter retain
 * their zero budget. Keeping this derivation next to the final conservation
 * judge prevents the CLI from growing an independent and gradually broader
 * notion of “recoverable.”
 */
export function playbackRecoverySafetyMaximumDeltas(
  strictMaximumDeltas: Readonly<Record<string, number>>,
) {
  return Object.fromEntries(
    Object.entries(strictMaximumDeltas).filter(([name]) => !recoverableCounterNames.has(name)),
  );
}

/**
 * Judges a completed finite response after one or more bounded underruns.
 *
 * Recovery is allowed only when every missing physical slot has one explicit
 * zero descriptor and exactly one corresponding stale content discard. Source
 * accounting must still close: content completed plus discarded content equals
 * the exact number of frames accepted from the wire. This rules out both
 * hidden backlog and the tempting but invalid claim that “playback eventually
 * became quiet” proves recovery.
 */
export function assessPlaybackRecoveryProof(options: {
  baseline: Readonly<Record<string, unknown>>;
  current: Readonly<Record<string, unknown>>;
  expectedContentFrames: number;
  safetyMaximumDeltas: Readonly<Record<string, number>>;
}): PlaybackRecoveryProofAssessment {
  if (!Number.isSafeInteger(options.expectedContentFrames) || options.expectedContentFrames <= 0) {
    throw new Error("A playback recovery proof requires a positive whole source-frame count.");
  }

  /*
   * Reuse the strict monotonic-counter validator for schema omissions,
   * regression, and saturation. UINT32_MAX is only a validation ceiling here;
   * exact relationships below own the actual recovery limits.
   */
  const validationMaximumDeltas: Record<string, number> = {
    ...options.safetyMaximumDeltas,
  };
  for (const name of accountingCounterNames) {
    validationMaximumDeltas[name] = uint32Maximum;
  }
  const counterAssessment = assessPlaybackCounterPolicy({
    baseline: options.baseline,
    current: options.current,
    maximumDeltas: validationMaximumDeltas,
  });
  if (counterAssessment.kind === "failure") {
    return { kind: "failure", reasons: [counterAssessment.reason] };
  }

  const delta = (name: (typeof accountingCounterNames)[number]) =>
    (options.current[name] as number) - (options.baseline[name] as number);
  const accepted = delta("downlink_accepted");
  const submitted = delta("playback_submitted");
  const completed = delta("playback_completed");
  const endOfStreamMarkers = delta("playback_end_of_stream_markers_consumed");
  const endOfStreamResponses = delta("playback_end_of_stream_responses");
  const incidentCount = delta("playback_underrun_incidents");
  const lateFramesDropped = delta("playback_underrun_late_frames_dropped");
  const silenceCompleted = delta("playback_underrun_silence_frames_completed");
  const silenceRetired = delta("playback_underrun_silence_frames_retired");
  const silenceSubmitted = delta("playback_underrun_silence_frames_submitted");
  const reasons: string[] = [];

  if (accepted !== options.expectedContentFrames) {
    reasons.push(
      `wire accepted delta ${accepted} does not equal expected ${options.expectedContentFrames}`,
    );
  }
  if (submitted + lateFramesDropped !== options.expectedContentFrames) {
    reasons.push(
      `content submitted delta ${submitted} plus late-drop delta ${lateFramesDropped} ` +
        `does not equal expected ${options.expectedContentFrames}`,
    );
  }
  if (completed + lateFramesDropped !== options.expectedContentFrames) {
    reasons.push(
      `content completed delta ${completed} plus late-drop delta ${lateFramesDropped} ` +
        `does not equal expected ${options.expectedContentFrames}`,
    );
  }
  if (submitted !== completed) {
    reasons.push(
      `content completed delta ${completed} does not equal submitted delta ${submitted}`,
    );
  }
  if (silenceSubmitted === 0) {
    reasons.push("no bounded recovery silence was observed");
  }
  if (silenceCompleted + silenceRetired !== silenceSubmitted) {
    reasons.push(
      `recovery silence completed delta ${silenceCompleted} ` +
        `plus retired delta ${silenceRetired} does not equal submitted delta ${silenceSubmitted}`,
    );
  }
  if (lateFramesDropped !== silenceSubmitted) {
    reasons.push(
      `late-drop delta ${lateFramesDropped} does not equal recovery silence delta ${silenceSubmitted}`,
    );
  }
  if (incidentCount === 0 || incidentCount > silenceSubmitted) {
    reasons.push(`underrun incident delta ${incidentCount} is not within 1..${silenceSubmitted}`);
  }
  if (endOfStreamMarkers !== 1) {
    reasons.push(`end-of-stream marker delta ${endOfStreamMarkers} does not equal 1`);
  }
  if (endOfStreamResponses !== 1) {
    reasons.push(`end-of-stream response delta ${endOfStreamResponses} does not equal 1`);
  }

  return reasons.length === 0
    ? {
        incidentCount,
        kind: "healthy",
        recoveryFrameCount: silenceSubmitted,
      }
    : { kind: "failure", reasons };
}

/**
 * Cheap polling predicate for the one-hertz physical metrics callback.
 *
 * The complete assessment is rerun after this returns true. Keeping the
 * predicate conservative means the runner waits through an in-flight recovery
 * descriptor instead of terminating the microphone artifact at the same
 * half-accounted state that motivated this proof mode.
 */
export function playbackRecoveryIsComplete(
  options: Omit<Parameters<typeof assessPlaybackRecoveryProof>[0], "safetyMaximumDeltas">,
) {
  return (
    assessPlaybackRecoveryProof({
      ...options,
      safetyMaximumDeltas: {},
    }).kind === "healthy"
  );
}
