import { createHash } from "node:crypto";
import {
  createChirpPcm16LeRenderer,
  createImpulseTrainPcm16LeRenderer,
  createMultiTonePcm16LeRenderer,
  createSpeechShapedPcm16LeRenderer,
  createTonePcm16LeRenderer,
  encodePcm16Le,
} from "../voice/deterministic-pcm-renderers.ts";
import type {
  DeterministicPcm16LeRenderer,
  DeterministicPcmSourcePause,
} from "../voice/deterministic-pcm-provider.ts";
import {
  validateAecReleaseCalibration,
  type AecReleaseCalibration,
} from "./aec-release-calibration.ts";
import {
  aecReleaseMatrix,
  type AecReleaseDevice,
  type AecReleaseLifecycleAction,
  type AecReleaseMatrixPhase,
  type AecReleaseNearLevel,
} from "./aec-release-matrix.ts";

const sampleRateHz = 16_000;

export type AecReleaseFarSource =
  | { kind: "changing-spectrum"; peakAmplitude: number; sampleRateHz: number; seed: number }
  | { kind: "chirp"; peakAmplitude: number; sampleRateHz: number }
  | { kind: "impulse-train"; peakAmplitude: number; sampleRateHz: number }
  | { kind: "multi-tone"; peakAmplitude: number; sampleRateHz: number }
  | {
      kind: "retained-speech";
      peakAmplitude: number;
      sampleRateHz: number;
      sourceId: "far-voice";
    }
  | {
      kind: "speech-shaped";
      peakAmplitude: number;
      sampleRateHz: number;
      seed: number;
    }
  | { kind: "tone"; peakAmplitude: number; sampleRateHz: number };

export interface AecReleaseNearSource {
  kind: "deterministic-speech-wave";
  level: AecReleaseNearLevel;
  macOutputVolumePercent: number;
}

export interface AecReleaseFixturePhase {
  durationMs: number;
  farSource: AecReleaseFarSource | null;
  id: string;
  lifecycleAction: AecReleaseLifecycleAction | null;
  nearSource: AecReleaseNearSource | null;
  scenario: AecReleaseMatrixPhase["scenario"];
  sourcePauses: readonly DeterministicPcmSourcePause[];
}

export interface AecReleaseFixturePlan {
  calibration: AecReleaseCalibration;
  phases: readonly AecReleaseFixturePhase[];
  runId: string;
  sampleRateHz: number;
  schemaVersion: 2;
}

/**
 * Turns the release policy into one target-independent executable fixture list.
 *
 * The matrix owns which experiments exist. Calibration supplies only the two
 * physical transducer controls which genuinely vary per enclosure: PCM peak at
 * a fixed device codec gain, and Mac output volume for the independent near
 * source. Keeping those concerns separate prevents a target adapter from
 * silently dropping an awkward phase while claiming to run the shared matrix.
 */
export function createAecReleaseFixturePlan(
  value: unknown,
  options: {
    expectedDeviceId: AecReleaseDevice;
    expectedMac: string;
    runId: string;
  },
): AecReleaseFixturePlan {
  if (!options.runId) throw new Error("AEC release fixture plan requires a run ID.");
  const calibration = validateAecReleaseCalibration(value, options);
  const phases = aecReleaseMatrix.phases.map((phase) =>
    createPhase(phase, calibration, options.runId),
  );
  return Object.freeze({
    calibration,
    phases: Object.freeze(phases),
    runId: options.runId,
    sampleRateHz,
    schemaVersion: 2 as const,
  });
}

function createPhase(
  phase: AecReleaseMatrixPhase,
  calibration: AecReleaseCalibration,
  runId: string,
): AecReleaseFixturePhase {
  const nearLevel =
    phase.scenario === "near-end-only" || phase.scenario === "double-talk" ? phase.nearLevel : null;
  const farSource = createFarSource(phase, calibration, runId);
  return Object.freeze({
    durationMs: phase.durationMs,
    farSource,
    id: phase.id,
    lifecycleAction: phase.scenario === "lifecycle" ? phase.lifecycleAction : null,
    nearSource:
      nearLevel === null
        ? null
        : Object.freeze({
            kind: "deterministic-speech-wave" as const,
            level: nearLevel,
            macOutputVolumePercent: calibration.nearLevels[nearLevel].macOutputVolumePercent,
          }),
    scenario: phase.scenario,
    sourcePauses: Object.freeze(
      phase.scenario === "lifecycle" && phase.lifecycleAction === "playback-underrun-recovery"
        ? [
            Object.freeze({
              afterSamples: sampleRateHz * 5,
              durationMs: 250,
            }),
          ]
        : [],
    ),
  });
}

