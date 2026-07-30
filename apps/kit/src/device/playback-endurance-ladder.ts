import { buildPlaybackEnduranceRunManifest } from "./playback-endurance-run-manifest.ts";
import {
  assertPlaybackEnduranceConfiguration,
  assertPlaybackEnduranceInspection,
} from "./playback-endurance-validation.ts";
import type {
  PlaybackEnduranceLadderResult,
  PlaybackEnduranceLoadProfile,
  PlaybackEndurancePolicyIdentity,
  PlaybackEnduranceRunManifest,
  PlaybackEnduranceTarget,
  PlaybackEnduranceThresholds,
} from "./playback-endurance-types.ts";

export type {
  PlaybackEnduranceArtifact,
  PlaybackEnduranceDeviceIdentity,
  PlaybackEnduranceFirmwareIdentity,
  PlaybackEnduranceLadderResult,
  PlaybackEnduranceLoadEvidence,
  PlaybackEnduranceLoadProfile,
  PlaybackEnduranceMetricSample,
  PlaybackEnduranceMetricsCadenceAudit,
  PlaybackEndurancePcmDeliveryIncident,
  PlaybackEndurancePcmSourceEvidence,
  PlaybackEndurancePersistedAcousticAnalysis,
  PlaybackEndurancePolicyIdentity,
  PlaybackEnduranceRunManifest,
  PlaybackEnduranceRunObservation,
  PlaybackEnduranceTarget,
  PlaybackEnduranceThresholds,
} from "./playback-endurance-types.ts";

export const playbackEnduranceDurationsMs = Object.freeze([60_000, 120_000, 600_000]);
const diagnosticPolicy: PlaybackEndurancePolicyIdentity = Object.freeze({
  classification: "diagnostic",
  id: "iterate.playback-endurance.diagnostic",
  version: 1,
});

/**
 * Executes the same graduated physical proof for every device target.
 *
 * The target owns hardware-specific operations (flashing, transport, Mac
 * microphone capture, and device load generation). The core owns ordering and
 * judgment. That split is deliberate: adapters may differ radically between
 * an M5Stick, StackChan, and ESPHome, but none may redefine "ten minutes",
 * omit counter evidence, or weaken the acoustic oracle.
 *
 * A duration is attempted only after every load profile passed the previous
 * duration. This makes the ladder a resource guard as well as an audio test:
 * one-minute load failures stop before consuming twelve more minutes, while a
 * ten-minute pass cannot hide a failure at a load profile skipped earlier.
 */
export async function runPlaybackEnduranceLadder(options: {
  loadProfiles: PlaybackEnduranceLoadProfile[];
  onRunManifest?(manifest: PlaybackEnduranceRunManifest): Promise<void> | void;
  policy?: PlaybackEndurancePolicyIdentity;
  target: PlaybackEnduranceTarget;
  thresholds: PlaybackEnduranceThresholds;
}): Promise<PlaybackEnduranceLadderResult> {
  assertPlaybackEnduranceConfiguration(options.loadProfiles, options.thresholds);
  const policy = options.policy ?? diagnosticPolicy;
  if (
    !policy.id.trim() ||
    !Number.isSafeInteger(policy.version) ||
    policy.version <= 0 ||
    (policy.classification !== "acceptance" && policy.classification !== "diagnostic")
  ) {
    throw new Error("Invalid playback endurance policy identity.");
  }
  const inspected = await options.target.inspect();
  assertPlaybackEnduranceInspection(inspected.device, inspected.firmware);
  const runs: PlaybackEnduranceRunManifest[] = [];
  const plannedRunCount = playbackEnduranceDurationsMs.length * options.loadProfiles.length;

  for (const durationMs of playbackEnduranceDurationsMs) {
    for (const loadProfile of options.loadProfiles) {
      const observation = await options.target.runPlayback({
        durationMs,
        ladderIndex: runs.length,
        loadProfile,
      });
      const manifest = buildPlaybackEnduranceRunManifest({
        device: inspected.device,
        durationMs,
        firmware: inspected.firmware,
        ladderIndex: runs.length,
        loadProfile,
        observation,
        policy,
        thresholds: options.thresholds,
      });
      runs.push(manifest);
      /*
       * Persist at the stage boundary, while every raw observation is still
       * available and before another long physical operation can fail. The
       * hook is awaited so a full disk or broken evidence sink cannot be
       * reported as a successful endurance run.
       */
      await options.onRunManifest?.(manifest);
      if (!manifest.result.passed) {
        return {
          acceptancePassed: false,
          passed: false,
          plannedRunCount,
          policy: structuredClone(policy),
          runs,
          stoppedAfterFailure: true,
        };
      }
    }
  }

  return {
    acceptancePassed: policy.classification === "acceptance",
    passed: true,
    plannedRunCount,
    policy: structuredClone(policy),
    runs,
    stoppedAfterFailure: false,
  };
}
