import { z } from "zod";

export const productionAecPcmFrameBytes = 640;
export const productionAecPcmFrameDurationMs = 20;
export const productionAecPcmSampleRateHz = 16_000;

const maximumCaptureFrames = 300;
const minimumAssessableDurationMs = 1_000;
const boundaryAllowanceFrames = 3;
const captureFinishBoundaryMarginMs = 250;
const realtimeArrivalSpanAllowanceMs = boundaryAllowanceFrames * productionAecPcmFrameDurationMs;
const nonnegativeSafeInteger = z.number().int().nonnegative().safe();
const nullableNonnegativeSafeInteger = nonnegativeSafeInteger.nullable();

/*
 * Schema 3 keeps wall and monotonic time side by side. Wall time is retained
 * for cross-machine network attribution but may legitimately step backward;
 * every ordering, span, and realtime gate below therefore uses only the
 * monotonic fields. Accepting schema 2 here would silently revive the flawed
 * wall-clock cadence oracle, so firmware/worker and proof tooling move as one
 * evidence contract rather than using a compatibility fallback.
 */
const ProductionAecDiagnosticCaptureSchema = z
  .strictObject({
    finishedAtMonotonicMs: nonnegativeSafeInteger,
    finishedAtMs: nonnegativeSafeInteger,
    firstAcceptedAtMonotonicMs: nullableNonnegativeSafeInteger,
    firstAcceptedAtMs: nullableNonnegativeSafeInteger,
    firstAcceptedUplinkFrame: nullableNonnegativeSafeInteger,
    frameBytes: z.literal(productionAecPcmFrameBytes),
    frames: nonnegativeSafeInteger,
    lastAcceptedAtMonotonicMs: nullableNonnegativeSafeInteger,
    lastAcceptedAtMs: nullableNonnegativeSafeInteger,
    lastAcceptedUplinkFrame: nullableNonnegativeSafeInteger,
    maximumFrames: nonnegativeSafeInteger.min(1).max(maximumCaptureFrames),
    maximumInterFrameGapMs: nonnegativeSafeInteger,
    pcm: z.instanceof(Uint8Array),
    schemaVersion: z.literal(3),
    startedAtMonotonicMs: nonnegativeSafeInteger,
    startedAtMs: nonnegativeSafeInteger,
    truncatedFrames: nonnegativeSafeInteger,
  })
  .superRefine((capture, context) => {
    if (capture.finishedAtMonotonicMs < capture.startedAtMonotonicMs) {
      context.addIssue({
        code: "custom",
        message: "finishedAtMonotonicMs must not precede startedAtMonotonicMs",
        path: ["finishedAtMonotonicMs"],
      });
    }
    if (capture.frames > capture.maximumFrames) {
      context.addIssue({
        code: "custom",
        message: "frames must not exceed maximumFrames",
        path: ["frames"],
      });
    }
    const emptyBoundary =
      capture.firstAcceptedAtMonotonicMs === null &&
      capture.firstAcceptedAtMs === null &&
      capture.firstAcceptedUplinkFrame === null &&
      capture.lastAcceptedAtMonotonicMs === null &&
      capture.lastAcceptedAtMs === null &&
      capture.lastAcceptedUplinkFrame === null;
    const completeBoundary =
      capture.firstAcceptedAtMonotonicMs !== null &&
      capture.firstAcceptedAtMs !== null &&
      capture.firstAcceptedUplinkFrame !== null &&
      capture.lastAcceptedAtMonotonicMs !== null &&
      capture.lastAcceptedAtMs !== null &&
      capture.lastAcceptedUplinkFrame !== null;
    if ((capture.frames === 0 && !emptyBoundary) || (capture.frames > 0 && !completeBoundary)) {
      context.addIssue({
        code: "custom",
        message: "Accepted-frame boundaries must be all null only for an empty capture.",
        path: ["frames"],
      });
      return;
    }
    if (
      capture.firstAcceptedAtMonotonicMs === null ||
      capture.firstAcceptedAtMs === null ||
      capture.firstAcceptedUplinkFrame === null ||
      capture.lastAcceptedAtMonotonicMs === null ||
      capture.lastAcceptedAtMs === null ||
      capture.lastAcceptedUplinkFrame === null
    ) {
      if (capture.maximumInterFrameGapMs !== 0) {
        context.addIssue({
          code: "custom",
          message: "An empty capture cannot report an inter-frame gap.",
          path: ["maximumInterFrameGapMs"],
        });
      }
      return;
    }
    if (
      capture.firstAcceptedAtMonotonicMs < capture.startedAtMonotonicMs ||
      capture.lastAcceptedAtMonotonicMs < capture.firstAcceptedAtMonotonicMs ||
      capture.lastAcceptedAtMonotonicMs > capture.finishedAtMonotonicMs
    ) {
      context.addIssue({
        code: "custom",
        message: "Accepted monotonic timestamps must stay inside the ordered capture interval.",
        path: ["firstAcceptedAtMonotonicMs"],
      });
    }
    if (
      capture.firstAcceptedUplinkFrame <= 0 ||
      capture.lastAcceptedUplinkFrame < capture.firstAcceptedUplinkFrame
    ) {
      context.addIssue({
        code: "custom",
        message: "Accepted uplink frame ordinals must be positive and ordered.",
        path: ["firstAcceptedUplinkFrame"],
      });
    }
    if (
      capture.maximumInterFrameGapMs >
      capture.lastAcceptedAtMonotonicMs - capture.firstAcceptedAtMonotonicMs
    ) {
      context.addIssue({
        code: "custom",
        message: "The maximum inter-frame gap cannot exceed the accepted-frame span.",
        path: ["maximumInterFrameGapMs"],
      });
    }
  });

