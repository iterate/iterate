export type AecReleaseSignalScenario = "ambient" | "double-talk" | "far" | "near";

interface SignalSummary {
  clippedSamples: number;
  dbfs: number | null;
  peak: number;
  rms: number;
}

export interface AecReleaseSignalWindowAssessment {
  clean: SignalSummary;
  erleDb: number | null;
  nearPreservation: {
    gain: number;
    residualToReferenceDb: number | null;
    similarity: number;
  } | null;
  passed: boolean;
  raw: SignalSummary;
  reasons: string[];
  scenario: AecReleaseSignalScenario;
}

const maximumFarCleanDbfs = -40;
const maximumFarAboveAmbientDb = 6;
const minimumFarRawAboveAmbientDb = 6;
const minimumSettledErleDb = 20;
const minimumNearAboveAmbientDb = 10;
const minimumNearGain = 0.5;
const maximumNearGain = 2;
const maximumNearResidualDb = -6;

/**
 * Scores one bounded device-owned trace window without network assumptions.
 *
 * Raw and clean are simultaneous samples from the same audio owner. Far-only
 * evidence must prove both that speaker energy reached the raw microphone and
 * that the selected uplink removed it; silence alone can never pass. Near and
 * double-talk preservation compare against a separately captured near-only
 * control because the original Mac bytes are not the waveform after speaker,
 * room, microphone, and target DSP transfer.
 */
export function assessAecReleaseSignalWindow(options: {
  ambientRms: number;
  clean: Int16Array;
  nearControl?: Int16Array;
  raw: Int16Array;
  sampleRateHz: number;
  scenario: AecReleaseSignalScenario;
}): AecReleaseSignalWindowAssessment {
  assertSignalGeometry(options);
  const raw = summarize(options.raw);
  const clean = summarize(options.clean);
  const reasons: string[] = [];
  if (raw.clippedSamples > 0) reasons.push(`Raw microphone clipped ${raw.clippedSamples} samples.`);
  if (clean.clippedSamples > 0)
    reasons.push(`Clean uplink clipped ${clean.clippedSamples} samples.`);

  let erleDb: number | null = null;
  let nearPreservation: AecReleaseSignalWindowAssessment["nearPreservation"] = null;
  if (options.scenario === "far") {
    const rawAboveAmbientDb = ratioDb(raw.rms, options.ambientRms);
    if (rawAboveAmbientDb < minimumFarRawAboveAmbientDb) {
      reasons.push(
        `Far raw microphone was only ${rawAboveAmbientDb.toFixed(2)} dB above ambient; ` +
          `expected at least ${minimumFarRawAboveAmbientDb} dB.`,
      );
    }
    const maximumCleanRms = Math.max(
      dbfsToRms(maximumFarCleanDbfs),
      options.ambientRms * 10 ** (maximumFarAboveAmbientDb / 20),
    );
    if (clean.rms > maximumCleanRms) {
      reasons.push(
        `Far clean residual was ${formatDb(clean.dbfs)} dBFS; expected at most ` +
          `${formatDb(rmsToDbfs(maximumCleanRms))} dBFS.`,
      );
    }
    erleDb = ratioDb(raw.rms, clean.rms);
    if (rawAboveAmbientDb >= minimumFarRawAboveAmbientDb && erleDb < minimumSettledErleDb) {
      reasons.push(
        `Settled ERLE was ${erleDb.toFixed(2)} dB; expected at least ${minimumSettledErleDb} dB.`,
      );
    }
  } else if (options.scenario === "near" || options.scenario === "double-talk") {
    if (!options.nearControl) {
      reasons.push("Near-end preservation has no retained physical near-only control.");
    } else {
      const alignment = alignAndCompare(options.nearControl, options.clean, options.sampleRateHz);
      nearPreservation = {
        gain: alignment.gain,
        residualToReferenceDb: finiteOrNull(alignment.residualToReferenceDb),
        similarity: alignment.similarity,
      };
      const gainMagnitude = Math.abs(alignment.gain);
      const aboveAmbientDb = ratioDb(clean.rms, options.ambientRms);
      if (aboveAmbientDb < minimumNearAboveAmbientDb) {
        reasons.push(
          `Near clean signal was ${aboveAmbientDb.toFixed(2)} dB above ambient; ` +
            `expected at least ${minimumNearAboveAmbientDb} dB.`,
        );
      }
      if (
        gainMagnitude < minimumNearGain ||
        gainMagnitude > maximumNearGain ||
        alignment.residualToReferenceDb > maximumNearResidualDb
      ) {
        reasons.push(
          `Near preservation failed: gain ${alignment.gain.toFixed(3)}, similarity ` +
            `${alignment.similarity.toFixed(3)}, residual ` +
            `${alignment.residualToReferenceDb.toFixed(2)} dB.`,
        );
      }
    }
  }

  return {
    clean,
    erleDb: finiteOrNull(erleDb),
    nearPreservation,
    passed: reasons.length === 0,
    raw,
    reasons,
    scenario: options.scenario,
  };
}

