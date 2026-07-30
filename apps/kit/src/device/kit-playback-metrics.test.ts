import { describe, expect, test } from "vitest";
import type { KitPlaybackMetrics } from "./kit-device-contract.ts";
import { flattenKitPlaybackMetrics, parseKitPlaybackMetrics } from "./kit-playback-metrics.ts";

function fixture(): KitPlaybackMetrics {
  return {
    schemaVersion: 3,
    sequence: 7,
    producedAtMs: 12_345,
    downlinkAccepted: 8,
    playback: {
      submitted: 9,
      completed: 10,
      generationFramesFlushed: 11,
      freshnessFramesDropped: 12,
      partialPrebufferFramesDropped: 13,
      underrunFramesFlushed: 14,
      underrunIncidents: 15,
      underrunSilenceFramesSubmitted: 16,
      underrunSilenceFramesCompleted: 17,
      underrunSilenceFramesRetired: 18,
      underrunLateFramesDropped: 19,
      dmaDeadlineMissIncidents: 20,
      freshnessIncidents: 21,
      partialPrebufferIncidents: 22,
      endOfStreamMarkersConsumed: 23,
      endOfStreamResponses: 24,
      endOfStreamSilenceDescriptors: 25,
      endOfStreamPaddingDescriptorsCompleted: 26,
      driverQueueOverflowIncidents: 27,
      driverFailures: 28,
      driverStopFailures: 29,
      fatalFramesFlushed: 30,
      writeBackpressureIncidents: 31,
      writeBackpressureDestructiveResets: 32,
      writeBackpressureFramesDropped: 33,
      invalidFrames: 34,
      stateErrors: 35,
      ownerClockRegressions: 36,
      successfulRefillTimingSamples: 37,
      lastEofToSuccessfulRefillUs: 38,
      maximumEofToSuccessfulRefillUs: 39,
      lastWriteCallDurationUs: 40,
      maximumWriteCallDurationUs: 41,
      lastReuseLeadAtSuccessfulRefillUs: 42,
      minimumReuseLeadAtSuccessfulRefillUs: 43,
    },
    runtime: {
      audioOwnerStackHeadroomBytes: 40,
      mainStackHeadroomBytes: 41,
      controlNetworkStackHeadroomBytes: 42,
      pcmNetworkStackHeadroomBytes: 43,
      freeInternalHeapBytes: 44,
      minimumFreeInternalHeapBytes: 45,
      freeDmaHeapBytes: 46,
      minimumFreeDmaHeapBytes: 47,
      largestFreeInternalHeapBlockBytes: 48,
      largestFreeDmaBlockBytes: 49,
      cpuPermille: 50,
      generationFenceAcknowledgementTimeouts: 51,
      lifecycleAcknowledgementTimeouts: 52,
      controlNetworkStackExhaustions: 53,
      pcmNetworkStackExhaustions: 54,
      controlNetworkMaximumWorkCycles: 55,
      pcmNetworkMaximumWorkCycles: 56,
    },
  };
}

describe("Kit detailed playback metrics", () => {
  test("rejects an incomplete C callback instead of manufacturing zero evidence", () => {
    /*
     * Missing failure counters are not backwards-compatible optionality. If an
     * older or truncated firmware omits one, treating it as zero would let the
     * exact defect the counter guards pass the physical endurance gate.
     */
    const value = fixture() as unknown as {
      playback: Record<string, unknown>;
    };
    delete value.playback.dmaDeadlineMissIncidents;

    expect(() => parseKitPlaybackMetrics(value)).toThrow(/dmaDeadlineMissIncidents/u);
  });

  test("expands compact wire groups into stable conservative evidence names", () => {
    const parsed = parseKitPlaybackMetrics(fixture());
    const values = flattenKitPlaybackMetrics(parsed);

    expect(values).toMatchObject({
      downlink_accepted: 8,
      playback_completed: 10,
      playback_dma_deadline_miss_incidents: 20,
      playback_underrun_silence_frames_submitted: 16,
      playback_underrun_silence_frames_completed: 17,
      playback_underrun_silence_frames_retired: 18,
      playback_underrun_late_frames_dropped: 19,
      playback_minimum_reuse_lead_at_successful_refill_us: 43,
      audio_owner_stack_headroom_bytes: 40,
      control_network_stack_headroom_bytes: 42,
      pcm_network_stack_headroom_bytes: 43,
      control_stack_headroom_bytes: 42,
      network_stack_headroom_bytes: 42,
      control_network_maximum_work_cycles: 55,
      pcm_network_maximum_work_cycles: 56,
    });
  });

  test("retains the explicit unavailable first CPU sample", () => {
    const value = fixture();
    value.runtime.cpuPermille = -1;

    expect(flattenKitPlaybackMetrics(parseKitPlaybackMetrics(value))).toMatchObject({
      cpu_permille: -1,
    });
  });
});
