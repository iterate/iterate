import { z } from "zod";
import type { KitAecMetrics } from "./kit-device-contract.ts";

const nonnegativeSafeInteger = z.number().int().nonnegative().safe();
const positiveSafeInteger = z.number().int().positive().safe();
const KitAecMetricsSchema = z.strictObject({
  schemaVersion: z.literal(11),
  sequence: nonnegativeSafeInteger,
  windowStartedAtMs: nonnegativeSafeInteger,
  producedAtMs: nonnegativeSafeInteger,
  sampleStride: z.number().int().positive().safe(),
  sampledSamples: nonnegativeSafeInteger,
  nearPeak: nonnegativeSafeInteger.max(32_767),
  referencePeak: nonnegativeSafeInteger.max(32_767),
  cleanPeak: nonnegativeSafeInteger.max(32_767),
  nearMeanAbsolute: nonnegativeSafeInteger.max(32_767),
  referenceMeanAbsolute: nonnegativeSafeInteger.max(32_767),
  cleanMeanAbsolute: nonnegativeSafeInteger.max(32_767),
  engineProfile: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
  ]),
  processingFrameSamples: z.union([z.literal(256), z.literal(512)]),
  nearWindowGainMultiplier: positiveSafeInteger,
  farWindowGainMultiplier: positiveSafeInteger,
  speakerVolumePercent: nonnegativeSafeInteger.max(100),
  microphoneGainDb: nonnegativeSafeInteger.max(37),
  referenceGainDb: nonnegativeSafeInteger.max(37),
  lifetimeFramesProcessed: nonnegativeSafeInteger,
  lifetimeRecreates: nonnegativeSafeInteger,
  lifetimeRecreateFailures: nonnegativeSafeInteger,
  lastProcessUs: nonnegativeSafeInteger,
  maximumProcessUs: nonnegativeSafeInteger,
  lastCaptureToUplinkUs: nonnegativeSafeInteger,
  maximumCaptureToUplinkUs: nonnegativeSafeInteger,
  lifetimeCaptureReserveDroppedChunks: nonnegativeSafeInteger,
  lifetimeCaptureChunksWithPlaybackContent: nonnegativeSafeInteger,
  lifetimeCaptureChunksWithoutPlaybackContent: nonnegativeSafeInteger,
  lifetimeCaptureBridgeErrors: nonnegativeSafeInteger,
  lifetimeSignalMeasurementFailures: nonnegativeSafeInteger,
  lifetimeReferenceScaleClippedSamples: nonnegativeSafeInteger,
  lifetimeNearHighPassClippedSamples: nonnegativeSafeInteger,
  lifetimeUplinkGainClippedSamples: nonnegativeSafeInteger,
  lifetimePlaybackContentSamples: nonnegativeSafeInteger,
  lifetimePlaybackResets: nonnegativeSafeInteger,
  lifetimePlaybackFramesDiscardedByReset: nonnegativeSafeInteger,
  lifetimePlaybackWriteFailures: nonnegativeSafeInteger,
  lifetimePlaybackQueueOverflows: nonnegativeSafeInteger,
  lifetimePlaybackPolicyErrors: nonnegativeSafeInteger,
  lifetimePlaybackResetFailures: nonnegativeSafeInteger,
  lifetimePlaybackObservationFailures: nonnegativeSafeInteger,
  lifetimePlaybackUnderrunIncidents: nonnegativeSafeInteger,
  lifetimePlaybackUnderrunSilenceSamples: nonnegativeSafeInteger,
  lifetimePlaybackStaleFramesDiscarded: nonnegativeSafeInteger,
  lastPlaybackWriteUs: nonnegativeSafeInteger,
  maximumPlaybackWriteUs: nonnegativeSafeInteger,
  lastReceiveToRenderMs: nonnegativeSafeInteger,
  maximumReceiveToRenderMs: nonnegativeSafeInteger,
});

export function parseKitAecMetrics(value: unknown): KitAecMetrics {
  return KitAecMetricsSchema.parse(value);
}

