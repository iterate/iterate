import { describe, expect, test } from "vitest";
import type { KitAecMetrics } from "./kit-device-contract.ts";
import { assessStackChanAecRun, parseKitAecMetrics } from "./stackchan-aec-assessment.ts";

function sample(overrides: Partial<KitAecMetrics> = {}): KitAecMetrics {
  return {
    schemaVersion: 11,
    sequence: 1,
    windowStartedAtMs: 1_000,
    producedAtMs: 2_000,
    sampleStride: 8,
    sampledSamples: 2_048,
    nearPeak: 20_000,
    referencePeak: 2_000,
    cleanPeak: 5_000,
    nearMeanAbsolute: 600,
    referenceMeanAbsolute: 100,
    cleanMeanAbsolute: 1_600,
    engineProfile: 1,
    processingFrameSamples: 256,
    nearWindowGainMultiplier: 6,
    farWindowGainMultiplier: 8,
    speakerVolumePercent: 90,
    microphoneGainDb: 24,
    referenceGainDb: 0,
    lifetimeFramesProcessed: 100,
    lifetimeRecreates: 0,
    lifetimeRecreateFailures: 0,
    lastProcessUs: 12_000,
    maximumProcessUs: 16_000,
    lastCaptureToUplinkUs: 20_000,
    maximumCaptureToUplinkUs: 40_000,
    lifetimeCaptureReserveDroppedChunks: 0,
    lifetimeCaptureChunksWithPlaybackContent: 80,
    lifetimeCaptureChunksWithoutPlaybackContent: 120,
    lifetimeCaptureBridgeErrors: 0,
    lifetimeSignalMeasurementFailures: 0,
    lifetimeReferenceScaleClippedSamples: 0,
    lifetimeNearHighPassClippedSamples: 0,
    lifetimeUplinkGainClippedSamples: 0,
    lifetimePlaybackContentSamples: 96_000,
    lifetimePlaybackResets: 0,
    lifetimePlaybackFramesDiscardedByReset: 0,
    lifetimePlaybackWriteFailures: 0,
    lifetimePlaybackQueueOverflows: 0,
    lifetimePlaybackPolicyErrors: 0,
    lifetimePlaybackResetFailures: 0,
    lifetimePlaybackObservationFailures: 0,
    lifetimePlaybackUnderrunIncidents: 0,
    lifetimePlaybackUnderrunSilenceSamples: 0,
    lifetimePlaybackStaleFramesDiscarded: 0,
    lastPlaybackWriteUs: 8_000,
    maximumPlaybackWriteUs: 9_000,
    lastReceiveToRenderMs: 20,
    maximumReceiveToRenderMs: 30,
    ...overrides,
  };
}

