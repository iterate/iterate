import { z } from "zod";
import type { AecReleaseDevice } from "./aec-release-matrix.ts";

const nonnegativeCounter = z.number().int().nonnegative().safe();
const acceptedLevelSchema = z.strictObject({
  pcmPeakAmplitude: z.number().int().min(1).max(32_767),
  playoutClippedSamples: nonnegativeCounter,
  rawMicClippedSamples: nonnegativeCounter,
  sourceClippedSamples: nonnegativeCounter,
});
const acceptedNearLevelSchema = z.strictObject({
  macOutputVolumePercent: z.number().int().min(1).max(100),
  sourceClippedSamples: nonnegativeCounter,
});
const codecDriveSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    decibels: z.number().min(-63.5).max(24).multipleOf(0.5),
    kind: z.literal("aic3204-dac-decibels"),
  }),
  z.strictObject({
    kind: z.literal("esp-codec-volume-percent"),
    percent: z.number().int().min(1).max(100),
  }),
]);
const calibrationSchema = z.strictObject({
  artifactDirectory: z.string().min(1),
  calibratedAt: z.iso.datetime(),
  codecDrive: codecDriveSchema,
  deviceId: z.enum(["home-assistant-voice-preview-edition", "stackchan"]),
  exactMac: z.string().regex(/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/u),
  levels: z.strictObject({
    "maximum-non-clipping": acceptedLevelSchema,
    nominal: acceptedLevelSchema,
    quiet: acceptedLevelSchema,
  }),
  maximumBoundary: z.strictObject({
    nextRejectedAmplitude: z.number().int().min(1).max(32_767).nullable(),
    nextRejectedClippedSamples: nonnegativeCounter,
    safetyCeilingReached: z.boolean(),
  }),
  nearLevels: z.strictObject({
    loud: acceptedNearLevelSchema,
    nominal: acceptedNearLevelSchema,
    quiet: acceptedNearLevelSchema,
  }),
});

export type AecReleaseCalibration = z.infer<typeof calibrationSchema>;

/**
 * Validates the measured transducer boundary before a release matrix can run.
 *
 * “Volume” means effective device-speaker drive: a PCM peak at an explicitly
 * retained fixed codec gain. This is the only control shared by HAVPE and
 * StackChan. Treating unlike codec percentages as comparable would be false
 * precision; target-specific acoustic measurements remain in the artifact
 * directory while the quiet/nominal/maximum ordering remains shared policy.
 */
export function validateAecReleaseCalibration(
  value: unknown,
  expected: { expectedDeviceId: AecReleaseDevice; expectedMac: string },
): AecReleaseCalibration {
  const calibration = calibrationSchema.parse(value);
  if (calibration.deviceId !== expected.expectedDeviceId) {
    throw new Error(
      `AEC calibration device ${calibration.deviceId} does not match ${expected.expectedDeviceId}.`,
    );
  }
  if (calibration.exactMac !== expected.expectedMac.toUpperCase()) {
    throw new Error(
      `AEC calibration MAC ${calibration.exactMac} does not match exact device ${expected.expectedMac}.`,
    );
  }
  const expectedCodecDrive =
    calibration.deviceId === "home-assistant-voice-preview-edition"
      ? { decibels: 0, kind: "aic3204-dac-decibels" as const }
      : { kind: "esp-codec-volume-percent" as const, percent: 90 };
  if (
    calibration.codecDrive.kind !== expectedCodecDrive.kind ||
    (calibration.codecDrive.kind === "aic3204-dac-decibels"
      ? calibration.codecDrive.decibels !== expectedCodecDrive.decibels
      : calibration.codecDrive.percent !== expectedCodecDrive.percent)
  ) {
    throw new Error(
      `AEC calibration codec drive ${JSON.stringify(calibration.codecDrive)} does not match ` +
        `${calibration.deviceId} firmware drive ${JSON.stringify(expectedCodecDrive)}.`,
    );
  }

  const { levels } = calibration;
  if (
    levels.quiet.pcmPeakAmplitude >= levels.nominal.pcmPeakAmplitude ||
    levels.nominal.pcmPeakAmplitude >= levels["maximum-non-clipping"].pcmPeakAmplitude
  ) {
    throw new Error("AEC quiet, nominal, and maximum drive levels must be strictly monotonic.");
  }
  for (const [name, level] of Object.entries(levels)) {
    const clippedSamples =
      level.sourceClippedSamples + level.playoutClippedSamples + level.rawMicClippedSamples;
    if (clippedSamples > 0) {
      throw new Error(
        `Accepted AEC drive level ${name} observed ${clippedSamples} clipped samples.`,
      );
    }
  }

  const maximumAmplitude = levels["maximum-non-clipping"].pcmPeakAmplitude;
  const boundary = calibration.maximumBoundary;
  const rejectedCandidateProvesBoundary =
    boundary.nextRejectedAmplitude !== null &&
    boundary.nextRejectedAmplitude > maximumAmplitude &&
    boundary.nextRejectedClippedSamples > 0;
  if (!boundary.safetyCeilingReached && !rejectedCandidateProvesBoundary) {
    throw new Error(
      "AEC maximum level has no proven highest non-clipping boundary: retain a clipped next " +
        "candidate or record that the reviewed safety ceiling was reached.",
    );
  }

  const { nearLevels } = calibration;
  if (
    nearLevels.quiet.macOutputVolumePercent >= nearLevels.nominal.macOutputVolumePercent ||
    nearLevels.nominal.macOutputVolumePercent >= nearLevels.loud.macOutputVolumePercent
  ) {
    throw new Error("AEC quiet, nominal, and loud near-end levels must be strictly monotonic.");
  }
  for (const [name, level] of Object.entries(nearLevels)) {
    if (level.sourceClippedSamples > 0) {
      throw new Error(
        `Accepted AEC near-end level ${name} observed ${level.sourceClippedSamples} clipped samples.`,
      );
    }
  }
  return calibration;
}
