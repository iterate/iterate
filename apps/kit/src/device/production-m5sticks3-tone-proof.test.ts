import { describe, expect, test } from "vitest";
import type { KitPlaybackMetrics } from "./kit-device-contract.ts";
import {
  assessProductionM5StickS3TonePlayback,
  productionTonePlaybackComplete,
} from "./production-m5sticks3-tone-proof.ts";

function playbackMetrics(
  overrides: {
    accepted?: number;
    completed?: number;
    eosMarkers?: number;
    eosResponses?: number;
    freshnessDrops?: number;
    submitted?: number;
    underrunIncidents?: number;
  } = {},
): KitPlaybackMetrics {
  return {
    schemaVersion: 5,
    sequence: 1,
    producedAtMs: 1_000,
    downlinkAccepted: overrides.accepted ?? 500,
    playback: {
      submitted: overrides.submitted ?? 480,
      completed: overrides.completed ?? 479,
      generationFramesFlushed: 0,
      freshnessFramesDropped: overrides.freshnessDrops ?? 23,
      partialPrebufferFramesDropped: 0,
      underrunFramesFlushed: 0,
      underrunIncidents: overrides.underrunIncidents ?? 2,
      underrunSilenceFramesSubmitted: 0,
      underrunSilenceFramesCompleted: 0,
      underrunSilenceFramesRetired: 0,
      underrunLateFramesDropped: 0,
      dmaDeadlineMissIncidents: 0,
      freshnessIncidents: 0,
      partialPrebufferIncidents: 0,
      endOfStreamMarkersConsumed: overrides.eosMarkers ?? 4,
      endOfStreamResponses: overrides.eosResponses ?? 4,
      endOfStreamSilenceDescriptors: 0,
      endOfStreamPaddingDescriptorsCompleted: 0,
      driverQueueOverflowIncidents: 0,
      driverFailures: 0,
      driverStopFailures: 0,
      fatalFramesFlushed: 0,
      writeBackpressureIncidents: 0,
      writeBackpressureDestructiveResets: 0,
      writeBackpressureFramesDropped: 0,
      invalidFrames: 0,
      stateErrors: 0,
      ownerClockRegressions: 0,
      receiveToDmaStartSamples: 479,
      maximumReceiveToDmaStartMs: 73,
      downlinkInterarrivalSamples: 499,
      maximumDownlinkInterarrivalMs: 30,
      maximumEofToSuccessfulRefillUs: 2_000,
      maximumWriteCallDurationUs: 500,
      minimumReuseLeadAtSuccessfulRefillUs: 40_000,
    },
    runtime: {
      audioOwnerStackHeadroomBytes: 5_000,
      mainStackHeadroomBytes: 5_000,
      controlNetworkStackHeadroomBytes: 5_000,
      pcmNetworkStackHeadroomBytes: 5_000,
      freeInternalHeapBytes: 50_000,
      minimumFreeInternalHeapBytes: 45_000,
      freeDmaHeapBytes: 40_000,
      minimumFreeDmaHeapBytes: 35_000,
      largestFreeInternalHeapBlockBytes: 30_000,
      largestFreeDmaBlockBytes: 25_000,
      cpuPermille: 150,
      generationFenceAcknowledgementTimeouts: 0,
      lifecycleAcknowledgementTimeouts: 0,
      controlNetworkStackExhaustions: 0,
      pcmNetworkStackExhaustions: 0,
      pcmReceiveCalls: 500,
      pcmReceiveChunks: 500,
      controlNetworkMaximumWorkCycles: 2,
      pcmNetworkMaximumWorkCycles: 4,
    },
  };
}

describe("production M5StickS3 deterministic-return playback proof", () => {
  test("accepts exactly one 100-frame response despite historical incidents", () => {
    /*
     * A freshly flashed process is useful but not a trustworthy run boundary:
     * reconnecting the host or repeating an acoustic capture leaves cumulative
     * counters nonzero. Requiring absolute zero would make the proof depend on
     * a reboot; comparing exact deltas isolates this response without erasing
     * earlier failures from the retained before/after snapshots.
     */
    const baseline = playbackMetrics();
    const current = playbackMetrics({
      accepted: 600,
      completed: 579,
      eosMarkers: 5,
      eosResponses: 5,
      submitted: 580,
    });

    expect(productionTonePlaybackComplete(baseline, current)).toBe(true);
    expect(assessProductionM5StickS3TonePlayback(baseline, current)).toMatchObject({
      passed: true,
      deltas: {
        downlinkAccepted: 100,
        playbackCompleted: 100,
        playbackSubmitted: 100,
      },
      reasons: [],
    });
  });

  test("does not report terminal completion until DMA completion and EOS response arrive", () => {
    const baseline = playbackMetrics();
    const current = playbackMetrics({
      accepted: 600,
      completed: 578,
      eosMarkers: 5,
      eosResponses: 4,
      submitted: 580,
    });

    expect(productionTonePlaybackComplete(baseline, current)).toBe(false);
  });

  test("fails a response that added one loss incident even when all 100 frames completed", () => {
    /*
     * Hearing a plausible two-second tone is not enough: a concealed stale
     * frame drop followed by silence or replacement audio can still sound
     * superficially continuous in a room recording. The coherent device
     * counter snapshot is therefore an independent no-loss gate.
     */
    const baseline = playbackMetrics();
    const current = playbackMetrics({
      accepted: 600,
      completed: 579,
      eosMarkers: 5,
      eosResponses: 5,
      freshnessDrops: 24,
      submitted: 580,
    });

    const assessment = assessProductionM5StickS3TonePlayback(baseline, current);
    expect(assessment.passed).toBe(false);
    expect(assessment.reasons.join(" ")).toMatch(/freshness_frames_dropped/u);
  });

  test("fails under-delivery rather than silently accepting a shorter response", () => {
    const baseline = playbackMetrics();
    const current = playbackMetrics({
      accepted: 599,
      completed: 578,
      eosMarkers: 5,
      eosResponses: 5,
      submitted: 579,
    });

    const assessment = assessProductionM5StickS3TonePlayback(baseline, current);
    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain("downlink accepted 99 frames; expected exactly 100");
  });
});
