import type { KitPlaybackMetrics } from "./kit-device-contract.ts";
import { flattenKitPlaybackMetrics } from "./kit-playback-metrics.ts";
import { m5StickS3PlaybackEnduranceAcceptancePolicy } from "./m5sticks3-playback-endurance-target.ts";
import { assessPlaybackCounterPolicy } from "./playback-counter-policy.ts";

export const productionToneFrameCount = 100;
export const productionToneFrameBytes = 640;

export interface ProductionM5StickS3TonePlaybackAssessment {
  deltas: {
    downlinkAccepted: number;
    endOfStreamMarkersConsumed: number;
    endOfStreamResponses: number;
    playbackCompleted: number;
    playbackSubmitted: number;
  };
  passed: boolean;
  reasons: string[];
}

/*
 * These counters describe faults which the longer endurance policy either
 * judges elsewhere or permits as recoverable diagnostics. This short
 * production slice has no recovery injection and no reason to consume either
 * budget. Adding them here makes the two-second proof strict without changing
 * the reusable ten-minute endurance policy.
 */
const productionOnlyMaximumDeltas = {
  control_network_stack_exhaustions: 0,
  generation_fence_acknowledgement_timeouts: 0,
  lifecycle_acknowledgement_timeouts: 0,
  pcm_network_stack_exhaustions: 0,
  playback_write_backpressure_incidents: 0,
} as const;

const productionCounterMaximumDeltas = {
  ...m5StickS3PlaybackEnduranceAcceptancePolicy.thresholds.counterMaximumDeltas,
  ...productionOnlyMaximumDeltas,
};

/**
 * Returns only when the once-per-second callback proves the whole response has
 * reached the DMA completion boundary.
 *
 * `downlinkAccepted` alone is intentionally insufficient: it advances in the
 * PCM network task before the audio owner has submitted or audibly completed a
 * descriptor. The EOS response counter is the owner's explicit statement that
 * all descriptors belonging to this response retired. The final judge still
 * requires exact deltas, so an unexpected extra response cannot become a pass.
 */
export function productionTonePlaybackComplete(
  baseline: KitPlaybackMetrics,
  current: KitPlaybackMetrics,
): boolean {
  return (
    monotonicDelta(current.downlinkAccepted, baseline.downlinkAccepted) >=
      productionToneFrameCount &&
    monotonicDelta(current.playback.submitted, baseline.playback.submitted) >=
      productionToneFrameCount &&
    monotonicDelta(current.playback.completed, baseline.playback.completed) >=
      productionToneFrameCount &&
    monotonicDelta(
      current.playback.endOfStreamMarkersConsumed,
      baseline.playback.endOfStreamMarkersConsumed,
    ) >= 1 &&
    monotonicDelta(current.playback.endOfStreamResponses, baseline.playback.endOfStreamResponses) >=
      1
  );
}

/**
 * Judges one deterministic userspace response from two coherent device views.
 *
 * Firmware counters are cumulative because resetting telemetry at a host
 * boundary would race the real-time owner and destroy postmortem history.
 * Exact before/after deltas give the run a clean boundary while retaining both
 * raw snapshots. A response must contain exactly 100 20-ms frames, retire one
 * EOS marker, and add no loss/recovery/resource incidents.
 */
export function assessProductionM5StickS3TonePlayback(
  baseline: KitPlaybackMetrics,
  current: KitPlaybackMetrics,
): ProductionM5StickS3TonePlaybackAssessment {
  const deltas = {
    downlinkAccepted: delta(current.downlinkAccepted, baseline.downlinkAccepted),
    endOfStreamMarkersConsumed: delta(
      current.playback.endOfStreamMarkersConsumed,
      baseline.playback.endOfStreamMarkersConsumed,
    ),
    endOfStreamResponses: delta(
      current.playback.endOfStreamResponses,
      baseline.playback.endOfStreamResponses,
    ),
    playbackCompleted: delta(current.playback.completed, baseline.playback.completed),
    playbackSubmitted: delta(current.playback.submitted, baseline.playback.submitted),
  };
  const reasons: string[] = [];
  for (const [label, actual, expected] of [
    ["downlink accepted", deltas.downlinkAccepted, productionToneFrameCount],
    ["playback submitted", deltas.playbackSubmitted, productionToneFrameCount],
    ["playback completed", deltas.playbackCompleted, productionToneFrameCount],
    ["EOS markers consumed", deltas.endOfStreamMarkersConsumed, 1],
    ["EOS responses", deltas.endOfStreamResponses, 1],
  ] as const) {
    if (actual !== expected) {
      reasons.push(`${label} ${actual} frames; expected exactly ${expected}`);
    }
  }

  const counterAssessment = assessPlaybackCounterPolicy({
    baseline: flattenKitPlaybackMetrics(baseline),
    current: flattenKitPlaybackMetrics(current),
    maximumDeltas: productionCounterMaximumDeltas,
  });
  if (counterAssessment.kind === "failure") {
    reasons.push(counterAssessment.reason);
  }

  return {
    deltas,
    passed: reasons.length === 0,
    reasons,
  };
}

/*
 * A regression is never terminal progress. Returning negative infinity keeps
 * the polling predicate false; the final assessor retains the actual negative
 * delta and the generic counter policy reports the regression by name.
 */
function monotonicDelta(current: number, baseline: number) {
  return current >= baseline ? current - baseline : Number.NEGATIVE_INFINITY;
}

function delta(current: number, baseline: number) {
  return current - baseline;
}
