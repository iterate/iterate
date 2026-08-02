import { z } from "zod";
import type { KitRawCleanAecMetrics } from "./kit-device-contract.ts";

const nonnegativeSafeInteger = z.number().int().nonnegative().safe();
const KitRawCleanAecMetricsSchema = z.strictObject({
  schemaVersion: z.literal(3),
  topology: z.literal("raw-clean"),
  sequence: nonnegativeSafeInteger,
  windowStartedAtMs: nonnegativeSafeInteger,
  producedAtMs: nonnegativeSafeInteger,
  sampleStride: z.number().int().positive().safe(),
  sampledSamples: nonnegativeSafeInteger,
  rawPeak: nonnegativeSafeInteger.max(32_768),
  cleanPeak: nonnegativeSafeInteger.max(32_768),
  rawMeanAbsolute: nonnegativeSafeInteger.max(32_768),
  cleanMeanAbsolute: nonnegativeSafeInteger.max(32_768),
  rawAbsoluteSum: nonnegativeSafeInteger,
  cleanAbsoluteSum: nonnegativeSafeInteger,
  playbackContentSamples: nonnegativeSafeInteger,
  lifetimeCaptureFrames: nonnegativeSafeInteger,
  lifetimeCleanUplinkFrames: nonnegativeSafeInteger,
  lifetimeCleanUplinkDrops: nonnegativeSafeInteger,
  lifetimeCaptureFailures: nonnegativeSafeInteger,
  lifetimeSignalMeasurementFailures: nonnegativeSafeInteger,
  lastCaptureToUplinkUs: nonnegativeSafeInteger,
  maximumCaptureToUplinkUs: nonnegativeSafeInteger,
});

export function parseKitRawCleanAecMetrics(value: unknown): KitRawCleanAecMetrics {
  return KitRawCleanAecMetricsSchema.parse(value);
}

export interface VoicePeAecAssessment {
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
    sequences: number[];
    gainNormalizedEchoSuppressionDb: number | null;
    processedToRawRatio: number | null;
    rawMeanAbsolute: number | null;
    processedMeanAbsolute: number | null;
    playbackContentSamples: number | null;
  };
  nearEnd: {
    observed: boolean;
    sequence: number | null;
    sequences: number[];
    processedToRawRatio: number | null;
    rawMeanAbsolute: number | null;
    processedMeanAbsolute: number | null;
  };
  lifecycleDeltas: {
    captureFrames: number;
    cleanUplinkFrames: number;
    cleanUplinkDrops: number;
    captureFailures: number;
    signalMeasurementFailures: number;
  };
  timing: { maximumObservedCaptureToUplinkUs: number };
}

export interface VoicePeAecPhaseSelection {
  /** Sequences captured after far-end playback settled and before barge-in. */
  farEndSequences?: readonly number[];
  /** Sequences captured while the harness spoke and device playback was quiet. */
  nearEndSequences?: readonly number[];
}

const farEndMinimumPlaybackContentSamples = 8_000;
const minimumGainNormalizedEchoSuppressionDb = 3;
const nearEndMinimumRawPeak = 300;
const maximumCaptureToUplinkUs = 100_000;

/**
 * Evaluates only measurements the XMOS board can truthfully expose.
 *
 * XMOS channel zero is the public processed signal, while channel one is an
 * original microphone. They are simultaneous but intentionally do not have
 * equal gain: directly dividing raw by processed can report downstream gain as
 * negative AEC. A playback-quiet live-microphone window therefore measures the
 * combined channel/DSP transfer, and the speaker-active window is compared
 * against that baseline. The resulting dB value answers the useful, truthful
 * question: how much more does the local pipeline preserve near-end speech than
 * far-end speaker return? Hardware stage readback independently proves that
 * AEC is in that pipeline; this aggregate cannot isolate AEC from later stages.
 *
 * Playback accounting, not raw-mic amplitude, decides whether a far-end
 * interval exists. AEC's purpose is precisely to make speaker residue small;
 * discarding a low-raw-energy window hid the physical run in which downstream
 * gain made that residue retrigger VAD. Near-end calibration still requires a
 * substantial live-microphone peak, and Grok's retained transcript remains the
 * stronger speech-preservation oracle. Cumulative failure deltas also make a
 * clean-looking window invalid if capture or publication dropped work under it.
 */
