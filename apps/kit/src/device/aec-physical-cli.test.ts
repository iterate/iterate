import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAecPhysicalCliOptions } from "../../scripts/prove-local-aec.ts";

describe("physical AEC acquisition CLI", () => {
  it("selects measured calibration acquisition through the ordinary authenticated rig", () => {
    /*
     * Calibration must not grow a second fixture server which bypasses the
     * same Cap'n Web identity, /pcm proxy, recorder, or network attribution as
     * the release matrix. This parser fixture pins calibration to the ordinary
     * physical runner and only changes its bounded experiment controller.
     */
    expect(
      parseAecPhysicalCliOptions(
        [
          "--device",
          "home-assistant-voice-preview-edition",
          "--calibration-output",
          "evidence/calibration/havpe.json",
          "--direct-lan-host",
          "192.168.0.10",
        ],
        {},
      ),
    ).toEqual(
      expect.objectContaining({
        calibrationOutput: resolve("evidence/calibration/havpe.json"),
        directLanHost: "192.168.0.10",
        fixtureBundle: undefined,
      }),
    );
  });

  it("refuses ambiguous calibration and release-matrix controllers", () => {
    /*
     * A calibration sweep consumes a different deterministic response plan.
     * Running it beside a bundle would mislabel phase indices and could turn
     * the first matrix source into a supposed volume boundary observation.
     */
    expect(() =>
      parseAecPhysicalCliOptions(
        [
          "--calibration-output",
          "evidence/calibration/stackchan.json",
          "--fixture-bundle",
          "evidence/fixtures/stackchan",
          "--direct-lan-host",
          "192.168.0.10",
        ],
        {},
      ),
    ).toThrow(/mutually exclusive/u);
  });
});
