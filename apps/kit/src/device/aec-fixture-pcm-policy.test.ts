import { expect, it } from "vitest";
import { aecFixturePcmPolicy } from "./aec-fixture-pcm-policy.ts";

it("keeps deterministic AEC on one production-shaped device-clocked policy", () => {
  /*
   * The old harness inherited the proxy's host-paced default. Its intentional
   * source-pause row consequently tested a JavaScript timer and failed before
   * the device could see an outage. Pin one shared policy so neither hardware
   * target can drift back to that false experiment.
   */
  expect(aecFixturePcmPolicy).toEqual({
    deviceClockedInitialBurstFrames: 8,
    downlinkDeliveryMode: "device-clocked",
    minimumDownlinkStartupFrames: 32,
  });
  expect(aecFixturePcmPolicy.deviceClockedInitialBurstFrames).toBeLessThanOrEqual(
    aecFixturePcmPolicy.minimumDownlinkStartupFrames,
  );
});
