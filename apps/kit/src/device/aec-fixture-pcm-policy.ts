import type { DevicePcmDownlinkDeliveryMode } from "../voice/device-pcm-proxy.ts";

export interface AecFixturePcmPolicy {
  deviceClockedInitialBurstFrames: number;
  downlinkDeliveryMode: DevicePcmDownlinkDeliveryMode;
  minimumDownlinkStartupFrames: number;
}

/**
 * The physical AEC rig must exercise the same ownership model as userspace.
 *
 * Host-paced mode treats the deliberate provider outage as a fatal host clock
 * miss and closes before the ESP can demonstrate bounded underrun recovery.
 * Device-clocked mode keeps the Mac as a bounded source/rechunker while I2S is
 * authoritative for audible time. The 32-frame source watermark absorbs host
 * packet jitter, but only eight frames cross in the initial device burst, so a
 * large readiness reservoir is not silently converted into ESP latency.
 */
export const aecFixturePcmPolicy: AecFixturePcmPolicy = Object.freeze({
  deviceClockedInitialBurstFrames: 8,
  downlinkDeliveryMode: "device-clocked",
  minimumDownlinkStartupFrames: 32,
});
