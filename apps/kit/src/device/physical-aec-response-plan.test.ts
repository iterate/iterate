import { describe, expect, test } from "vitest";
import { physicalAecResponseRole } from "./physical-aec-response-plan.ts";

describe("physical AEC provider response plan", () => {
  test("keeps a matched-path pilot between far-only calibration and double-talk", () => {
    /*
     * XMOS's alternate architecture disables AEC and enables IC after its
     * reference has been absent for three seconds. Recording the nearby voice
     * during that state and comparing it with AEC-active double-talk produced
     * a convincing but invalid waveform mismatch. The quiet pilot is a real
     * protocol phase, not incidental timing: pin its position immediately
     * before double-talk so future stimulus edits cannot reintroduce the
     * unequal-DSP-path oracle.
     */
    expect(Array.from({ length: 6 }, (_, index) => physicalAecResponseRole(index))).toEqual([
      "far-tone",
      "far-dual-carrier-prbs31",
      "far-speech-shaped",
      "near-path-pilot",
      "near-repeat-path-pilot",
      "double-talk-dual-carrier-prbs31",
    ]);
  });

  test("fails closed if the harness requests an unmodelled response", () => {
    expect(() => physicalAecResponseRole(6)).toThrow("Unmodelled physical AEC response index 6");
    expect(() => physicalAecResponseRole(-1)).toThrow("Unmodelled physical AEC response index -1");
  });
});
