import type { DeviceRuntimeMetrics } from "./device-runtime-log.ts";
import type { KitSynchronousPlaybackHealthMetrics } from "./kit-device-contract.ts";

export interface PhysicalAecLifecycleDelta {
  captureFailures: number;
  captureFrameDrops: number;
  playbackDroppedFrames: number;
  playbackIntegrityFailures: number;
  playbackResets: number;
  uplinkFrameDrops: number;
  uplinkRestarts: number;
}

export interface PhysicalAecStartupAssessment {
  observed: PhysicalAecLifecycleDelta;
  passed: boolean;
  reasons: string[];
}

/**
 * Derives the destructive-path ledger shared by the two physical AEC targets.
 *
 * The general callback owns capture and `/pcm` publication counters, while the
 * topology-specific AEC callback owns physical speaker counters. Keeping the
 * join here prevents StackChan and HAVPE proof scripts from quietly adopting
 * different definitions of a clean interval. A missing or regressed counter
 * returns one failure rather than zero: absent evidence must never manufacture
 * a lossless run.
 */
export function derivePhysicalAecLifecycleDelta(options: {
  afterGeneral: DeviceRuntimeMetrics;
  afterPlayback: KitSynchronousPlaybackHealthMetrics;
  beforeGeneral: DeviceRuntimeMetrics;
  beforePlayback: KitSynchronousPlaybackHealthMetrics;
}): PhysicalAecLifecycleDelta {
  const generalDelta = (name: string) =>
    monotonicDelta(options.beforeGeneral[name], options.afterGeneral[name]);
  const playbackDelta = (name: keyof KitSynchronousPlaybackHealthMetrics) =>
    monotonicDelta(options.beforePlayback[name], options.afterPlayback[name]);

  return {
    captureFailures: generalDelta("audio_failures"),
    captureFrameDrops: generalDelta("audio_dropped"),
    playbackDroppedFrames:
      playbackDelta("lifetimePlaybackFramesDiscardedByReset") +
      playbackDelta("lifetimePlaybackStaleFramesDiscarded"),
    playbackIntegrityFailures:
      playbackDelta("lifetimePlaybackWriteFailures") +
      playbackDelta("lifetimePlaybackQueueOverflows") +
      playbackDelta("lifetimePlaybackPolicyErrors") +
      playbackDelta("lifetimePlaybackResetFailures") +
      playbackDelta("lifetimePlaybackObservationFailures") +
      playbackDelta("lifetimePlaybackUnderrunIncidents"),
    playbackResets: playbackDelta("lifetimePlaybackResets"),
    uplinkFrameDrops: generalDelta("uplink_dropped"),
    uplinkRestarts: generalDelta("uplink_restart_incidents"),
  };
}

/**
 * Classifies the deliberate idle -> connected generation barrier separately
 * from the media interval under test.
 *
 * A new lifetime `/pcm` generation must reset cyclic speaker DMA exactly once
 * before it can admit downlink. On a fast LAN that reset can precede the first
 * subscription callback; on Captun it can land between the two startup
 * callbacks. Conversation media gating must not create a second generation.
 * The absolute post-start counter is therefore the invariant, while the delta
 * is retained only to explain which ordering occurred. Requiring an observed
 * delta of one would make transport latency—not device behaviour—decide the
 * verdict. All destructive counters remain strict zero.
 */
export function assessPhysicalAecStartupTransition(options: {
  afterGeneral: DeviceRuntimeMetrics;
  afterPlayback: KitSynchronousPlaybackHealthMetrics;
  beforeGeneral: DeviceRuntimeMetrics;
  beforePlayback: KitSynchronousPlaybackHealthMetrics;
}): PhysicalAecStartupAssessment {
  const observed = derivePhysicalAecLifecycleDelta(options);
  const reasons: string[] = [];
  const beforeResets = options.beforePlayback.lifetimePlaybackResets;
  const afterResets = options.afterPlayback.lifetimePlaybackResets;
  if (!isNonnegativeInteger(beforeResets) || beforeResets > 1) {
    reasons.push(
      `Startup generation barrier pre-observation count was ${String(beforeResets)}; expected 0 or 1.`,
    );
  }
  if (!isNonnegativeInteger(afterResets) || afterResets !== 1) {
    reasons.push(
      `Startup generation barrier lifetime count was ${String(afterResets)}; expected exactly 1.`,
    );
  }
  for (const [label, value] of [
    ["capture failures", observed.captureFailures],
    ["capture frame drops", observed.captureFrameDrops],
    ["playback frames discarded", observed.playbackDroppedFrames],
    ["playback integrity failures", observed.playbackIntegrityFailures],
    ["uplink frame drops", observed.uplinkFrameDrops],
    ["uplink restarts", observed.uplinkRestarts],
  ] as const) {
    if (value !== 0) reasons.push(`Startup reported ${value} ${label}; expected 0.`);
  }
  return { observed, passed: reasons.length === 0, reasons };
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function monotonicDelta(before: unknown, after: unknown) {
  if (
    typeof before !== "number" ||
    typeof after !== "number" ||
    !Number.isSafeInteger(before) ||
    !Number.isSafeInteger(after) ||
    before < 0 ||
    after < before
  ) {
    return 1;
  }
  return after - before;
}
