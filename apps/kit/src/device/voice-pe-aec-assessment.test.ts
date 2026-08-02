import { describe, expect, test } from "vitest";
import { assessVoicePeAecRun, parseKitRawCleanAecMetrics } from "./voice-pe-aec-assessment.ts";

function sample(overrides: Record<string, number | string> = {}) {
  const value = {
    schemaVersion: 3,
    topology: "raw-clean",
    sequence: 1,
    windowStartedAtMs: 1_000,
    producedAtMs: 2_000,
    sampleStride: 8,
    sampledSamples: 2_000,
    rawPeak: 12_000,
    cleanPeak: 2_000,
    rawMeanAbsolute: 1_200,
    cleanMeanAbsolute: 200,
    playbackContentSamples: 48_000,
    lifetimeCaptureFrames: 100,
    lifetimeCleanUplinkFrames: 95,
    lifetimeCleanUplinkDrops: 0,
    lifetimeCaptureFailures: 0,
    lifetimeSignalMeasurementFailures: 0,
    lastCaptureToUplinkUs: 200,
    maximumCaptureToUplinkUs: 500,
    ...overrides,
  };
  return {
    ...value,
    /*
     * Schema v2 exposed only a truncated integer mean. On HAVPE's quiet raw
     * XMOS tap, a difference of one integer changed the physical verdict by
     * several dB between otherwise clean runs. The firmware already owns the
     * exact accumulators, so schema v3 retains those sums and lets the host
     * combine windows without manufacturing precision after the fact.
     */
    rawAbsoluteSum:
      typeof overrides.rawAbsoluteSum === "number"
        ? overrides.rawAbsoluteSum
        : value.rawMeanAbsolute * value.sampledSamples,
    cleanAbsoluteSum:
      typeof overrides.cleanAbsoluteSum === "number"
        ? overrides.cleanAbsoluteSum
        : value.cleanMeanAbsolute * value.sampledSamples,
  };
}