function assertSignalGeometry(options: {
  clean: Int16Array;
  raw: Int16Array;
  sampleRateHz: number;
}) {
  if (!Number.isSafeInteger(options.sampleRateHz) || options.sampleRateHz <= 0) {
    throw new Error("AEC release signal window has an invalid sample rate.");
  }
  if (options.raw.length < options.sampleRateHz || options.clean.length !== options.raw.length) {
    throw new Error(
      "AEC release signal windows require equal raw/clean PCM of at least one second.",
    );
  }
}

function summarize(samples: Int16Array): SignalSummary {
  let clippedSamples = 0;
  let peak = 0;
  let squareSum = 0;
  for (const sample of samples) {
    if (sample === -32_768 || sample === 32_767) clippedSamples += 1;
    peak = Math.max(peak, Math.abs(sample));
    squareSum += sample * sample;
  }
  const rms = Math.sqrt(squareSum / samples.length);
  return { clippedSamples, dbfs: finiteOrNull(rmsToDbfs(rms)), peak, rms };
}

function alignAndCompare(reference: Int16Array, candidate: Int16Array, sampleRateHz: number) {
  const maximumLagSamples = Math.floor(sampleRateHz * 0.75);
  const stride = Math.max(1, Math.floor(sampleRateHz / 1_000));
  let bestLag = 0;
  let bestSimilarity = -1;
  for (let lag = -maximumLagSamples; lag <= maximumLagSamples; lag += stride) {
    const similarity = Math.abs(alignmentStatistics(reference, candidate, lag, stride).similarity);
    if (similarity > bestSimilarity) {
      bestLag = lag;
      bestSimilarity = similarity;
    }
  }
  for (
    let lag = Math.max(-maximumLagSamples, bestLag - stride);
    lag <= Math.min(maximumLagSamples, bestLag + stride);
    lag += 1
  ) {
    const similarity = Math.abs(alignmentStatistics(reference, candidate, lag, 1).similarity);
    if (similarity > bestSimilarity) {
      bestLag = lag;
      bestSimilarity = similarity;
    }
  }
  return alignmentStatistics(reference, candidate, bestLag, 1);
}

function alignmentStatistics(
  reference: Int16Array,
  candidate: Int16Array,
  lag: number,
  stride: number,
) {
  const referenceStart = Math.max(0, -lag);
  const candidateStart = Math.max(0, lag);
  const overlap = Math.min(reference.length - referenceStart, candidate.length - candidateStart);
  let cross = 0;
  let referenceEnergy = 0;
  let candidateEnergy = 0;
  for (let offset = 0; offset < overlap; offset += stride) {
    const referenceSample = reference[referenceStart + offset]!;
    const candidateSample = candidate[candidateStart + offset]!;
    cross += referenceSample * candidateSample;
    referenceEnergy += referenceSample * referenceSample;
    candidateEnergy += candidateSample * candidateSample;
  }
  if (referenceEnergy === 0 || candidateEnergy === 0) {
    return {
      gain: 0,
      residualToReferenceDb:
        candidateEnergy === 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      similarity: 0,
    };
  }
  const gain = cross / referenceEnergy;
  let residualEnergy = 0;
  for (let offset = 0; offset < overlap; offset += 1) {
    const residual =
      candidate[candidateStart + offset]! - gain * reference[referenceStart + offset]!;
    residualEnergy += residual * residual;
  }
  return {
    gain,
    residualToReferenceDb:
      10 * Math.log10(Math.max(Number.MIN_VALUE, residualEnergy) / referenceEnergy),
    similarity: Math.abs(cross) / Math.sqrt(referenceEnergy * candidateEnergy),
  };
}

function ratioDb(numerator: number, denominator: number) {
  if (numerator <= 0) return Number.NEGATIVE_INFINITY;
  if (denominator <= 0) return Number.POSITIVE_INFINITY;
  return 20 * Math.log10(numerator / denominator);
}

function rmsToDbfs(rms: number) {
  return rms <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms / 32_768);
}

function dbfsToRms(dbfs: number) {
  return 32_768 * 10 ** (dbfs / 20);
}

function finiteOrNull(value: number | null) {
  return value !== null && Number.isFinite(value) ? value : null;
}

function formatDb(value: number | null) {
  return value === null ? "-infinity" : value.toFixed(2);
}
