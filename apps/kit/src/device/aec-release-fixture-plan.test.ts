import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderPcm16Le } from "../voice/deterministic-pcm-renderers.ts";
import {
  createAecReleaseFixturePlan,
  createAecReleaseFixtureRenderer,
} from "./aec-release-fixture-plan.ts";
import { aecReleaseMatrixPhaseIds } from "./aec-release-matrix.ts";

const calibration = {
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
    loud: { macOutputVolumePercent: 40, sourceClippedSamples: 0 },
    nominal: { macOutputVolumePercent: 30, sourceClippedSamples: 0 },
    quiet: { macOutputVolumePercent: 20, sourceClippedSamples: 0 },
  },
};

describe("AEC release fixture plan", () => {
  it("materializes every shared phase without target-local phase selection", () => {
    /*
     * A matrix existing only as prose allowed the short HAVPE runner to omit
     * volume corners and lifecycle cases while still producing persuasive
     * evidence. The executable plan must be a lossless projection of the one
     * shared matrix: adapters may perform a declared lifecycle action, but no
     * target gets to invent or skip its own phase list.
     */
    const plan = createAecReleaseFixturePlan(calibration, {
      expectedDeviceId: "home-assistant-voice-preview-edition",
      expectedMac: "D8:3B:DA:46:20:34",
      runId: "release-plan-test",
    });

    expect(plan.phases.map((phase) => phase.id)).toEqual(aecReleaseMatrixPhaseIds());
    expect(plan.phases.filter((phase) => phase.farSource !== null)).toHaveLength(28);
    expect(plan.phases.filter((phase) => phase.nearSource !== null)).toHaveLength(6);
    expect(
      plan.phases.find((phase) => phase.id === "double-talk-far-loud-near-quiet"),
    ).toMatchObject({
      farSource: { kind: "retained-speech", peakAmplitude: 6_000, sourceId: "far-voice" },
      nearSource: { macOutputVolumePercent: 20 },
    });
    expect(
      plan.phases
        .filter(
          (phase) =>
            phase.farSource !== null &&
            (phase.id.includes("speech") || phase.scenario === "double-talk"),
        )
        .every((phase) => phase.farSource?.kind === "retained-speech"),
    ).toBe(true);
    expect(
      plan.phases.find((phase) => phase.id === "lifecycle-playback-underrun-recovery"),
    ).toMatchObject({
      lifecycleAction: "playback-underrun-recovery",
      sourcePauses: [{ afterSamples: 80_000, durationMs: 250 }],
    });
    expect(
      plan.phases
        .filter((phase) => phase.id !== "lifecycle-playback-underrun-recovery")
        .every((phase) => phase.sourcePauses.length === 0),
    ).toBe(true);
  });

  it("produces chunk-invariant, bounded bytes from retained phase metadata", () => {
    /*
     * The Mac server must be able to reconstruct byte-identical playback from
     * the evidence manifest. Rendering the same declared phase with hostile
     * chunk sizes catches hidden state tied to WebSocket packet boundaries;
     * checking the calibrated peak prevents a generator coefficient from
     * silently exceeding the physical volume boundary.
     */
    const plan = createAecReleaseFixturePlan(calibration, {
      expectedDeviceId: "home-assistant-voice-preview-edition",
      expectedMac: "D8:3B:DA:46:20:34",
      runId: "release-plan-test",
    });
    const hashes = new Set<string>();
    for (const phase of plan.phases) {
      if (!phase.farSource) continue;
      if (phase.farSource.kind === "retained-speech") continue;
      const samples = Math.min(16_003, (phase.durationMs * plan.sampleRateHz) / 1_000);
      const whole = renderPcm16Le(
        createAecReleaseFixtureRenderer(phase.farSource),
        samples,
        samples,
      );
      const split = renderPcm16Le(createAecReleaseFixtureRenderer(phase.farSource), samples, 487);
      expect(split).toEqual(whole);
      const view = new DataView(whole.buffer, whole.byteOffset, whole.byteLength);
      let peak = 0;
      for (let offset = 0; offset < whole.byteLength; offset += 2) {
        peak = Math.max(peak, Math.abs(view.getInt16(offset, true)));
      }
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(phase.farSource.peakAmplitude);
      hashes.add(createHash("sha256").update(whole).digest("hex"));
    }
    expect(hashes.size).toBeGreaterThan(8);
  });
});