export interface ProductionAecDiagnosticCapture {
  acceptedFrameSpanMs: number;
  capturedAudioDurationMs: number;
  durationMs: number;
  finishedAtMonotonicMs: number;
  finishedAtMs: number;
  firstAcceptedAtMonotonicMs: number | null;
  firstAcceptedAtMs: number | null;
  firstAcceptedUplinkFrame: number | null;
  frameBytes: typeof productionAecPcmFrameBytes;
  frames: number;
  lastAcceptedAtMonotonicMs: number | null;
  lastAcceptedAtMs: number | null;
  lastAcceptedUplinkFrame: number | null;
  maximumFrames: number;
  maximumInterFrameGapMs: number;
  pcm: Uint8Array;
  samples: Int16Array;
  schemaVersion: 3;
  startedAtMonotonicMs: number;
  startedAtMs: number;
  truncatedFrames: number;
}

export interface ProductionAecDiagnosticCaptureAssessment {
  acceptedFrameSpanMs: number;
  actualFrames: number;
  capturedAudioDurationMs: number;
  durationMs: number;
  expectedFrames: number;
  frameConservationPassed: boolean;
  maximumExpectedFrames: number;
  minimumExpectedFrames: number;
  passed: boolean;
  realtimeCadencePassed: boolean;
  reasons: string[];
}

export interface ProductionAecAnalysisWindow {
  assessmentDurationMs: number;
  assessmentSampleCount: number;
  assessmentStartSample: number;
  captureDurationMs: number;
  settledLeadMs: number;
}

/**
 * Plans a sample-exact analysis window inside a deliberately longer capture.
 *
 * A Cap'n Web request can start between two 20 ms uplink frames, and its
 * finish request includes control-plane scheduling and network time. Those
 * RPC timestamps therefore do not define the audio clock. Capturing a fixed
 * 250 ms tail makes the requested audio interval available even when either
 * control boundary lands badly; the tail is never analysed and is not a
 * tolerance for a missing PCM frame. The selected interval below remains an
 * exact sample count, while accepted-frame ordinals and timestamps prove that
 * the surrounding capture remained conserved and realtime.
 */