export function assessVoicePeAecRun(
  samples: readonly KitRawCleanAecMetrics[],
  phaseSelection?: VoicePeAecPhaseSelection,
): VoicePeAecAssessment {
  const bySequence = new Map<number, KitRawCleanAecMetrics>();
  for (const sample of samples) bySequence.set(sample.sequence, sample);
  const windows = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
  const first = windows[0];
  const last = windows.at(-1);
  const reasons: string[] = [];

  const farEndSequenceSet = phaseSelection?.farEndSequences
    ? new Set(phaseSelection.farEndSequences)
    : undefined;
  const nearEndSequenceSet = phaseSelection?.nearEndSequences
    ? new Set(phaseSelection.nearEndSequences)
    : undefined;
  const farEndWindows = windows.filter(
    (sample) =>
      (!farEndSequenceSet || farEndSequenceSet.has(sample.sequence)) &&
      sample.playbackContentSamples >= farEndMinimumPlaybackContentSamples &&
      sample.rawAbsoluteSum > 0,
  );
  const nearEndWindows = windows.filter(
    (sample) =>
      (!nearEndSequenceSet || nearEndSequenceSet.has(sample.sequence)) &&
      sample.playbackContentSamples === 0 &&
      /*
       * The simultaneous original-microphone tap tells us whether near-end
       * sound reached the physical array. Requiring a minimum processed peak
       * as well made selection depend on the very NS/AEC attenuation under
       * test: a clean physical prompt could disappear merely because the
       * public channel reduced it below an arbitrary second threshold. Exact
       * input-transcript matching in the production harness independently
       * proves that the processed signal remained intelligible.
       */
      sample.rawPeak >= nearEndMinimumRawPeak &&
      sample.rawAbsoluteSum > 0,
  );

  /*
   * These are equal-duration, aligned capture windows in normal operation,
   * but summing the exact numerators is still preferable to averaging ratios:
   * it remains correctly sample-weighted if a boundary window is shorter and
   * it does not amplify the one-count rounding error that made two physical
   * runs differ by 2.6 dB under schema v2. Phase selection is optional for
   * unit-level callers; the physical harness supplies it because it alone
   * knows when deliberate near-end barge-in began.
   */
  const nearEndRawAbsoluteSum = nearEndWindows.reduce(
    (total, sample) => total + sample.rawAbsoluteSum,
    0,
  );
  const nearEndCleanAbsoluteSum = nearEndWindows.reduce(
    (total, sample) => total + sample.cleanAbsoluteSum,
    0,
  );
  const farEndRawAbsoluteSum = farEndWindows.reduce(
    (total, sample) => total + sample.rawAbsoluteSum,
    0,
  );
  const farEndCleanAbsoluteSum = farEndWindows.reduce(
    (total, sample) => total + sample.cleanAbsoluteSum,
    0,
  );
  const nearEndSampleCount = nearEndWindows.reduce(
    (total, sample) => total + sample.sampledSamples,
    0,
  );
  const farEndSampleCount = farEndWindows.reduce(
    (total, sample) => total + sample.sampledSamples,
    0,
  );
  const nearEndProcessedToRawRatio =
    nearEndRawAbsoluteSum > 0 ? nearEndCleanAbsoluteSum / nearEndRawAbsoluteSum : null;
  if (nearEndWindows.length === 0) {
    reasons.push("No playback-quiet live clean-microphone window was observed.");
  }

  const farEndProcessedToRawRatio =
    farEndRawAbsoluteSum > 0 ? farEndCleanAbsoluteSum / farEndRawAbsoluteSum : null;
  const gainNormalizedEchoSuppressionDb =
    farEndProcessedToRawRatio !== null &&
    farEndProcessedToRawRatio > 0 &&
    nearEndProcessedToRawRatio !== null &&
    nearEndProcessedToRawRatio > 0
      ? 20 * Math.log10(nearEndProcessedToRawRatio / farEndProcessedToRawRatio)
      : null;
  if (farEndWindows.length === 0) {
    reasons.push("No speaker-active raw/processed AEC window was observed.");
  } else if (
    gainNormalizedEchoSuppressionDb === null ||
    gainNormalizedEchoSuppressionDb < minimumGainNormalizedEchoSuppressionDb
  ) {
    reasons.push(
      `Gain-normalized local echo suppression was ` +
        `${gainNormalizedEchoSuppressionDb?.toFixed(2) ?? "unmeasured"} dB; expected at least ` +
        `${minimumGainNormalizedEchoSuppressionDb} dB.`,
    );
  }

  const delta = (field: keyof KitRawCleanAecMetrics) => {
    if (!first || !last) return 0;
    const start = first[field];
    const end = last[field];
    return typeof start === "number" && typeof end === "number" ? Math.max(0, end - start) : 0;
  };
  const lifecycleDeltas = {
    captureFrames: delta("lifetimeCaptureFrames"),
    cleanUplinkFrames: delta("lifetimeCleanUplinkFrames"),
    cleanUplinkDrops: delta("lifetimeCleanUplinkDrops"),
    captureFailures: delta("lifetimeCaptureFailures"),
    signalMeasurementFailures: delta("lifetimeSignalMeasurementFailures"),
  };
  if (lifecycleDeltas.captureFrames === 0) reasons.push("AEC capture processed no frames.");
  if (lifecycleDeltas.cleanUplinkFrames === 0)
    reasons.push("AEC clean output published no frames.");
  if (lifecycleDeltas.cleanUplinkDrops > 0) {
    reasons.push(`Clean uplink dropped ${lifecycleDeltas.cleanUplinkDrops} frame(s).`);
  }
  if (lifecycleDeltas.captureFailures > 0) {
    reasons.push(`Capture reported ${lifecycleDeltas.captureFailures} failure(s).`);
  }
  if (lifecycleDeltas.signalMeasurementFailures > 0) {
    reasons.push(
      `AEC signal measurement reported ${lifecycleDeltas.signalMeasurementFailures} failure(s).`,
    );
  }

  const timing = {
    maximumObservedCaptureToUplinkUs: Math.max(
      0,
      ...windows.map((sample) => sample.maximumCaptureToUplinkUs),
    ),
  };
  if (timing.maximumObservedCaptureToUplinkUs > maximumCaptureToUplinkUs) {
    reasons.push(
      `Observed capture-to-uplink latency reached ${timing.maximumObservedCaptureToUplinkUs} us; ` +
        `expected at most ${maximumCaptureToUplinkUs} us.`,
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
      observed: farEndWindows.length > 0,
      sequence: farEndWindows[0]?.sequence ?? null,
      sequences: farEndWindows.map((sample) => sample.sequence),
      gainNormalizedEchoSuppressionDb,
      processedToRawRatio: farEndProcessedToRawRatio,
      rawMeanAbsolute: farEndSampleCount > 0 ? farEndRawAbsoluteSum / farEndSampleCount : null,
      processedMeanAbsolute:
        farEndSampleCount > 0 ? farEndCleanAbsoluteSum / farEndSampleCount : null,
      playbackContentSamples:
        farEndWindows.reduce((total, sample) => total + sample.playbackContentSamples, 0) || null,
    },
    nearEnd: {
      observed: nearEndWindows.length > 0,
      sequence: nearEndWindows[0]?.sequence ?? null,
      sequences: nearEndWindows.map((sample) => sample.sequence),
      processedToRawRatio: nearEndProcessedToRawRatio,
      rawMeanAbsolute: nearEndSampleCount > 0 ? nearEndRawAbsoluteSum / nearEndSampleCount : null,
      processedMeanAbsolute:
        nearEndSampleCount > 0 ? nearEndCleanAbsoluteSum / nearEndSampleCount : null,
    },
    lifecycleDeltas,
    timing,
  };
}
