import { z } from "zod";
import type { KitAecMetrics } from "./kit-device-contract.ts";

const nonnegativeSafeInteger = z.number().int().nonnegative().safe();
const KitAecMetricsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sequence: nonnegativeSafeInteger,
  windowStartedAtMs: nonnegativeSafeInteger,
  producedAtMs: nonnegativeSafeInteger,
  sampleStride: z.number().int().positive().safe(),
  sampledSamples: nonnegativeSafeInteger,
  nearPeak: nonnegativeSafeInteger.max(32_768),
  referencePeak: nonnegativeSafeInteger.max(32_768),
  cleanPeak: nonnegativeSafeInteger.max(32_768),
  nearMeanAbsolute: nonnegativeSafeInteger.max(32_768),
  referenceMeanAbsolute: nonnegativeSafeInteger.max(32_768),
  cleanMeanAbsolute: nonnegativeSafeInteger.max(32_768),
  lifetimeFramesProcessed: nonnegativeSafeInteger,
  lifetimeRecreates: nonnegativeSafeInteger,
  lifetimeRecreateFailures: nonnegativeSafeInteger,
  lastLinearUs: nonnegativeSafeInteger,
  maximumLinearUs: nonnegativeSafeInteger,
  lastNlpUs: nonnegativeSafeInteger,
  maximumNlpUs: nonnegativeSafeInteger,
  lastCaptureToUplinkUs: nonnegativeSafeInteger,
  maximumCaptureToUplinkUs: nonnegativeSafeInteger,
  lifetimeCaptureReserveDroppedChunks: nonnegativeSafeInteger,
  lifetimeCaptureBridgeErrors: nonnegativeSafeInteger,
  lifetimeSignalMeasurementFailures: nonnegativeSafeInteger,
});

export function parseKitAecMetrics(value: unknown): KitAecMetrics {
  return KitAecMetricsSchema.parse(value);
}

export interface StackChanAecAssessment {
  passed: boolean;
  reasons: string[];
  windows: {
    received: number;
    unique: number;
    firstSequence: number | null;
    lastSequence: number | null;
  };
  farEnd: {
    observed: boolean;
    sequence: number | null;
    echoSuppressionDb: number | null;
    nearMeanAbsolute: number | null;
    cleanMeanAbsolute: number | null;
    referencePeak: number | null;
  };
  nearEnd: {
    observed: boolean;
    sequence: number | null;
    cleanToNearRatio: number | null;
    nearMeanAbsolute: number | null;
    cleanMeanAbsolute: number | null;
    referencePeak: number | null;
  };
  lifecycleDeltas: {
    framesProcessed: number;
    recreates: number;
    recreateFailures: number;
    captureReserveDroppedChunks: number;
    captureBridgeErrors: number;
    signalMeasurementFailures: number;
  };
  timing: {
    maximumObservedCaptureToUplinkUs: number;
    maximumObservedProcessingUs: number;
  };
}

const farEndMinimumReferencePeak = 500;
const farEndMinimumNearPeak = 1_000;
const minimumEchoSuppressionDb = 3;
const nearEndMaximumReferencePeak = 100;
const nearEndMinimumNearPeak = 500;
const minimumNearEndPreservationRatio = 0.5;
const maximumNearEndPreservationRatio = 2;
const maximumCaptureToUplinkUs = 100_000;
const maximumAecProcessingUs = 30_000;

/**
 * Turns aligned device windows into a falsifiable AEC claim.
 *
 * A loud output heard by a room microphone proves the speaker, but says
 * nothing about what StackChan sends back to Grok. Conversely, a quiet clean
 * channel could be a broken microphone. The proof therefore needs both modes:
 * a reference-active far-end window in which clean energy falls materially,
 * and a reference-quiet near-end window in which clean energy remains close to
 * the microphone input. These are deliberately coarse gates over the device's
 * once-per-second diagnostic sampler; they do not run signal processing in the
 * harness or add work to the realtime firmware path.
 *
 * Cap'n Web may deliver the latest completed window more than once when its
 * one-second callback and DSP window clocks straddle. Deduplicating by device
 * sequence prevents repeated polling from manufacturing independent evidence.
 */
