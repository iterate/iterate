import { describe, expect, test } from "vitest";
import type { KitAecMetrics } from "./kit-device-contract.ts";
import { assessStackChanAecRun, parseKitAecMetrics } from "./stackchan-aec-assessment.ts";

function sample(overrides: Partial<KitAecMetrics> = {}): KitAecMetrics {
  return {
    schemaVersion: 1,
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
    cleanMeanAbsolute: 200,
    lifetimeFramesProcessed: 100,
    lifetimeRecreates: 0,
    lifetimeRecreateFailures: 0,
    lastLinearUs: 6_000,
    maximumLinearUs: 8_000,
    lastNlpUs: 6_000,
    maximumNlpUs: 8_000,
    lastCaptureToUplinkUs: 20_000,
    maximumCaptureToUplinkUs: 40_000,
    lifetimeCaptureReserveDroppedChunks: 0,
    lifetimeCaptureBridgeErrors: 0,
    lifetimeSignalMeasurementFailures: 0,
    ...overrides,
  };
}

describe("StackChan AEC evidence", () => {
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
        cleanMeanAbsolute: 240,
        lifetimeFramesProcessed: 131,
      }),
    ]);

    expect(assessment.passed).toBe(true);
    expect(assessment.farEnd.echoSuppressionDb).toBeCloseTo(9.54, 1);
    expect(assessment.nearEnd.cleanToNearRatio).toBeCloseTo(0.96, 2);
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
        cleanMeanAbsolute: 240,
        lifetimeFramesProcessed: 131,
        lifetimeCaptureReserveDroppedChunks: 1,
      }),
    ]);

    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain("AEC capture reserve dropped 1 chunk during the run.");
  });

  test("rejects malformed callback payloads before they become physical evidence", () => {
    expect(() => parseKitAecMetrics({ ...sample(), nearPeak: -1 })).toThrow("nearPeak");
  });
});
