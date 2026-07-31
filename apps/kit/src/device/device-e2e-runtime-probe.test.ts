import { describe, expect, test, vi } from "vitest";
import { DeviceRuntimeProbe } from "../../scripts/device-e2e.ts";
import type { KitPlaybackMetrics } from "./kit-device-contract.ts";

function playbackMetrics(input: {
  accepted: number;
  calls: number;
  chunks: number;
  completed: number;
  sequence: number;
  submitted: number;
}): KitPlaybackMetrics {
  return {
    schemaVersion: 5,
    sequence: input.sequence,
    producedAtMs: input.sequence * 1_000,
    downlinkAccepted: input.accepted,
    playback: {
      submitted: input.submitted,
      completed: input.completed,
      generationFramesFlushed: 0,
      freshnessFramesDropped: 0,
      partialPrebufferFramesDropped: 0,
      underrunFramesFlushed: 0,
      underrunIncidents: 0,
      underrunSilenceFramesSubmitted: 0,
      underrunSilenceFramesCompleted: 0,
      underrunSilenceFramesRetired: 0,
      underrunLateFramesDropped: 0,
      dmaDeadlineMissIncidents: 0,
      freshnessIncidents: 0,
      partialPrebufferIncidents: 0,
      endOfStreamMarkersConsumed: 0,
      endOfStreamResponses: 0,
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
      receiveToDmaStartSamples: input.completed,
      maximumReceiveToDmaStartMs: 154,
      downlinkInterarrivalSamples: input.accepted - 1,
      maximumDownlinkInterarrivalMs: 80,
      maximumEofToSuccessfulRefillUs: 774,
      maximumWriteCallDurationUs: 95,
      minimumReuseLeadAtSuccessfulRefillUs: 59_226,
    },
    runtime: {
      audioOwnerStackHeadroomBytes: 6_652,
      mainStackHeadroomBytes: 2_584,
      controlNetworkStackHeadroomBytes: 960,
      pcmNetworkStackHeadroomBytes: 4_288,
      freeInternalHeapBytes: 140_899,
      minimumFreeInternalHeapBytes: 127_815,
      freeDmaHeapBytes: 140_899,
      minimumFreeDmaHeapBytes: 127_815,
      largestFreeInternalHeapBlockBytes: 53_248,
      largestFreeDmaBlockBytes: 53_248,
      cpuPermille: 285,
      generationFenceAcknowledgementTimeouts: 0,
      lifecycleAcknowledgementTimeouts: 0,
      controlNetworkStackExhaustions: 0,
      pcmNetworkStackExhaustions: 0,
      pcmReceiveCalls: input.calls,
      pcmReceiveChunks: input.chunks,
      controlNetworkMaximumWorkCycles: 2_713_189,
      pcmNetworkMaximumWorkCycles: 3_890_972,
    },
  };
}

describe("device E2E runtime probe", () => {
  test("retains one post-close playback sample before rejecting an unexpected PCM close", async () => {
    /*
     * The physical host freshness gate closes after eight send callbacks have
     * remained owned for roughly 160 ms. Rejecting synchronously tears down the
     * independent Cap'n Web connection and loses the only counters that can
     * tell whether the device task ran, read bytes, or completed a frame during
     * that interval. The run must still reject; it merely waits for one bounded
     * latest-state callback and never buffers or resumes stale audio.
     */
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const probe = new DeviceRuntimeProbe();
    probe.observePlaybackMetrics(
      playbackMetrics({
        accepted: 2_051,
        calls: 10_405,
        chunks: 2_071,
        completed: 2_044,
        sequence: 44,
        submitted: 2_048,
      }),
    );
    let outcome: { error: Error; kind: "rejected" } | undefined;
    const failure = probe.race(new Promise<never>(() => {})).catch((error: unknown) => {
      const rejected = {
        error: error instanceof Error ? error : new Error(String(error)),
        kind: "rejected" as const,
      };
      outcome = rejected;
      return rejected;
    });

    probe.observePcmSocketClose({
      classification: "unexpected",
      code: 4013,
      origin: "device",
      reason: "LAN bridge backpressure.",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outcome).toBeUndefined();

    probe.observePlaybackMetrics(
      playbackMetrics({
        accepted: 2_051,
        calls: 10_425,
        chunks: 2_071,
        completed: 2_044,
        sequence: 45,
        submitted: 2_048,
      }),
    );

    await expect(failure).resolves.toMatchObject({
      error: {
        message: "PCM device socket closed unexpectedly with code 4013: LAN bridge backpressure..",
      },
      kind: "rejected",
    });
    const diagnosticLine = log.mock.calls
      .flat()
      .find(
        (value): value is string =>
          typeof value === "string" && value.startsWith("pcm_socket_close_followup_metrics="),
      );
    expect(diagnosticLine).toBeDefined();
    expect(JSON.parse(diagnosticLine!.slice(diagnosticLine!.indexOf("=") + 1))).toMatchObject({
      baseline: {
        downlinkAccepted: 2_051,
        pcmReceiveCalls: 10_405,
        pcmReceiveChunks: 2_071,
        sequence: 44,
      },
      current: {
        downlinkAccepted: 2_051,
        pcmReceiveCalls: 10_425,
        pcmReceiveChunks: 2_071,
        sequence: 45,
      },
      deltas: {
        downlinkAccepted: 0,
        pcmReceiveCalls: 20,
        pcmReceiveChunks: 0,
        playbackCompleted: 0,
        playbackSubmitted: 0,
      },
    });
    log.mockRestore();
  });

  test("rejects on a bounded timer when no post-close control sample can arrive", async () => {
    /*
     * The control socket is intentionally independent from the PCM socket, but
     * it can still fail at the same time (for example when Wi-Fi disconnects).
     * Diagnostics must improve a failure report, never turn a realtime failure
     * into an unbounded test hang. This is also why the implementation owns one
     * timer rather than retrying or waiting for a reconnect indefinitely.
     */
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const probe = new DeviceRuntimeProbe();
      probe.observePlaybackMetrics(
        playbackMetrics({
          accepted: 2_051,
          calls: 10_405,
          chunks: 2_071,
          completed: 2_044,
          sequence: 44,
          submitted: 2_048,
        }),
      );
      const failure = probe.race(new Promise<never>(() => {}));

      probe.observePcmSocketClose({
        classification: "unexpected",
        code: 4013,
        origin: "device",
        reason: "LAN bridge backpressure.",
      });
      await vi.advanceTimersByTimeAsync(5_999);
      let settled = false;
      void failure.catch(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(failure).rejects.toThrow("PCM device socket closed unexpectedly with code 4013");
      const timeoutLine = errorLog.mock.calls
        .flat()
        .find(
          (value): value is string =>
            typeof value === "string" && value.startsWith("pcm_socket_close_followup_timeout="),
        );
      expect(timeoutLine).toBeDefined();
      expect(JSON.parse(timeoutLine!.slice(timeoutLine!.indexOf("=") + 1))).toMatchObject({
        baseline: {
          downlinkAccepted: 2_051,
          pcmReceiveCalls: 10_405,
          pcmReceiveChunks: 2_071,
          sequence: 44,
        },
        close: {
          classification: "unexpected",
          code: 4013,
          origin: "device",
        },
        waitedMs: 6_000,
      });
    } finally {
      log.mockRestore();
      errorLog.mockRestore();
      vi.useRealTimers();
    }
  });
});