export interface StackChanAecAssessmentOptions {
  /**
   * Physical resets deliberately requested by this exact harness interval.
   * The assessor still rejects any deficit or surplus; this is classification,
   * not permission to ignore an unstable playback owner.
   */
  expectedPlaybackResets?: number;
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
    captureChunksWithPlaybackContent: number;
    captureChunksWithoutPlaybackContent: number;
    captureBridgeErrors: number;
    signalMeasurementFailures: number;
    referenceScaleClippedSamples: number;
    nearHighPassClippedSamples: number;
    uplinkGainClippedSamples: number;
    playbackContentSamples: number;
    playbackResets: number;
    playbackFramesDiscardedByReset: number;
    playbackWriteFailures: number;
    playbackQueueOverflows: number;
    playbackPolicyErrors: number;
    playbackResetFailures: number;
    playbackObservationFailures: number;
    playbackUnderrunIncidents: number;
    playbackUnderrunSilenceSamples: number;
    playbackStaleFramesDiscarded: number;
  };
  timing: {
    maximumObservedCaptureToUplinkUs: number;
    maximumObservedProcessingUs: number;
    maximumObservedPlaybackWriteUs: number;
    maximumObservedReceiveToRenderMs: number;
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
const aecSampleRateHz = 16_000;

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
export function assessStackChanAecRun(
  samples: readonly KitAecMetrics[],
  options: StackChanAecAssessmentOptions = {},
): StackChanAecAssessment {
  const bySequence = new Map<number, KitAecMetrics>();
  for (const sample of samples) bySequence.set(sample.sequence, sample);
  const windows = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
  const first = windows[0];
  const last = windows.at(-1);
  const reasons: string[] = [];
  const profileShapes = new Set(
    windows.map(
      (sample) =>
        `${sample.engineProfile}:${sample.processingFrameSamples}:` +
        `${sample.nearWindowGainMultiplier}:${sample.farWindowGainMultiplier}:` +
        `${sample.speakerVolumePercent}:${sample.microphoneGainDb}:${sample.referenceGainDb}`,
    ),
  );
  if (profileShapes.size > 1) {
    /*
     * A reconnect or accidental mixed firmware run must not combine the best
     * near-only window from one topology with the best far-only window from
     * another. That would manufacture an A/B winner no physical generation
     * ever achieved.
     */
    reasons.push(
      "AEC engine/frame/gain/analogue operating point changed during the assessed interval.",
    );
  }

  const farEnd = windows
    .filter(
      (sample) =>
        sample.referencePeak >= farEndMinimumReferencePeak &&
        sample.nearPeak >= farEndMinimumNearPeak &&
        sample.nearMeanAbsolute > 0,
    )
    .sort((left, right) => right.referencePeak - left.referencePeak)[0];
  const echoSuppressionDb = farEnd
    ? farEnd.cleanMeanAbsolute === 0
      ? Number.POSITIVE_INFINITY
      : 20 *
        Math.log10(
          farEnd.nearMeanAbsolute / (farEnd.cleanMeanAbsolute / farEnd.farWindowGainMultiplier),
        )
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
  const cleanToNearRatio = nearEnd
    ? nearEnd.cleanMeanAbsolute / nearEnd.nearWindowGainMultiplier / nearEnd.nearMeanAbsolute
    : null;
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
    captureChunksWithPlaybackContent: delta("lifetimeCaptureChunksWithPlaybackContent"),
    captureChunksWithoutPlaybackContent: delta("lifetimeCaptureChunksWithoutPlaybackContent"),
    captureBridgeErrors: delta("lifetimeCaptureBridgeErrors"),
    signalMeasurementFailures: delta("lifetimeSignalMeasurementFailures"),
    referenceScaleClippedSamples: delta("lifetimeReferenceScaleClippedSamples"),
    nearHighPassClippedSamples: delta("lifetimeNearHighPassClippedSamples"),
    uplinkGainClippedSamples: delta("lifetimeUplinkGainClippedSamples"),
    playbackContentSamples: delta("lifetimePlaybackContentSamples"),
    playbackResets: delta("lifetimePlaybackResets"),
    playbackFramesDiscardedByReset: delta("lifetimePlaybackFramesDiscardedByReset"),
    playbackWriteFailures: delta("lifetimePlaybackWriteFailures"),
    playbackQueueOverflows: delta("lifetimePlaybackQueueOverflows"),
    playbackPolicyErrors: delta("lifetimePlaybackPolicyErrors"),
    playbackResetFailures: delta("lifetimePlaybackResetFailures"),
    playbackObservationFailures: delta("lifetimePlaybackObservationFailures"),
    playbackUnderrunIncidents: delta("lifetimePlaybackUnderrunIncidents"),
    playbackUnderrunSilenceSamples: delta("lifetimePlaybackUnderrunSilenceSamples"),
    playbackStaleFramesDiscarded: delta("lifetimePlaybackStaleFramesDiscarded"),
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
  if (
    lifecycleDeltas.captureChunksWithPlaybackContent +
      lifecycleDeltas.captureChunksWithoutPlaybackContent ===
    0
  ) {
    reasons.push("AEC consumed no microphone capture chunks during the run.");
  }
  if (lifecycleDeltas.captureBridgeErrors > 0) {
    reasons.push(`AEC capture bridge reported ${lifecycleDeltas.captureBridgeErrors} errors.`);
  }
  if (lifecycleDeltas.signalMeasurementFailures > 0) {
    reasons.push(
      `AEC signal measurement reported ${lifecycleDeltas.signalMeasurementFailures} failures.`,
    );
  }
  for (const [count, boundary] of [
    [lifecycleDeltas.referenceScaleClippedSamples, "electrical AEC reference scaler"],
    [lifecycleDeltas.nearHighPassClippedSamples, "near-microphone high-pass"],
    [lifecycleDeltas.uplinkGainClippedSamples, "selected uplink gain stage"],
  ] as const) {
    if (count > 0) {
      reasons.push(`${boundary} clipped ${count} sample${count === 1 ? "" : "s"} during the run.`);
    }
  }
  const expectedPlaybackResets = options.expectedPlaybackResets ?? 0;
  if (lifecycleDeltas.playbackResets !== expectedPlaybackResets) {
    reasons.push(
      `Playback reset ${lifecycleDeltas.playbackResets} ${lifecycleDeltas.playbackResets === 1 ? "time" : "times"} during the run; ` +
        `expected exactly ${expectedPlaybackResets} harness-requested ${expectedPlaybackResets === 1 ? "reset" : "resets"}.`,
    );
  }
  if (
    lifecycleDeltas.playbackFramesDiscardedByReset > 0 &&
    lifecycleDeltas.playbackResets !== expectedPlaybackResets
  ) {
    reasons.push(
      `Playback discarded ${lifecycleDeltas.playbackFramesDiscardedByReset} downlink frames during reset.`,
    );
  }
  if (lifecycleDeltas.playbackUnderrunIncidents > 0) {
    reasons.push(
      `Playback inserted ${lifecycleDeltas.playbackUnderrunIncidents} underrun refill edge(s) ` +
        `(${lifecycleDeltas.playbackUnderrunSilenceSamples} silence samples) during the run.`,
    );
  }
  if (lifecycleDeltas.playbackStaleFramesDiscarded > 0) {
    reasons.push(
      `Playback discarded ${lifecycleDeltas.playbackStaleFramesDiscarded} stale downlink frame(s) during the run.`,
    );
  }
  for (const [count, label] of [
    [lifecycleDeltas.playbackWriteFailures, "write failures"],
    [lifecycleDeltas.playbackQueueOverflows, "queue overflows"],
    [lifecycleDeltas.playbackPolicyErrors, "policy errors"],
    [lifecycleDeltas.playbackResetFailures, "reset failures"],
    [lifecycleDeltas.playbackObservationFailures, "observation failures"],
  ] as const) {
    if (count > 0) reasons.push(`Playback reported ${count} ${label} during the run.`);
  }

  const timing = {
    maximumObservedCaptureToUplinkUs: Math.max(
      0,
      ...windows.map((sample) => sample.maximumCaptureToUplinkUs),
    ),
    maximumObservedProcessingUs: Math.max(0, ...windows.map((sample) => sample.maximumProcessUs)),
    maximumObservedPlaybackWriteUs: Math.max(
      0,
      ...windows.map((sample) => sample.maximumPlaybackWriteUs),
    ),
    maximumObservedReceiveToRenderMs: Math.max(
      0,
      ...windows.map((sample) => sample.maximumReceiveToRenderMs),
    ),
  };
  const processingDeadlineUs =
    windows.length === 0
      ? 0
      : Math.min(
          ...windows.map((sample) => (sample.processingFrameSamples * 1_000_000) / aecSampleRateHz),
        );
  if (timing.maximumObservedCaptureToUplinkUs > maximumCaptureToUplinkUs) {
    reasons.push(
      `Observed capture-to-uplink latency reached ${timing.maximumObservedCaptureToUplinkUs} us; ` +
        `expected at most ${maximumCaptureToUplinkUs} us.`,
    );
  }
  if (processingDeadlineUs > 0 && timing.maximumObservedProcessingUs > processingDeadlineUs) {
    reasons.push(
      `Observed AEC processing reached ${timing.maximumObservedProcessingUs} us; ` +
        `exceeded the ${processingDeadlineUs} us deadline for a ` +
        `${first?.processingFrameSamples ?? "missing"}-sample frame.`,
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