export function planProductionAecAnalysisWindow(options: {
  assessmentDurationMs: number;
  settledLeadMs: number;
}): ProductionAecAnalysisWindow {
  if (
    !Number.isSafeInteger(options.assessmentDurationMs) ||
    options.assessmentDurationMs <= 0 ||
    !Number.isSafeInteger(options.settledLeadMs) ||
    options.settledLeadMs < 0
  ) {
    throw new Error("Production AEC window durations must be nonnegative whole milliseconds.");
  }
  const assessmentStartSample = (options.settledLeadMs * productionAecPcmSampleRateHz) / 1_000;
  const assessmentSampleCount =
    (options.assessmentDurationMs * productionAecPcmSampleRateHz) / 1_000;
  if (
    !Number.isSafeInteger(assessmentStartSample) ||
    !Number.isSafeInteger(assessmentSampleCount)
  ) {
    throw new Error("Production AEC window boundaries must align to whole PCM samples.");
  }
  return {
    ...options,
    assessmentSampleCount,
    assessmentStartSample,
    captureDurationMs:
      options.settledLeadMs + options.assessmentDurationMs + captureFinishBoundaryMarginMs,
  };
}

/** Selects only the declared acoustic interval, never the control-boundary tail. */
export function extractProductionAecAnalysisWindow(
  samples: Int16Array,
  plan: ProductionAecAnalysisWindow,
  label: string,
) {
  const endSample = plan.assessmentStartSample + plan.assessmentSampleCount;
  if (samples.length < endSample) {
    throw new Error(`${label} retained ${samples.length} samples; ${endSample} are required.`);
  }
  return samples.slice(plan.assessmentStartSample, endSample);
}

/**
 * Validates and owns one bounded raw-uplink snapshot returned over Cap'n Web.
 *
 * The worker deliberately exposes `unknown` bytes only in deterministic mode.
 * This parser is the host-side trust boundary: it requires the exact deployed
 * framing contract, independently checks byte conservation, and decodes
 * little-endian samples without relying on the host CPU's endianness or Buffer
 * alignment. A private copy prevents a later RPC cleanup or caller mutation
 * from changing evidence after it has been assessed and written to disk.
 */
export function parseProductionAecDiagnosticCapture(
  value: unknown,
): ProductionAecDiagnosticCapture {
  const parsed = ProductionAecDiagnosticCaptureSchema.parse(value);
  const expectedBytes = parsed.frames * parsed.frameBytes;
  if (parsed.pcm.byteLength !== expectedBytes) {
    throw new Error(
      `Diagnostic capture retained ${parsed.pcm.byteLength} PCM bytes; expected ${expectedBytes} ` +
        `from ${parsed.frames} complete frames.`,
    );
  }

  const pcm = Uint8Array.from(parsed.pcm);
  const samples = new Int16Array(pcm.byteLength / Int16Array.BYTES_PER_ELEMENT);
  const pcmView = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = pcmView.getInt16(index * Int16Array.BYTES_PER_ELEMENT, true);
  }
  return {
    ...parsed,
    acceptedFrameSpanMs:
      parsed.firstAcceptedAtMonotonicMs === null || parsed.lastAcceptedAtMonotonicMs === null
        ? 0
        : parsed.lastAcceptedAtMonotonicMs - parsed.firstAcceptedAtMonotonicMs,
    capturedAudioDurationMs: parsed.frames * productionAecPcmFrameDurationMs,
    durationMs: parsed.finishedAtMonotonicMs - parsed.startedAtMonotonicMs,
    pcm,
    samples,
  };
}

/**
 * Decides whether the snapshot is complete enough to become an audio oracle.
 *
 * Exact ordinals and bytes answer whether the retained provider-accepted PCM
 * is conserved. Accepted-frame timestamps answer the different question of
 * whether that PCM arrived in realtime. The Cap'n Web recorder timestamps are
 * intentionally not used as an audio clock: doing so made a healthy 3.98 s
 * stream fail because the finish RPC took 50 ms to arrive. The fixed
 * three-frame arrival allowance applies only to accepted audio timestamps and
 * cannot turn sustained lag, a large inter-frame gap, or compression into a
 * pass.
 */