describe("StackChan AEC evidence", () => {
  test("accepts the three lifetime clipping counters required to qualify physical audio", () => {
    expect(
      parseKitAecMetrics(
        sample({
          lifetimeReferenceScaleClippedSamples: 11,
          lifetimeNearHighPassClippedSamples: 12,
          lifetimeUplinkGainClippedSamples: 13,
        }),
      ),
    ).toMatchObject({
      lifetimeReferenceScaleClippedSamples: 11,
      lifetimeNearHighPassClippedSamples: 12,
      lifetimeUplinkGainClippedSamples: 13,
    });
  });

  test("rejects otherwise clean physical evidence when any conditioning boundary clips", () => {
    const assessment = assessStackChanAecRun([
      sample(),
      sample({
        sequence: 2,
        lifetimeReferenceScaleClippedSamples: 1,
        lifetimeNearHighPassClippedSamples: 2,
        lifetimeUplinkGainClippedSamples: 3,
      }),
    ]);

    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toEqual(
      expect.arrayContaining([
        "electrical AEC reference scaler clipped 1 sample during the run.",
        "near-microphone high-pass clipped 2 samples during the run.",
        "selected uplink gain stage clipped 3 samples during the run.",
      ]),
    );
  });

  test("proves far-end suppression and near-end preservation from aligned windows", () => {
    const assessment = assessStackChanAecRun([
      sample(),
      sample({
        sequence: 2,
        windowStartedAtMs: 2_000,
        producedAtMs: 3_000,
        nearPeak: 2_000,
        referencePeak: 12,
        cleanPeak: 1_950,
        nearMeanAbsolute: 250,
        referenceMeanAbsolute: 0,
        cleanMeanAbsolute: 1_440,
        lifetimeFramesProcessed: 131,
        lifetimeCaptureChunksWithPlaybackContent: 98,
        lifetimeCaptureChunksWithoutPlaybackContent: 164,
      }),
    ]);

    expect(assessment.passed).toBe(true);
    expect(assessment.farEnd.echoSuppressionDb).toBeCloseTo(9.54, 1);
    expect(assessment.nearEnd.cleanToNearRatio).toBeCloseTo(0.96, 2);
  });

  /*
   * This is the oracle's satisfiability proof. The production selector exposes
   * the unscaled near tap but sends raw near x6 while playback is quiet and a
   * processed x8 signal while playback is active. A mathematically perfect
   * canceller behind those gains must pass without weakening either the
   * near-preservation or echo-suppression threshold.
   */
  test("accepts a perfect canceller behind the production x6/x8 wire gains", () => {
    const assessment = assessStackChanAecRun([
      sample({ cleanMeanAbsolute: 0 }),
      sample({
        sequence: 2,
        windowStartedAtMs: 2_000,
        producedAtMs: 3_000,
        nearPeak: 2_000,
        referencePeak: 0,
        cleanPeak: 12_000,
        nearMeanAbsolute: 250,
        referenceMeanAbsolute: 0,
        cleanMeanAbsolute: 1_500,
        lifetimeFramesProcessed: 131,
        lifetimeCaptureChunksWithPlaybackContent: 98,
        lifetimeCaptureChunksWithoutPlaybackContent: 164,
      }),
    ]);

    expect(assessment.passed).toBe(true);
    expect(assessment.farEnd.echoSuppressionDb).toBe(Number.POSITIVE_INFINITY);
    expect(assessment.nearEnd.cleanToNearRatio).toBe(1);
  });

  test("does not let duplicate callback polls count as independent signal windows", () => {
    const duplicate = sample({ lifetimeFramesProcessed: 103 });
    const assessment = assessStackChanAecRun([sample(), duplicate]);

    expect(assessment.windows.unique).toBe(1);
    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain("No aligned near-end speech window was observed.");
  });

  test("fails on destructive DSP lifecycle changes even when amplitudes look healthy", () => {
    const assessment = assessStackChanAecRun([
      sample(),
      sample({
        sequence: 2,
        windowStartedAtMs: 2_000,
        producedAtMs: 3_000,
        nearPeak: 2_000,
        referencePeak: 10,
        cleanPeak: 1_900,
        nearMeanAbsolute: 250,
        referenceMeanAbsolute: 0,
        cleanMeanAbsolute: 1_440,
        lifetimeFramesProcessed: 131,
        lifetimeCaptureReserveDroppedChunks: 1,
      }),
    ]);

    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain("AEC capture reserve dropped 1 chunk during the run.");
  });

  test("fails when no microphone capture chunks reach AEC during the run", () => {
    const assessment = assessStackChanAecRun([
      sample(),
      sample({
        sequence: 2,
        windowStartedAtMs: 2_000,
        producedAtMs: 3_000,
        nearPeak: 2_000,
        referencePeak: 10,
        cleanPeak: 1_900,
        nearMeanAbsolute: 250,
        referenceMeanAbsolute: 0,
        cleanMeanAbsolute: 1_440,
        lifetimeFramesProcessed: 131,
      }),
    ]);

    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain(
      "AEC consumed no microphone capture chunks during the run.",
    );
  });

  /*
   * Speaker-only suppression is meaningless if the codec reset or discarded
   * the very downlink used as the far-end fixture. Keep that playback clock
   * evidence on the same callback as the aligned AEC window so a harness
   * cannot accidentally combine unrelated, differently sampled snapshots.
   */
  test("fails when the synchronous playback path resets during otherwise healthy AEC", () => {
    const assessment = assessStackChanAecRun([
      sample(),
      sample({
        sequence: 2,
        windowStartedAtMs: 2_000,
        producedAtMs: 3_000,
        nearPeak: 2_000,
        referencePeak: 10,
        cleanPeak: 1_900,
        nearMeanAbsolute: 250,
        referenceMeanAbsolute: 0,
        cleanMeanAbsolute: 1_440,
        lifetimeFramesProcessed: 131,
        lifetimePlaybackContentSamples: 144_000,
        lifetimePlaybackResets: 1,
        lifetimePlaybackFramesDiscardedByReset: 3,
      }),
    ]);

    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain(
      "Playback reset 1 time during the run; expected exactly 0 harness-requested resets.",
    );
    expect(assessment.reasons).toContain("Playback discarded 3 downlink frames during reset.");
  });

  test("classifies a harness-requested playback reset without hiding a surplus reset", () => {
    const healthyNearEnd = {
      sequence: 2,
      windowStartedAtMs: 2_000,
      producedAtMs: 3_000,
      nearPeak: 2_000,
      referencePeak: 10,
      cleanPeak: 11_400,
      nearMeanAbsolute: 250,
      referenceMeanAbsolute: 0,
      cleanMeanAbsolute: 1_440,
      lifetimeFramesProcessed: 131,
      lifetimeCaptureChunksWithPlaybackContent: 98,
      lifetimeCaptureChunksWithoutPlaybackContent: 164,
      lifetimePlaybackResets: 1,
      lifetimePlaybackFramesDiscardedByReset: 3,
    } satisfies Partial<KitAecMetrics>;

    const expected = assessStackChanAecRun([sample(), sample(healthyNearEnd)], {
      expectedPlaybackResets: 1,
    });
    expect(expected.passed).toBe(true);

    const surplus = assessStackChanAecRun(
      [sample(), sample({ ...healthyNearEnd, lifetimePlaybackResets: 2 })],
      { expectedPlaybackResets: 1 },
    );
    expect(surplus.passed).toBe(false);
    expect(surplus.reasons).toContain(
      "Playback reset 2 times during the run; expected exactly 1 harness-requested reset.",
    );
  });

  test("does not combine near and far evidence from different AEC profiles", () => {
    const assessment = assessStackChanAecRun([
      sample(),
      sample({
        sequence: 2,
        windowStartedAtMs: 2_000,
        producedAtMs: 3_000,
        engineProfile: 2,
        processingFrameSamples: 512,
        nearWindowGainMultiplier: 8,
        nearPeak: 2_000,
        referencePeak: 0,
        cleanPeak: 2_000,
        nearMeanAbsolute: 250,
        referenceMeanAbsolute: 0,
        cleanMeanAbsolute: 2_000,
        lifetimeFramesProcessed: 131,
        lifetimeCaptureChunksWithPlaybackContent: 98,
        lifetimeCaptureChunksWithoutPlaybackContent: 164,
      }),
    ]);

    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain(
      "AEC engine/frame/gain/analogue operating point changed during the assessed interval.",
    );
  });

  test("does not combine evidence from different analogue operating points", () => {
    /*
     * The next causal experiment changes only microphone PGA from 24 to
     * 18 dB. If a reconnect crosses firmware generations, combining the best
     * far window from one gain with the best near window from the other would
     * falsely attribute a result to an operating point no device ran.
     */
    const assessment = assessStackChanAecRun([
      sample(),
      sample({
        sequence: 2,
        windowStartedAtMs: 2_000,
        producedAtMs: 3_000,
        microphoneGainDb: 18,
        nearPeak: 2_000,
        referencePeak: 0,
        cleanPeak: 2_000,
        nearMeanAbsolute: 250,
        referenceMeanAbsolute: 0,
        cleanMeanAbsolute: 2_000,
        lifetimeFramesProcessed: 131,
        lifetimeCaptureChunksWithPlaybackContent: 98,
        lifetimeCaptureChunksWithoutPlaybackContent: 164,
      }),
    ]);

    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain(
      "AEC engine/frame/gain/analogue operating point changed during the assessed interval.",
    );
  });

  test("uses exported lifetime maxima instead of a conveniently fast final sample", () => {
    const assessment = assessStackChanAecRun([
      sample({
        lastCaptureToUplinkUs: 10_000,
        maximumCaptureToUplinkUs: 120_000,
      }),
      sample({
        sequence: 2,
        windowStartedAtMs: 2_000,
        producedAtMs: 3_000,
        nearPeak: 2_000,
        referencePeak: 0,
        cleanPeak: 2_000,
        nearMeanAbsolute: 250,
        referenceMeanAbsolute: 0,
        cleanMeanAbsolute: 1_500,
        lifetimeFramesProcessed: 131,
        lifetimeCaptureChunksWithPlaybackContent: 98,
        lifetimeCaptureChunksWithoutPlaybackContent: 164,
        lastCaptureToUplinkUs: 10_000,
        maximumCaptureToUplinkUs: 120_000,
      }),
    ]);

    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain(
      "Observed capture-to-uplink latency reached 120000 us; expected at most 100000 us.",
    );
  });

  test("rejects AEC processing that exceeds the declared physical frame deadline", () => {
    /*
     * A fixed 30 ms allowance blessed the rejected linear profile's 22 ms
     * work on a 16 ms frame, even while its capture reserve accumulated loss.
     * The frame shape is already part of the evidence contract, so deadline
     * validity must follow it rather than the historically slowest profile.
     */
    const assessment = assessStackChanAecRun([
      sample({ maximumProcessUs: 20_000 }),
      sample({
        sequence: 2,
        windowStartedAtMs: 2_000,
        producedAtMs: 3_000,
        nearPeak: 2_000,
        referencePeak: 0,
        cleanPeak: 2_000,
        nearMeanAbsolute: 250,
        referenceMeanAbsolute: 0,
        cleanMeanAbsolute: 1_500,
        lifetimeFramesProcessed: 131,
        lifetimeCaptureChunksWithPlaybackContent: 98,
        lifetimeCaptureChunksWithoutPlaybackContent: 164,
        maximumProcessUs: 20_000,
      }),
    ]);

    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain(
      "Observed AEC processing reached 20000 us; exceeded the 16000 us deadline for a 256-sample frame.",
    );
  });

  test("rejects malformed callback payloads before they become physical evidence", () => {
    expect(() => parseKitAecMetrics({ ...sample(), nearPeak: -1 })).toThrow("nearPeak");
    expect(() => parseKitAecMetrics({ ...sample(), nearPeak: 32_768 })).toThrow("nearPeak");
    expect(() => parseKitAecMetrics({ ...sample(), microphoneGainDb: 38 })).toThrow(
      "microphoneGainDb",
    );
    /*
     * Schema 9 cannot identify whether its gain fields describe the selector
     * control or the new constant-output profile. Refuse ambiguous evidence
     * even though its amplitudes and counters remain arithmetically plausible.
     */
    expect(() => parseKitAecMetrics({ ...sample(), schemaVersion: 10 })).toThrow("schemaVersion");
  });

  test("recognises the VOIP constant-output profile as distinct evidence", () => {
    /*
     * A late acoustic echo was observed only after the playback-switched
     * profile returned to raw microphone output. The next experiment keeps
     * the already-proven VOIP engine but removes that topology edge. Give the
     * profile its own wire identity: reusing profile 1 would let an assessor
     * combine windows produced by materially different uplink policies.
     */
    expect(
      parseKitAecMetrics({
        ...sample(),
        engineProfile: 3,
        nearWindowGainMultiplier: 8,
      }).engineProfile,
    ).toBe(3);
  });

  test("keeps the VOIP linear-output experiment distinct from nonlinear suppression", () => {
    /*
     * The corrected physical battery shows that profile 3's complete VOIP
     * output removes far speech but ducks genuine near speech during
     * double-talk. ESP-SR exposes its adaptive linear output separately from
     * residual nonlinear suppression. Profile 4 changes only that boundary;
     * giving it a new identity prevents a later assessor from pooling its
     * windows with the superficially similar profile 3.
     */
    expect(
      parseKitAecMetrics({
        ...sample(),
        engineProfile: 4,
        nearWindowGainMultiplier: 8,
        farWindowGainMultiplier: 8,
      }).engineProfile,
    ).toBe(4);
  });

  test("keeps the high-performance full-duplex experiment distinct from FD low-cost", () => {
    /*
     * A real StackChan conversation required the nearby user to repeat
     * "bye bye" while profile 3 was rendering the assistant. The retained
     * profile-2 battery cannot answer whether full-duplex processing itself
     * helps because it selected ESP-SR's low-cost engine and suffered separate
     * transport loss. Profile 5 changes only that engine to FD_HIGH_PERF while
     * retaining the 512-sample cadence and constant processed publication.
     * Giving it a new wire identity prevents the scorer from pooling those
     * materially different experiments into a fictional passing run.
     */
    expect(
      parseKitAecMetrics({
        ...sample(),
        engineProfile: 5,
        processingFrameSamples: 512,
        nearWindowGainMultiplier: 10,
        farWindowGainMultiplier: 10,
      }).engineProfile,
    ).toBe(5);
  });

  test("keeps the high-performance full-duplex linear-output experiment distinct", () => {
    /*
     * Profile 5 made StackChan barge-in possible, but the retained aligned
     * samples show its nonlinear stage suppressing the first nearby words
     * while far speech is active. Profile 6 must have its own wire identity:
     * it keeps the same FD_HIGH_PERF adaptive filter and 512-sample cadence
     * while publishing ESP-SR's documented linear output. Pooling those runs
     * would hide whether removing only NLP fixes the double-talk regression.
     */
    expect(
      parseKitAecMetrics({
        ...sample(),
        engineProfile: 6,
        processingFrameSamples: 512,
        nearWindowGainMultiplier: 10,
        farWindowGainMultiplier: 10,
      }).engineProfile,
    ).toBe(6);
  });
});