export function assessStackChanAecRun(samples: readonly KitAecMetrics[]): StackChanAecAssessment {
  const bySequence = new Map<number, KitAecMetrics>();
  for (const sample of samples) bySequence.set(sample.sequence, sample);
  const windows = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
  const first = windows[0];
  const last = windows.at(-1);
  const reasons: string[] = [];

  const farEnd = windows
    .filter(
      (sample) =>
        sample.referencePeak >= farEndMinimumReferencePeak &&
        sample.nearPeak >= farEndMinimumNearPeak &&
        sample.nearMeanAbsolute > 0,
    )
    .sort((left, right) => right.referencePeak - left.referencePeak)[0];
  const echoSuppressionDb = farEnd
    ? 20 * Math.log10(farEnd.nearMeanAbsolute / Math.max(1, farEnd.cleanMeanAbsolute))
    : null;
  if (!farEnd) reasons.push("No aligned far-end speaker-reference window was observed.");
  else if (echoSuppressionDb === null || echoSuppressionDb < minimumEchoSuppressionDb) {
    reasons.push(
      `Far-end echo suppression was ${echoSuppressionDb?.toFixed(2) ?? "unmeasured"} dB; ` +
        `expected at least ${minimumEchoSuppressionDb} dB.`,
    );
  }

  const nearEnd = windows
    .filter(
      (sample) =>
        sample.referencePeak <= nearEndMaximumReferencePeak &&
        sample.nearPeak >= nearEndMinimumNearPeak &&
        sample.nearMeanAbsolute > 0,
    )
    .sort((left, right) => right.nearMeanAbsolute - left.nearMeanAbsolute)[0];
  const cleanToNearRatio = nearEnd ? nearEnd.cleanMeanAbsolute / nearEnd.nearMeanAbsolute : null;
  if (!nearEnd) reasons.push("No aligned near-end speech window was observed.");
  else if (
    cleanToNearRatio === null ||
    cleanToNearRatio < minimumNearEndPreservationRatio ||
    cleanToNearRatio > maximumNearEndPreservationRatio
  ) {
    reasons.push(
      `Near-end clean/input energy ratio was ${cleanToNearRatio?.toFixed(3) ?? "unmeasured"}; ` +
        `expected ${minimumNearEndPreservationRatio} through ${maximumNearEndPreservationRatio}.`,
    );
  }

  const delta = (field: keyof KitAecMetrics) => {
    if (!first || !last) return 0;
    const start = first[field];
    const end = last[field];
    return typeof start === "number" && typeof end === "number" ? Math.max(0, end - start) : 0;
  };
  const lifecycleDeltas = {
    framesProcessed: delta("lifetimeFramesProcessed"),
    recreates: delta("lifetimeRecreates"),
    recreateFailures: delta("lifetimeRecreateFailures"),
    captureReserveDroppedChunks: delta("lifetimeCaptureReserveDroppedChunks"),
    captureBridgeErrors: delta("lifetimeCaptureBridgeErrors"),
    signalMeasurementFailures: delta("lifetimeSignalMeasurementFailures"),
  };
  if (lifecycleDeltas.framesProcessed === 0)
    reasons.push("AEC processed no frames during the run.");
  if (lifecycleDeltas.recreates > 0) {
    reasons.push(`AEC recreated ${lifecycleDeltas.recreates} times during the run.`);
  }
  if (lifecycleDeltas.recreateFailures > 0) {
    reasons.push(`AEC recreation failed ${lifecycleDeltas.recreateFailures} times during the run.`);
  }
  if (lifecycleDeltas.captureReserveDroppedChunks > 0) {
    reasons.push(
      `AEC capture reserve dropped ${lifecycleDeltas.captureReserveDroppedChunks} chunk during the run.`,
    );
  }
  if (lifecycleDeltas.captureBridgeErrors > 0) {
    reasons.push(`AEC capture bridge reported ${lifecycleDeltas.captureBridgeErrors} errors.`);
  }
  if (lifecycleDeltas.signalMeasurementFailures > 0) {
    reasons.push(
      `AEC signal measurement reported ${lifecycleDeltas.signalMeasurementFailures} failures.`,
    );
  }

  const timing = {
    maximumObservedCaptureToUplinkUs: Math.max(
      0,
      ...windows.map((sample) => sample.lastCaptureToUplinkUs),
    ),
    maximumObservedProcessingUs: Math.max(
      0,
      ...windows.map((sample) => sample.lastLinearUs + sample.lastNlpUs),
    ),
  };
  if (timing.maximumObservedCaptureToUplinkUs > maximumCaptureToUplinkUs) {
    reasons.push(
      `Observed capture-to-uplink latency reached ${timing.maximumObservedCaptureToUplinkUs} us; ` +
        `expected at most ${maximumCaptureToUplinkUs} us.`,
    );
  }
  if (timing.maximumObservedProcessingUs > maximumAecProcessingUs) {
    reasons.push(
      `Observed AEC processing reached ${timing.maximumObservedProcessingUs} us; ` +
        `expected at most ${maximumAecProcessingUs} us.`,
    );
  }

  return {
    passed: reasons.length === 0,
    reasons,
    windows: {
      received: samples.length,
      unique: windows.length,
      firstSequence: first?.sequence ?? null,
      lastSequence: last?.sequence ?? null,
    },
    farEnd: {
      observed: farEnd !== undefined,
      sequence: farEnd?.sequence ?? null,
      echoSuppressionDb,
      nearMeanAbsolute: farEnd?.nearMeanAbsolute ?? null,
      cleanMeanAbsolute: farEnd?.cleanMeanAbsolute ?? null,
      referencePeak: farEnd?.referencePeak ?? null,
    },
    nearEnd: {
      observed: nearEnd !== undefined,
      sequence: nearEnd?.sequence ?? null,
      cleanToNearRatio,
      nearMeanAbsolute: nearEnd?.nearMeanAbsolute ?? null,
      cleanMeanAbsolute: nearEnd?.cleanMeanAbsolute ?? null,
      referencePeak: nearEnd?.referencePeak ?? null,
    },
    lifecycleDeltas,
    timing,
  };
}