export function assessProductionAecDiagnosticCapture(
  capture: ProductionAecDiagnosticCapture,
): ProductionAecDiagnosticCaptureAssessment {
  const expectedFrames = Math.round(capture.durationMs / productionAecPcmFrameDurationMs);
  const minimumExpectedFrames = Math.max(0, expectedFrames - boundaryAllowanceFrames);
  const maximumExpectedFrames = expectedFrames + boundaryAllowanceFrames;
  const reasons: string[] = [];
  let frameConservationPassed = true;
  let realtimeCadencePassed = true;

  if (capture.durationMs < minimumAssessableDurationMs) {
    reasons.push(
      `Diagnostic capture lasted ${capture.durationMs} ms; at least ` +
        `${minimumAssessableDurationMs} ms is required.`,
    );
  }
  if (capture.capturedAudioDurationMs < minimumAssessableDurationMs) {
    reasons.push(
      `Diagnostic capture retained ${capture.capturedAudioDurationMs} ms of accepted PCM; at ` +
        `least ${minimumAssessableDurationMs} ms is required.`,
    );
  }
  if (capture.firstAcceptedUplinkFrame !== null && capture.lastAcceptedUplinkFrame !== null) {
    const acceptedOrdinalSpan =
      capture.lastAcceptedUplinkFrame - capture.firstAcceptedUplinkFrame + 1;
    if (acceptedOrdinalSpan !== capture.frames) {
      frameConservationPassed = false;
      reasons.push(
        `Retained accepted uplink ordinals span ${capture.firstAcceptedUplinkFrame} through ` +
          `${capture.lastAcceptedUplinkFrame} (${acceptedOrdinalSpan} frames), but the capture ` +
          `contains ${capture.frames} frames.`,
      );
    }
  }
  const retainedFrameStartSpanMs = Math.max(
    0,
    (capture.frames - 1) * productionAecPcmFrameDurationMs,
  );
  const arrivalSpanErrorMs = capture.acceptedFrameSpanMs - retainedFrameStartSpanMs;
  if (Math.abs(arrivalSpanErrorMs) > realtimeArrivalSpanAllowanceMs) {
    realtimeCadencePassed = false;
    const behavior = arrivalSpanErrorMs < 0 ? "compression" : "expansion";
    reasons.push(
      `The retained PCM covers ${retainedFrameStartSpanMs} ms between frame starts but arrived ` +
        `over ${capture.acceptedFrameSpanMs} ms; the ${Math.abs(arrivalSpanErrorMs)} ms ` +
        `${behavior} exceeds the ${realtimeArrivalSpanAllowanceMs} ms realtime allowance.`,
    );
  }
  if (capture.maximumInterFrameGapMs > realtimeArrivalSpanAllowanceMs) {
    realtimeCadencePassed = false;
    reasons.push(
      `The maximum accepted-uplink gap was ${capture.maximumInterFrameGapMs} ms; ` +
        `${realtimeArrivalSpanAllowanceMs} ms is the fixed realtime limit.`,
    );
  }
  if (capture.truncatedFrames > 0) {
    frameConservationPassed = false;
    const noun = capture.truncatedFrames === 1 ? "frame" : "frames";
    reasons.push(
      `Diagnostic capture discarded ${capture.truncatedFrames} accepted uplink ${noun} after ` +
        `reaching its fixed bound.`,
    );
  }

  return {
    actualFrames: capture.frames,
    acceptedFrameSpanMs: capture.acceptedFrameSpanMs,
    capturedAudioDurationMs: capture.capturedAudioDurationMs,
    durationMs: capture.durationMs,
    expectedFrames,
    frameConservationPassed,
    maximumExpectedFrames,
    minimumExpectedFrames,
    passed: reasons.length === 0,
    realtimeCadencePassed,
    reasons,
  };
}