describe("HAVPE raw/clean AEC evidence", () => {
  test("accepts a speaker-active suppressed window plus a preserved near-end window", () => {
    const farEnd = parseKitRawCleanAecMetrics(sample());
    const nearEnd = parseKitRawCleanAecMetrics(
      sample({
        sequence: 2,
        windowStartedAtMs: 2_000,
        producedAtMs: 3_000,
        rawPeak: 8_000,
        cleanPeak: 7_000,
        rawMeanAbsolute: 800,
        cleanMeanAbsolute: 720,
        playbackContentSamples: 0,
        lifetimeCaptureFrames: 150,
        lifetimeCleanUplinkFrames: 145,
      }),
    );

    const assessment = assessVoicePeAecRun([farEnd, nearEnd]);
    expect(assessment.passed).toBe(true);
    expect(assessment.farEnd.gainNormalizedEchoSuppressionDb).toBeGreaterThan(14);
    expect(assessment.nearEnd.processedToRawRatio).toBeCloseTo(0.9);
    expect(assessment.lifecycleDeltas.captureFrames).toBe(50);
  });

  test("rejects fabricated reference fields and a speaker window without suppression", () => {
    expect(() => parseKitRawCleanAecMetrics({ ...sample(), referencePeak: 123 })).toThrow(
      "referencePeak",
    );

    const assessment = assessVoicePeAecRun([
      parseKitRawCleanAecMetrics(sample({ cleanMeanAbsolute: 1_100, lifetimeCaptureFrames: 100 })),
      parseKitRawCleanAecMetrics(
        sample({
          sequence: 2,
          windowStartedAtMs: 2_000,
          producedAtMs: 3_000,
          playbackContentSamples: 0,
          lifetimeCaptureFrames: 150,
          lifetimeCleanUplinkFrames: 145,
        }),
      ),
    ]);
    expect(assessment.passed).toBe(false);
    expect(assessment.reasons.join(" ")).toContain("echo suppression");
  });

  /*
   * HAVPE deliberately exposes XMOS's original microphone beside its public
   * AEC+IC+NS+AGC output. AGC therefore makes the processed energy larger than
   * raw energy even when the local pipeline suppresses far-end speech. The
   * first physical production run measured the literal pair below: treating
   * it as equal-gain raw/AEC made healthy, audible barge-in report -36.08 dB.
   * A valid assessment has to remove the independently observed near-end gain
   * before deciding whether the far-end path was selectively attenuated.
   */
  test("does not mistake the public AGC stage for amplified far-end echo", () => {
    const nearEnd = parseKitRawCleanAecMetrics(
      sample({
        sequence: 68,
        rawPeak: 396,
        cleanPeak: 30_726,
        rawMeanAbsolute: 49,
        cleanMeanAbsolute: 6_220,
        playbackContentSamples: 0,
        lifetimeCaptureFrames: 3_000,
        lifetimeCleanUplinkFrames: 2_900,
      }),
    );
    const farEnd = parseKitRawCleanAecMetrics(
      sample({
        sequence: 83,
        rawPeak: 1_005,
        cleanPeak: 30_502,
        rawMeanAbsolute: 102,
        cleanMeanAbsolute: 6_496,
        playbackContentSamples: 16_320,
        lifetimeCaptureFrames: 3_750,
        lifetimeCleanUplinkFrames: 3_650,
      }),
    );

    const assessment = assessVoicePeAecRun([nearEnd, farEnd]);
    expect(assessment.passed).toBe(true);
    expect(assessment.farEnd.gainNormalizedEchoSuppressionDb).toBeCloseTo(5.99, 1);
    expect(assessment.nearEnd.processedToRawRatio).toBeCloseTo(126.94, 1);
    expect(assessment.farEnd.processedToRawRatio).toBeCloseTo(63.69, 1);
  });

  /*
   * Gain normalization is not permission to wave through arbitrary amplified
   * output. If the processed path transfers far-end and near-end energy by the
   * same factor, it has shown no selective echo suppression and must still
   * block physical acceptance.
   */
  test("rejects equal near-end and far-end transfer after gain calibration", () => {
    const assessment = assessVoicePeAecRun([
      parseKitRawCleanAecMetrics(
        sample({
          sequence: 1,
          rawPeak: 800,
          cleanPeak: 25_600,
          rawMeanAbsolute: 100,
          cleanMeanAbsolute: 6_400,
          playbackContentSamples: 0,
        }),
      ),
      parseKitRawCleanAecMetrics(
        sample({
          sequence: 2,
          rawPeak: 1_000,
          cleanPeak: 30_000,
          rawMeanAbsolute: 120,
          cleanMeanAbsolute: 7_680,
          playbackContentSamples: 16_000,
          lifetimeCaptureFrames: 150,
          lifetimeCleanUplinkFrames: 145,
        }),
      ),
    ]);

    expect(assessment.passed).toBe(false);
    expect(assessment.farEnd.gainNormalizedEchoSuppressionDb).toBeCloseTo(0);
  });

  /*
   * This is the exact signal shape from the first network-valid HAVPE run at
   * the AGC tap. The device later transcribed its own spoken replacement reply
   * as another user turn, so describing this as "no speaker-active window"
   * loses the most important diagnosis. Playback accounting is the authority
   * for whether the speaker was active; a low original-mic peak is evidence to
   * retain, not permission to discard the interval. The unequal-gain ratio
   * then correctly shows that the public path preserved far-end residue almost
   * as strongly as near-end speech and must fail the suppression gate.
   */
  test("measures low-level speaker residue instead of erasing an echo-triggered window", () => {
    const assessment = assessVoicePeAecRun([
      parseKitRawCleanAecMetrics(
        sample({
          sequence: 43,
          rawPeak: 224,
          cleanPeak: 24_118,
          rawMeanAbsolute: 32,
          cleanMeanAbsolute: 3_143,
          playbackContentSamples: 16_320,
        }),
      ),
      parseKitRawCleanAecMetrics(
        sample({
          sequence: 47,
          rawPeak: 396,
          cleanPeak: 30_726,
          rawMeanAbsolute: 82,
          cleanMeanAbsolute: 8_497,
          playbackContentSamples: 0,
          lifetimeCaptureFrames: 150,
          lifetimeCleanUplinkFrames: 145,
        }),
      ),
    ]);

    expect(assessment.passed).toBe(false);
    expect(assessment.farEnd.observed).toBe(true);
    expect(assessment.farEnd.gainNormalizedEchoSuppressionDb).toBeCloseTo(0.46, 1);
    expect(assessment.reasons.join(" ")).toContain("echo suppression");
  });

  /*
   * A full-duplex proof contains three acoustically different intervals:
   * ordinary replies, a deliberately settled speaker-only story, and the
   * injected barge-in. Selecting the first maximum-playback window made the
   * score depend on callback phase; pooling every playback window incorrectly
   * treats deliberate double-talk as echo. The harness knows the exact
   * speaker-only phase, so the assessor must honor those sequences and combine
   * their exact sums while leaving the overlapping barge-in window out.
   */
  test("scores the explicitly marked speaker-only phase instead of double-talk", () => {
    const nearEnd = parseKitRawCleanAecMetrics(
      sample({
        sequence: 34,
        rawPeak: 362,
        /*
         * The 2026-08-02 physical fixed-gain run produced an original-mic
         * peak above the live-speech threshold while NS correctly reduced the
         * public-channel peak below 500. Requiring the processed signal to be
         * louder than the source circularly rejects the suppression pipeline
         * we are trying to measure. The raw XMOS tap is the authority for
         * whether near-end sound physically reached the microphones.
         */
        cleanPeak: 474,
        rawMeanAbsolute: 70,
        cleanMeanAbsolute: 64,
        playbackContentSamples: 0,
      }),
    );
    const settling = parseKitRawCleanAecMetrics(
      sample({
        sequence: 50,
        rawPeak: 126,
        cleanPeak: 50,
        rawMeanAbsolute: 10,
        cleanMeanAbsolute: 2,
        playbackContentSamples: 16_320,
      }),
    );
    const settled = parseKitRawCleanAecMetrics(
      sample({
        sequence: 51,
        rawPeak: 279,
        cleanPeak: 19,
        rawMeanAbsolute: 22,
        cleanMeanAbsolute: 1,
        playbackContentSamples: 16_320,
      }),
    );
    const deliberateDoubleTalk = parseKitRawCleanAecMetrics(
      sample({
        sequence: 52,
        rawPeak: 347,
        cleanPeak: 377,
        rawMeanAbsolute: 51,
        cleanMeanAbsolute: 51,
        playbackContentSamples: 16_320,
        lifetimeCaptureFrames: 150,
        lifetimeCleanUplinkFrames: 145,
      }),
    );

    const assessment = assessVoicePeAecRun([nearEnd, settling, settled, deliberateDoubleTalk], {
      farEndSequences: [50, 51],
      nearEndSequences: [34],
    });

    expect(assessment.passed).toBe(true);
    expect(assessment.farEnd.sequences).toEqual([50, 51]);
    expect(assessment.farEnd.gainNormalizedEchoSuppressionDb).toBeGreaterThan(15);
  });

  /*
   * AEC evidence is useful only if the realtime capture path stayed healthy.
   * This regression keeps a quiet-looking clean channel from hiding a dropped
   * frame or a failed signal measurement during exactly the acceptance run.
   */
  test("fails on capture loss, measurement failure, or excessive uplink delay", () => {
    const assessment = assessVoicePeAecRun([
      parseKitRawCleanAecMetrics(sample()),
      parseKitRawCleanAecMetrics(
        sample({
          sequence: 2,
          windowStartedAtMs: 2_000,
          producedAtMs: 3_000,
          playbackContentSamples: 0,
          lifetimeCaptureFrames: 150,
          lifetimeCleanUplinkFrames: 145,
          lifetimeCleanUplinkDrops: 1,
          lifetimeCaptureFailures: 1,
          lifetimeSignalMeasurementFailures: 1,
          maximumCaptureToUplinkUs: 100_001,
        }),
      ),
    ]);
    expect(assessment.passed).toBe(false);
    expect(assessment.lifecycleDeltas.cleanUplinkDrops).toBe(1);
    expect(assessment.lifecycleDeltas.captureFailures).toBe(1);
    expect(assessment.lifecycleDeltas.signalMeasurementFailures).toBe(1);
    expect(assessment.timing.maximumObservedCaptureToUplinkUs).toBe(100_001);
  });
});
