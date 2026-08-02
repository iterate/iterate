import type { GrokServerVadProfile } from "./providers.ts";

export interface KitDeviceServerVadPolicy {
  serverVadProfile: GrokServerVadProfile;
  uplinkGainMultiplier: number;
}

/**
 * Selects the measured input-level contract for continuous-AEC hardware.
 *
 * Audio mode answers who owns turn boundaries; it does not describe the level
 * produced by a board's DSP chain. StackChan currently sends a usable
 * low-level AEC stream. Two native-level HAVPE NS runs peaked at 557 and 581
 * respectively and produced no xAI VAD edges, even at the supported 0.1
 * floor. Its final AGC tap was louder but audibly retriggered VAD with its own
 * speaker. Fixed ×16 places measured speech around the proven trigger envelope
 * while measured NS residual remains below it; it preserves the useful tap
 * without reintroducing an adaptive stage whose gain follows speaker content.
 *
 * The identity mapping is deliberately closed for now. Once the device
 * capability contract advertises a stable input-level profile, this function
 * becomes validation of that negotiated value rather than a device table.
 * Until then, returning null for unknown hardware is safer than guessing a
 * threshold that can stream private room audio indefinitely.
 */
export function kitDeviceServerVadPolicy(deviceId: string): KitDeviceServerVadPolicy | null {
  if (deviceId === "stackchan") {
    return { serverVadProfile: "low-level-aec", uplinkGainMultiplier: 1 };
  }
  if (deviceId === "home-assistant-voice-preview-edition") {
    return { serverVadProfile: "xmos-aec-ns", uplinkGainMultiplier: 16 };
  }
  return null;
}

/** Retains the evidence-facing profile name while policy gains another axis. */
export function kitDeviceServerVadProfile(deviceId: string): GrokServerVadProfile | null {
  return kitDeviceServerVadPolicy(deviceId)?.serverVadProfile ?? null;
}
