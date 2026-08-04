import type { GrokServerVadProfile } from "./providers.ts";

export interface KitDeviceServerVadPolicy {
  serverVadProfile: GrokServerVadProfile;
  uplinkGainMultiplier: number;
}

/**
 * Selects the measured input-level contract for continuous-AEC hardware.
 *
 * Audio mode answers who owns turn boundaries; it does not describe the level
 * produced by a board's DSP chain. A network-valid StackChan run delivered
 * 4,794 residual-suppressed frames to xAI at peak 479/RMS 43 and produced no
 * speech edge. Replaying that PCM proved ×8 was required for that processed
 * branch. StackChan now applies the ×8 calibration only while speaker audio
 * requires AEC and publishes the full-level raw mic while the reference is
 * silent; a second global ×8 here would clip ordinary near-only speech.
 *
 * Gain is not AEC. Retained real speaker-only PCM from an older firmware did
 * false-trigger at only ×4, so every physical acceptance run must still reject
 * speaker-only provider speech edges and measure double-talk. This calibration
 * deliberately makes that latent defect observable; it cannot turn a failed
 * echo test into a pass. The less-destructive on-device NLP policy is measured
 * separately before this value is considered settled.
 *
 * HAVPE's cumulative XMOS NS tap has a separate envelope. Two native-level NS
 * runs peaked at 557 and 581 and produced no xAI VAD edges. A retained ×16
 * production run heard three deliberate utterances, but a fresh short reply
 * exposed the missing onset gate: Grok opened a second turn and transcribed its
 * own exact words. The same-boot signal census measured only about 7–8 dB of
 * settled NS suppression, so ×16 amplifies valid near speech and the remaining
 * echo into the same VAD envelope.
 *
 * Halving to ×8 is the review's predeclared failure-mode-A rung, not a relaxed
 * oracle: threshold remains at xAI's measured 0.1 floor, every speaker-only
 * edge remains a failure, and the next physical run must still prove that a
 * complete nearby prompt endpoints. An older ×8 AEC-tap run did open exactly
 * one provider turn and complete a reply, although it cut a longer fixture
 * prompt 1.331 seconds early. That makes ×8 a bounded candidate rather than a
 * settled policy; if NS ×8 is deaf or still echoes, gain tuning is exhausted
 * and the residual-echo architecture must change.
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
    return { serverVadProfile: "xmos-aec", uplinkGainMultiplier: 8 };
  }
  return null;
}

/** Retains the evidence-facing profile name while policy gains another axis. */
export function kitDeviceServerVadProfile(deviceId: string): GrokServerVadProfile | null {
  return kitDeviceServerVadPolicy(deviceId)?.serverVadProfile ?? null;
}
