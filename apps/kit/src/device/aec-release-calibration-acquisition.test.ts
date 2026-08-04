import { describe, expect, it } from "vitest";
import {
  composeMeasuredAecReleaseCalibration,
  type MeasuredAecDriveCandidate,
} from "./aec-release-calibration-acquisition.ts";

const accepted = (pcmPeakAmplitude: number): MeasuredAecDriveCandidate => ({
  pcmPeakAmplitude,
  playoutClippedSamples: 0,
  rawMicClippedSamples: 0,
  sourceClippedSamples: 0,
});

describe("measured AEC release calibration", () => {
  it("selects three separated accepted levels and retains a reviewed operational ceiling", () => {
    /*
     * A fixed codec gain plus three arbitrary labels is not a calibration. The
     * physical runner steps every candidate and this pure composer chooses the
     * lower, middle, and highest observed safe controls. Keeping the complete
     * measurements makes that selection independently auditable offline.
     */
    const result = composeMeasuredAecReleaseCalibration({
      artifactDirectory: "evidence/havpe/calibration",
      calibratedAt: "2026-08-04T10:00:00.000Z",
      codecDrive: { decibels: 0, kind: "aic3204-dac-decibels" },
      deviceId: "home-assistant-voice-preview-edition",
      driveCandidates: [accepted(1_500), accepted(3_000), accepted(6_000), accepted(12_000)],
      exactMac: "D8:3B:DA:46:20:34",
      nearCandidates: [
        { macOutputVolumePercent: 15, rawMicClippedSamples: 0, sourceClippedSamples: 0 },
        { macOutputVolumePercent: 25, rawMicClippedSamples: 0, sourceClippedSamples: 0 },
        { macOutputVolumePercent: 35, rawMicClippedSamples: 0, sourceClippedSamples: 0 },
      ],
      reviewedSafetyCeilingAmplitude: 12_000,
    });

    expect(result.calibration.levels.quiet.pcmPeakAmplitude).toBe(1_500);
    expect(result.calibration.levels.nominal.pcmPeakAmplitude).toBe(3_000);
    expect(result.calibration.levels["maximum-non-clipping"].pcmPeakAmplitude).toBe(12_000);
    expect(result.calibration.maximumBoundary).toEqual({
      nextRejectedAmplitude: null,
      nextRejectedClippedSamples: 0,
      safetyCeilingReached: true,
    });
    expect(result.measurements.driveCandidates).toHaveLength(4);
  });

  it("retains the first clipped next step and refuses non-contiguous evidence", () => {
    /*
     * Once clipping is observed, a later clean result is not a reason to skip
     * the failure: it means the acquisition or ordering is incoherent. This
     * prevents cherry-picking a persuasive maximum out of a noisy sweep.
     */
    const clipped = { ...accepted(9_000), rawMicClippedSamples: 4 };
    expect(
      composeMeasuredAecReleaseCalibration({
        artifactDirectory: "evidence/stackchan/calibration",
        calibratedAt: "2026-08-04T10:00:00.000Z",
        codecDrive: { kind: "esp-codec-volume-percent", percent: 90 },
        deviceId: "stackchan",
        driveCandidates: [accepted(1_500), accepted(3_000), accepted(6_000), clipped],
        exactMac: "68:EE:8F:D8:53:20",
        nearCandidates: [
          { macOutputVolumePercent: 15, rawMicClippedSamples: 0, sourceClippedSamples: 0 },
          { macOutputVolumePercent: 25, rawMicClippedSamples: 0, sourceClippedSamples: 0 },
          { macOutputVolumePercent: 35, rawMicClippedSamples: 0, sourceClippedSamples: 0 },
        ],
        reviewedSafetyCeilingAmplitude: 12_000,
      }).calibration.maximumBoundary,
    ).toEqual({
      nextRejectedAmplitude: 9_000,
      nextRejectedClippedSamples: 4,
      safetyCeilingReached: false,
    });

    expect(() =>
      composeMeasuredAecReleaseCalibration({
        artifactDirectory: "evidence/stackchan/calibration",
        calibratedAt: "2026-08-04T10:00:00.000Z",
        codecDrive: { kind: "esp-codec-volume-percent", percent: 90 },
        deviceId: "stackchan",
        driveCandidates: [accepted(1_500), accepted(3_000), clipped, accepted(12_000)],
        exactMac: "68:EE:8F:D8:53:20",
        nearCandidates: [
          { macOutputVolumePercent: 15, rawMicClippedSamples: 0, sourceClippedSamples: 0 },
          { macOutputVolumePercent: 25, rawMicClippedSamples: 0, sourceClippedSamples: 0 },
          { macOutputVolumePercent: 35, rawMicClippedSamples: 0, sourceClippedSamples: 0 },
        ],
        reviewedSafetyCeilingAmplitude: 12_000,
      }),
    ).toThrow(/after clipping/u);
  });

  it("refuses fewer than three safe drive or near-source levels", () => {
    /*
     * The release matrix explicitly exercises quiet, nominal, and loud
     * relative corners. Reusing one measurement under three names would make
     * the difficult corners fictional, so incomplete calibration fails before
     * the much longer physical matrix starts.
     */
    expect(() =>
      composeMeasuredAecReleaseCalibration({
        artifactDirectory: "evidence/havpe/calibration",
        calibratedAt: "2026-08-04T10:00:00.000Z",
        codecDrive: { decibels: 0, kind: "aic3204-dac-decibels" },
        deviceId: "home-assistant-voice-preview-edition",
        driveCandidates: [
          accepted(1_500),
          accepted(3_000),
          { ...accepted(6_000), playoutClippedSamples: 1 },
        ],
        exactMac: "D8:3B:DA:46:20:34",
        nearCandidates: [
          { macOutputVolumePercent: 15, rawMicClippedSamples: 0, sourceClippedSamples: 0 },
          { macOutputVolumePercent: 25, rawMicClippedSamples: 1, sourceClippedSamples: 0 },
          { macOutputVolumePercent: 35, rawMicClippedSamples: 0, sourceClippedSamples: 0 },
        ],
        reviewedSafetyCeilingAmplitude: 12_000,
      }),
    ).toThrow(/three unclipped/u);
  });
});
