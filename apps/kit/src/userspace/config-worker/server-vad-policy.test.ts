import { describe, expect, test } from "vitest";
import { kitDeviceServerVadPolicy, kitDeviceServerVadProfile } from "./server-vad-policy.ts";

describe("userspace server-VAD device policy", () => {
  test("keeps measured platform gain differences explicit", () => {
    /*
     * Turn ownership is shared—both devices are continuous AEC sources—but
     * their DSP output levels are not. StackChan's measured low-level stream
     * needs the 0.1 provider calibration; HAVPE's XMOS AEC+IC+NS stream
     * turned that same threshold into an unbounded ambient utterance. A named
     * profile preserves one common bridge while making this real hardware
     * boundary reviewable and independently tunable.
     */
    expect(kitDeviceServerVadProfile("stackchan")).toBe("low-level-aec");
    expect(kitDeviceServerVadProfile("home-assistant-voice-preview-edition")).toBe("xmos-aec-ns");
    expect(kitDeviceServerVadPolicy("home-assistant-voice-preview-edition")).toEqual({
      serverVadProfile: "xmos-aec-ns",
      uplinkGainMultiplier: 16,
    });
    expect(kitDeviceServerVadPolicy("stackchan")).toEqual({
      serverVadProfile: "low-level-aec",
      uplinkGainMultiplier: 1,
    });
  });

  test("does not silently guess a VAD calibration for new hardware", () => {
    /*
     * A new full-duplex board with an unknown gain/noise pipeline must fail its
     * authenticated handshake until measured. Guessing either existing value
     * can produce a deaf device or a permanently open, billable provider turn.
     */
    expect(kitDeviceServerVadProfile("future-voice-board")).toBeNull();
    expect(kitDeviceServerVadPolicy("future-voice-board")).toBeNull();
  });
});
