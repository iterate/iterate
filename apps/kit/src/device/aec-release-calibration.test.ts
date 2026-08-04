import { describe, expect, it } from "vitest";
import { validateAecReleaseCalibration } from "./aec-release-calibration.ts";

const validCalibration = {
  artifactDirectory: "evidence/havpe/calibration-2026-08-04",
  calibratedAt: "2026-08-04T09:00:00.000Z",
  codecDrive: { decibels: 0, kind: "aic3204-dac-decibels" as const },
  deviceId: "home-assistant-voice-preview-edition" as const,
  exactMac: "D8:3B:DA:46:20:34",
  levels: {
    "maximum-non-clipping": {
      pcmPeakAmplitude: 6_000,
      playoutClippedSamples: 0,
      rawMicClippedSamples: 0,
      sourceClippedSamples: 0,
    },
    nominal: {
      pcmPeakAmplitude: 4_000,
      playoutClippedSamples: 0,
      rawMicClippedSamples: 0,
      sourceClippedSamples: 0,
    },
    quiet: {
      pcmPeakAmplitude: 2_000,
      playoutClippedSamples: 0,
      rawMicClippedSamples: 0,
      sourceClippedSamples: 0,
    },
  },
  maximumBoundary: {
    nextRejectedAmplitude: 7_000,
    nextRejectedClippedSamples: 17,
    safetyCeilingReached: false,
  },
  nearLevels: {
    loud: {
      macOutputVolumePercent: 40,
      sourceClippedSamples: 0,
    },
    nominal: {
      macOutputVolumePercent: 30,
      sourceClippedSamples: 0,
    },
    quiet: {
      macOutputVolumePercent: 20,
      sourceClippedSamples: 0,
    },
  },
};

describe("AEC physical drive calibration", () => {
  it("accepts three monotonic, artifact-backed effective speaker levels", () => {
    /*
     * HAVPE and StackChan do not expose the same codec control. The comparable
     * quantity is therefore effective PCM drive at a recorded fixed hardware
     * gain. This fixture proves the shared quiet/nominal/maximum semantics can
     * retain target-specific calibration without changing the matrix itself.
     */
    expect(
      validateAecReleaseCalibration(validCalibration, {
        expectedDeviceId: "home-assistant-voice-preview-edition",
        expectedMac: "D8:3B:DA:46:20:34",
      }),
    ).toEqual(validCalibration);
  });

  it("rejects a claimed maximum which has neither a clipped next step nor a reviewed ceiling", () => {
    /*
     * Picking the loudest convenient fixture is not calibrating the highest
     * non-clipping operational level. The boundary needs an observed rejected
     * candidate or an explicit safety ceiling, otherwise the hardest far-end
     * condition can be silently omitted while retaining a persuasive label.
     */
    expect(() =>
      validateAecReleaseCalibration(
        {
          ...validCalibration,
          maximumBoundary: {
            nextRejectedAmplitude: null,
            nextRejectedClippedSamples: 0,
            safetyCeilingReached: false,
          },
        },
        {
          expectedDeviceId: "home-assistant-voice-preview-edition",
          expectedMac: "D8:3B:DA:46:20:34",
        },
      ),
    ).toThrow(/highest non-clipping boundary/u);
  });

  it("rejects identity drift, accepted clipping, and non-monotonic levels", () => {
    /*
     * A USB path is not a device identity and a profile copied between boards
     * is unsafe. Likewise, a clipped accepted level or nominal drive above the
     * alleged maximum invalidates every downstream ERLE/distortion comparison.
     */
    expect(() =>
      validateAecReleaseCalibration(
        { ...validCalibration, exactMac: "68:EE:8F:D8:53:20" },
        {
          expectedDeviceId: "home-assistant-voice-preview-edition",
          expectedMac: "D8:3B:DA:46:20:34",
        },
      ),
    ).toThrow(/MAC/u);
    expect(() =>
      validateAecReleaseCalibration(
        {
          ...validCalibration,
          levels: {
            ...validCalibration.levels,
            nominal: {
              ...validCalibration.levels.nominal,
              pcmPeakAmplitude: 7_000,
              rawMicClippedSamples: 1,
            },
          },
        },
        {
          expectedDeviceId: "home-assistant-voice-preview-edition",
          expectedMac: "D8:3B:DA:46:20:34",
        },
      ),
    ).toThrow(/clipping|monotonic/u);
  });

  it("rejects a codec drive copied from the other target", () => {
    /*
     * HAVPE's AIC3204 uses a fixed DAC register gain while StackChan exposes a
     * codec-volume percentage backed by its own PA compensation curve. Calling
     * both values “90%” hid a materially different electrical boundary. The
     * matrix may compare calibrated acoustic levels, but it must retain which
     * target-specific hardware control actually produced them.
     */
    expect(() =>
      validateAecReleaseCalibration(
        {
          ...validCalibration,
          codecDrive: { kind: "esp-codec-volume-percent", percent: 90 },
        },
        {
          expectedDeviceId: "home-assistant-voice-preview-edition",
          expectedMac: "D8:3B:DA:46:20:34",
        },
      ),
    ).toThrow(/codec drive/u);
  });

  it("requires monotonic, unclipped Mac near-end levels", () => {
    /*
     * A double-talk matrix which labels nearby speech quiet/nominal/loud but
     * changes only the device-speaker PCM is not exercising the requested
     * relative near/far corners. Pin the independently calibrated Mac output
     * control here so every physical phase can retain the exact near drive.
     */
    expect(() =>
      validateAecReleaseCalibration(
        {
          ...validCalibration,
          nearLevels: {
            ...validCalibration.nearLevels,
            nominal: {
              macOutputVolumePercent: 20,
              sourceClippedSamples: 0,
            },
          },
        },
        {
          expectedDeviceId: "home-assistant-voice-preview-edition",
          expectedMac: "D8:3B:DA:46:20:34",
        },
      ),
    ).toThrow(/near-end.*monotonic/u);
    expect(() =>
      validateAecReleaseCalibration(
        {
          ...validCalibration,
          nearLevels: {
            ...validCalibration.nearLevels,
            loud: {
              macOutputVolumePercent: 40,
              sourceClippedSamples: 1,
            },
          },
        },
        {
          expectedDeviceId: "home-assistant-voice-preview-edition",
          expectedMac: "D8:3B:DA:46:20:34",
        },
      ),
    ).toThrow(/near-end.*clipped/u);
  });
});
