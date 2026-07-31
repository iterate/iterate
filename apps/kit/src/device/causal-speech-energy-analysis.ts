import { open } from "node:fs/promises";

const windowDurationMs = 20;
const minimumAbsoluteActiveRms = 120;
const baselineMultiplier = 2.5;
const minimumActiveWindows = 4;
const clippingMagnitude = 32_760;

export interface Pcm16WindowEnergyAnalysis {
  activeWindowCount: number | null;
  clippedSampleCount: number;
  maximumRms: number;
  p50Rms: number;
  p95Rms: number;
  p99Rms: number;
  sampleCount: number;
  windowCount: number;
  windowDurationMs: 20;
}

export interface CausalSpeechEnergyAssessment {
  activeThresholdRms: number;
  activeWindowCount: number;
  passed: boolean;
  reasons: string[];
}

/**
 * Measures fixed-size acoustic windows without loading the retained recording.
 *
 * Returned speech has no deterministic phase or duration, so its physical
 * oracle is deliberately weaker than the tone oracle but still causal and
 * bounded: a nearby microphone must show several energetic windows after the
 * release marker, relative to an ambient interval captured before PTT. Reading
 * one 20 ms window at a time keeps host memory fixed for future endurance runs.
 */
export async function analyzePcm16WindowEnergy(options: {
  activeThresholdRms?: number;
  artifactPath: string;
  endSample: number;
  sampleRateHz: number;
  startSample: number;
}): Promise<Pcm16WindowEnergyAnalysis> {
  if (!Number.isSafeInteger(options.sampleRateHz) || options.sampleRateHz <= 0) {
    throw new Error("The acoustic sample rate must be a positive integer.");
  }
  if (
    !Number.isSafeInteger(options.startSample) ||
    !Number.isSafeInteger(options.endSample) ||
    options.startSample < 0 ||
    options.endSample <= options.startSample
  ) {
    throw new Error("The acoustic interval must contain a positive whole-sample range.");
  }
  if (
    options.activeThresholdRms !== undefined &&
    (!Number.isFinite(options.activeThresholdRms) || options.activeThresholdRms < 0)
  ) {
    throw new Error("The active acoustic threshold must be a finite nonnegative number.");
  }
  const samplesPerWindow = (options.sampleRateHz * windowDurationMs) / 1_000;
  if (!Number.isSafeInteger(samplesPerWindow)) {
    throw new Error("The sample rate must contain a whole number of samples per 20 ms window.");
  }

  const artifact = await open(options.artifactPath, "r");
  try {
    const status = await artifact.stat();
    const availableSamples = status.size / Int16Array.BYTES_PER_ELEMENT;
    if (!Number.isSafeInteger(availableSamples) || options.endSample > availableSamples) {
      throw new Error("The requested acoustic interval is outside the retained PCM16 artifact.");
    }
    const buffer = Buffer.alloc(samplesPerWindow * Int16Array.BYTES_PER_ELEMENT);
    const rmsValues: number[] = [];
    let activeWindowCount = 0;
    let clippedSampleCount = 0;
    let sampleCount = 0;
    for (
      let windowStart = options.startSample;
      windowStart < options.endSample;
      windowStart += samplesPerWindow
    ) {
      const windowSamples = Math.min(samplesPerWindow, options.endSample - windowStart);
      const bytesToRead = windowSamples * Int16Array.BYTES_PER_ELEMENT;
      const { bytesRead } = await artifact.read(
        buffer,
        0,
        bytesToRead,
        windowStart * Int16Array.BYTES_PER_ELEMENT,
      );
      if (bytesRead !== bytesToRead) {
        throw new Error("The retained PCM16 artifact ended during acoustic analysis.");
      }
      let squareSum = 0;
      for (let offset = 0; offset < bytesRead; offset += Int16Array.BYTES_PER_ELEMENT) {
        const sample = buffer.readInt16LE(offset);
        squareSum += sample * sample;
        if (Math.abs(sample) >= clippingMagnitude) clippedSampleCount += 1;
      }
      sampleCount += windowSamples;
      const rms = Math.sqrt(squareSum / windowSamples);
      rmsValues.push(rms);
      if (options.activeThresholdRms !== undefined && rms >= options.activeThresholdRms) {
        activeWindowCount += 1;
      }
    }
    rmsValues.sort((left, right) => left - right);
    return {
      activeWindowCount: options.activeThresholdRms === undefined ? null : activeWindowCount,
      clippedSampleCount,
      maximumRms: rmsValues.at(-1) ?? 0,
      p50Rms: percentile(rmsValues, 0.5),
      p95Rms: percentile(rmsValues, 0.95),
      p99Rms: percentile(rmsValues, 0.99),
      sampleCount,
      windowCount: rmsValues.length,
      windowDurationMs,
    };
  } finally {
    await artifact.close();
  }
}

/**
 * Distinguishes sustained returned sound from ambient noise or a single click.
 *
 * The exact relative threshold is part of the artifact. Four windows mean at
 * least 80 ms of energy: intentionally modest for short Grok acknowledgements,
 * but enough that a relay click or button handling transient cannot pass.
 */
export function assessCausalSpeechEnergy(
  baseline: Pcm16WindowEnergyAnalysis,
  response: Pcm16WindowEnergyAnalysis,
): CausalSpeechEnergyAssessment {
  const activeThresholdRms = causalSpeechActiveThreshold(baseline);
  const activeWindowCount = response.activeWindowCount ?? 0;
  const reasons: string[] = [];
  if (response.activeWindowCount === null) {
    reasons.push("The causal response was not analyzed against its baseline-relative threshold.");
  }
  if (response.windowCount < minimumActiveWindows) {
    reasons.push(
      `The causal response contained ${response.windowCount} windows; expected at least ${minimumActiveWindows}.`,
    );
  }
  if (activeWindowCount < minimumActiveWindows) {
    reasons.push(
      `The causal response contained ${activeWindowCount} active 20 ms windows; ` +
        `expected at least ${minimumActiveWindows}.`,
    );
  }
  if (response.clippedSampleCount > 0) {
    reasons.push(`The causal response contained ${response.clippedSampleCount} clipped samples.`);
  }
  return {
    activeThresholdRms,
    activeWindowCount,
    passed: reasons.length === 0,
    reasons,
  };
}

export function causalSpeechActiveThreshold(baseline: Pcm16WindowEnergyAnalysis) {
  return Math.max(minimumAbsoluteActiveRms, baseline.p99Rms * baselineMultiplier);
}

function percentile(sortedValues: readonly number[], quantile: number) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * quantile) - 1),
  );
  return sortedValues[index] ?? 0;
}