function createFarSource(
  phase: AecReleaseMatrixPhase,
  calibration: AecReleaseCalibration,
  runId: string,
): AecReleaseFarSource | null {
  if (phase.scenario === "ambient" || phase.scenario === "near-end-only") return null;
  const driveLevel = phase.driveLevel;
  const peakAmplitude = calibration.levels[driveLevel].pcmPeakAmplitude;
  const stimulus =
    phase.scenario === "far-end-only"
      ? phase.stimulus
      : phase.scenario === "double-talk"
        ? "retained-speech"
        : phase.lifecycleAction === "long-duration-changing-playback"
          ? "changing-spectrum"
          : "retained-speech";
  const common = { peakAmplitude, sampleRateHz };
  switch (stimulus) {
    case "tone":
      return Object.freeze({ ...common, kind: "tone" as const });
    case "multi-tone":
      return Object.freeze({ ...common, kind: "multi-tone" as const });
    case "chirp":
      return Object.freeze({ ...common, kind: "chirp" as const });
    case "impulse-train":
      return Object.freeze({ ...common, kind: "impulse-train" as const });
    case "changing-spectrum":
      return Object.freeze({
        ...common,
        kind: "changing-spectrum" as const,
        seed: stableSeed(runId, phase.id),
      });
    case "speech-long":
    case "speech-shaped":
    case "retained-speech":
      return Object.freeze({
        ...common,
        kind: "retained-speech" as const,
        sourceId: "far-voice" as const,
      });
  }
}

/** Reconstructs the exact PCM source described by a retained fixture plan. */
export function createAecReleaseFixtureRenderer(
  source: AecReleaseFarSource,
): DeterministicPcm16LeRenderer {
  switch (source.kind) {
    case "retained-speech":
      throw new Error("Retained speech must be materialized from its synthesized source bytes.");
    case "tone":
      return createTonePcm16LeRenderer({
        amplitude: source.peakAmplitude,
        frequencyHz: 997,
        sampleRateHz: source.sampleRateHz,
      });
    case "multi-tone":
      return createMultiTonePcm16LeRenderer({
        amplitude: source.peakAmplitude,
        frequenciesHz: [251, 997, 3_101],
        sampleRateHz: source.sampleRateHz,
      });
    case "chirp":
      return createChirpPcm16LeRenderer({
        amplitude: source.peakAmplitude,
        endFrequencyHz: 3_600,
        sampleRateHz: source.sampleRateHz,
        startFrequencyHz: 120,
        sweepDurationSamples: source.sampleRateHz * 2,
      });
    case "impulse-train":
      return createImpulseTrainPcm16LeRenderer({
        amplitude: source.peakAmplitude,
        periodSamples: 1_003,
      });
    case "speech-shaped":
      /*
       * The speech renderer's documented coefficient is not its PCM peak. Its
       * two bounded filters and envelope have a conservative <7x mathematical
       * maximum. Divide by seven so the release calibration remains a hard
       * electrical peak boundary rather than a hopeful average-volume label.
       */
      return createSpeechShapedPcm16LeRenderer({
        amplitude: Math.max(1, Math.floor(source.peakAmplitude / 7)),
        sampleRateHz: source.sampleRateHz,
        seed: source.seed,
      });
    case "changing-spectrum":
      return createChangingSpectrumRenderer(source);
  }
}

function createChangingSpectrumRenderer(
  source: Extract<AecReleaseFarSource, { kind: "changing-spectrum" }>,
): DeterministicPcm16LeRenderer {
  const frequencies = [223, 431, 997, 1_663, 2_519, 3_401];
  const initialIndex = source.seed % frequencies.length;
  let phaseRadians = 0;
  let sampleOffset = 0;
  return {
    render(sampleCount) {
      const samples = new Int16Array(sampleCount);
      for (let index = 0; index < sampleCount; index += 1) {
        const absoluteSample = sampleOffset + index;
        const segment = Math.floor(absoluteSample / source.sampleRateHz);
        const frequencyHz = frequencies[(initialIndex + segment) % frequencies.length]!;
        samples[index] = Math.round(Math.sin(phaseRadians) * source.peakAmplitude);
        phaseRadians =
          (phaseRadians + (2 * Math.PI * frequencyHz) / source.sampleRateHz) % (2 * Math.PI);
      }
      sampleOffset += sampleCount;
      return encodePcm16Le(samples);
    },
  };
}

function stableSeed(runId: string, phaseId: string) {
  const digest = createHash("sha256").update(`${runId}\0${phaseId}`).digest();
  return digest.readUInt32LE(0);
}
