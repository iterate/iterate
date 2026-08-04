import { describe, expect, test } from "vitest";
import {
  quietPhysicalAecAcousticProfile,
  validatePhysicalAecAcousticProfile,
} from "./physical-aec-acoustic-profile.ts";

describe("physical AEC acoustic profile", () => {
  test("keeps the shared unattended fixture inside the residential-test ceilings", () => {
    expect(quietPhysicalAecAcousticProfile).toEqual({
      macOutputVolumePercent: 40,
      matchedPathPilotAmplitude: 64,
      prbsCarrierAmplitude: 2_250,
      speechRendererAmplitude: 2_250,
      toneAmplitude: 4_500,
    });
    expect(Object.isFrozen(quietPhysicalAecAcousticProfile)).toBe(true);
  });

  test.each([
    ["macOutputVolumePercent", 41],
    ["matchedPathPilotAmplitude", 257],
    ["prbsCarrierAmplitude", 3_001],
    ["speechRendererAmplitude", 3_001],
    ["toneAmplitude", 6_001],
  ] as const)("rejects an unsafe %s before any physical playback", (name, value) => {
    expect(() =>
      validatePhysicalAecAcousticProfile({
        ...quietPhysicalAecAcousticProfile,
        [name]: value,
      }),
    ).toThrow(`Physical AEC ${name}`);
  });
});
