import type { AecReleaseCalibration } from "./aec-release-calibration.ts";
import type { AecReleaseDevice } from "./aec-release-matrix.ts";

export interface MeasuredAecDriveCandidate {
  pcmPeakAmplitude: number;
  playoutClippedSamples: number;
  rawMicClippedSamples: number;
  sourceClippedSamples: number;
}

export interface MeasuredAecNearCandidate {
  macOutputVolumePercent: number;
  rawMicClippedSamples: number;
  sourceClippedSamples: number;
}

type CodecDrive =
  | { decibels: number; kind: "aic3204-dac-decibels" }
  | { kind: "esp-codec-volume-percent"; percent: number };

export interface MeasuredAecReleaseCalibration {
  calibration: AecReleaseCalibration;
  measurements: {
    driveCandidates: readonly MeasuredAecDriveCandidate[];
    nearCandidates: readonly MeasuredAecNearCandidate[];
  };
}

/**
 * Converts ordered physical observations into the matrix's three level names.
 *
 * This function intentionally owns no target hardware. The physical runner
 * owns exact playback and trace capture; this composer owns the invariant that
 * accepted levels are monotonic, observed, and never selected after clipping.
 * Keeping the raw candidate list beside the selected profile makes a later
 * review able to distinguish a real transducer boundary from a policy ceiling.
 */
export function composeMeasuredAecReleaseCalibration(options: {
  artifactDirectory: string;
  calibratedAt: string;
  codecDrive: CodecDrive;
  deviceId: AecReleaseDevice;
  driveCandidates: readonly MeasuredAecDriveCandidate[];
  exactMac: string;
  nearCandidates: readonly MeasuredAecNearCandidate[];
  reviewedSafetyCeilingAmplitude: number;
}): MeasuredAecReleaseCalibration {
  assertStrictlyAscending(
    options.driveCandidates.map((candidate) => candidate.pcmPeakAmplitude),
    "AEC drive candidates",
  );
  assertStrictlyAscending(
    options.nearCandidates.map((candidate) => candidate.macOutputVolumePercent),
    "AEC near-source candidates",
  );

  const acceptedDrive: MeasuredAecDriveCandidate[] = [];
  let rejectedDrive: MeasuredAecDriveCandidate | undefined;
  for (const candidate of options.driveCandidates) {
    const clippedSamples = driveClippedSamples(candidate);
    if (clippedSamples > 0) {
      rejectedDrive ??= candidate;
      continue;
    }
    if (rejectedDrive) {
      throw new Error("AEC drive acquisition observed an accepted candidate after clipping.");
    }
    acceptedDrive.push(candidate);
  }
  if (acceptedDrive.length < 3) {
    throw new Error("AEC calibration requires at least three unclipped drive candidates.");
  }
  const maximum = acceptedDrive.at(-1)!;
  const safetyCeilingReached =
    !rejectedDrive && maximum.pcmPeakAmplitude === options.reviewedSafetyCeilingAmplitude;
  if (!rejectedDrive && !safetyCeilingReached) {
    throw new Error(
      "AEC drive acquisition stopped before clipping or its reviewed safety ceiling.",
    );
  }

  const acceptedNear = options.nearCandidates.filter(
    (candidate) => candidate.rawMicClippedSamples + candidate.sourceClippedSamples === 0,
  );
  if (acceptedNear.length < 3) {
    throw new Error("AEC calibration requires at least three unclipped near-source candidates.");
  }

  const quiet = acceptedDrive[0]!;
  const nominal = acceptedDrive[Math.floor((acceptedDrive.length - 1) / 2)]!;
  const nearQuiet = acceptedNear[0]!;
  const nearNominal = acceptedNear[Math.floor((acceptedNear.length - 1) / 2)]!;
  const nearLoud = acceptedNear.at(-1)!;
  return {
    calibration: {
      artifactDirectory: options.artifactDirectory,
      calibratedAt: options.calibratedAt,
      codecDrive: options.codecDrive,
      deviceId: options.deviceId,
      exactMac: options.exactMac,
      levels: {
        "maximum-non-clipping": withoutNearMeasurement(maximum),
        nominal: withoutNearMeasurement(nominal),
        quiet: withoutNearMeasurement(quiet),
      },
      maximumBoundary: {
        nextRejectedAmplitude: rejectedDrive?.pcmPeakAmplitude ?? null,
        nextRejectedClippedSamples: rejectedDrive ? driveClippedSamples(rejectedDrive) : 0,
        safetyCeilingReached,
      },
      nearLevels: {
        loud: withoutRawNearMeasurement(nearLoud),
        nominal: withoutRawNearMeasurement(nearNominal),
        quiet: withoutRawNearMeasurement(nearQuiet),
      },
    },
    measurements: {
      driveCandidates: options.driveCandidates.map((candidate) => ({ ...candidate })),
      nearCandidates: options.nearCandidates.map((candidate) => ({ ...candidate })),
    },
  };
}

function driveClippedSamples(candidate: MeasuredAecDriveCandidate) {
  return (
    candidate.playoutClippedSamples +
    candidate.rawMicClippedSamples +
    candidate.sourceClippedSamples
  );
}

function withoutNearMeasurement(candidate: MeasuredAecDriveCandidate) {
  return {
    pcmPeakAmplitude: candidate.pcmPeakAmplitude,
    playoutClippedSamples: candidate.playoutClippedSamples,
    rawMicClippedSamples: candidate.rawMicClippedSamples,
    sourceClippedSamples: candidate.sourceClippedSamples,
  };
}

function withoutRawNearMeasurement(candidate: MeasuredAecNearCandidate) {
  return {
    macOutputVolumePercent: candidate.macOutputVolumePercent,
    sourceClippedSamples: candidate.sourceClippedSamples,
  };
}

function assertStrictlyAscending(values: readonly number[], label: string) {
  if (
    values.length === 0 ||
    values.some(
      (value, index) =>
        !Number.isSafeInteger(value) || value <= 0 || (index > 0 && value <= values[index - 1]!),
    )
  ) {
    throw new Error(`${label} must be positive, whole, and strictly ascending.`);
  }
}
