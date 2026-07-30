import { describe, expect, test } from "vitest";
import { assessPlaybackRecoveryAcoustics } from "./playback-recovery-acoustic-policy.ts";

describe("bounded recovery acoustic policy", () => {
  test("accepts a full-span recording whose silence is explained by recovered frame slots", () => {
    /*
     * Recovery deliberately emits silence, so the zero-gap endurance oracle
     * must fail this same artifact. The diagnostic proof still has an acoustic
     * obligation: output must resume and reach the expected final wall time,
     * while missing tone cannot exceed the exact recovered slots plus bounded
     * room/window uncertainty.
     */
    expect(
      assessPlaybackRecoveryAcoustics({
        expectedDurationMs: 10_000,
        frameDurationMs: 20,
        longestInternalGapMs: 40,
        maximumDurationErrorMs: 200,
        maximumUnattributedMissingToneMs: 20,
        missingToneMs: 175,
        observedSpanMs: 10_005,
        recoveryFrameCount: 8,
      }),
    ).toEqual({
      kind: "healthy",
      maximumExplainedMissingToneMs: 180,
    });
  });

  test("rejects an early stop even when digital recovery counters conserve frames", () => {
    /*
     * Equal silence/drop counters alone cannot prove the speaker remained
     * audible after the incident. A short observed span is the independent
     * Mac-microphone evidence that playback died rather than riding through.
     */
    expect(
      assessPlaybackRecoveryAcoustics({
        expectedDurationMs: 10_000,
        frameDurationMs: 20,
        longestInternalGapMs: 40,
        maximumDurationErrorMs: 200,
        maximumUnattributedMissingToneMs: 20,
        missingToneMs: 8_000,
        observedSpanMs: 2_000,
        recoveryFrameCount: 8,
      }),
    ).toMatchObject({
      kind: "failure",
      reasons: expect.arrayContaining([
        "observed tone span 2000 ms differs from expected 10000 ms by 8000 ms",
        "missing tone 8000 ms exceeds the recovery-accounted maximum 180 ms",
      ]),
    });
  });
});
