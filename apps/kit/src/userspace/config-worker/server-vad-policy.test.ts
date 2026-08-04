import { describe, expect, test } from "vitest";
import { kitDeviceServerVadPolicy, kitDeviceServerVadProfile } from "./server-vad-policy.ts";

describe("userspace server-VAD device policy", () => {
  test("keeps measured platform gain differences explicit", () => {
    /*
     * Turn ownership is shared—both devices are continuous AEC sources—but
     * their DSP output levels are not. StackChan now publishes full-level raw
     * mic when its exact speaker reference is silent and applies its measured
     * AEC gain on-device only to speaker-active processed audio. A userspace
     * multiplier would clip the healthy raw branch; HAVPE's selected
     * XMOS NS tap needs its separately measured gain before that same
     * threshold can hear ordinary speech. The first reply at ×16 produced an
     * exact self-transcript, so the predeclared next rung is ×8 while keeping
     * provider VAD at its measured 0.1 floor. A named profile preserves one common
     * bridge while making this real hardware boundary reviewable and
     * independently tunable. Physical acceptance still rejects any speaker-
     * only speech edge: this test pins a candidate envelope, not proof of AEC.
     */
    expect(kitDeviceServerVadProfile("stackchan")).toBe("low-level-aec");
    expect(kitDeviceServerVadProfile("home-assistant-voice-preview-edition")).toBe("xmos-aec");
    expect(kitDeviceServerVadPolicy("home-assistant-voice-preview-edition")).toEqual({
      serverVadProfile: "xmos-aec",
      uplinkGainMultiplier: 8,
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
