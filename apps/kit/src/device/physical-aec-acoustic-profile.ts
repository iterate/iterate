export interface PhysicalAecAcousticProfile {
  macOutputVolumePercent: number;
  matchedPathPilotAmplitude: number;
  prbsCarrierAmplitude: number;
  speechRendererAmplitude: number;
  toneAmplitude: number;
}

/*
 * A physical oracle is allowed to run for minutes; it is not allowed to turn
 * an unattended regression run into an unexpectedly loud room alarm. The
 * previous fixture drove clipped speech-shaped PCM at Mac volume 90 and a
 * broadband PRBS carrier at 9,175. That combination was heard as extremely
 * loud static in the next room. The broadband device stimuli therefore remain
 * heavily attenuated. The Mac lane now contains intelligible synthesized
 * speech rather than noise, and 20% left its captured clean signal only about
 * 15 dB above ambient—too little to prove a -12 dB double-talk residual. Its
 * retained HAVPE 35% run then supplied 17.64 dB of measurement headroom, but a
 * later StackChan run at 30% measured only 4.6 dB above ambient. The shared
 * fixture therefore uses the existing reviewed 40% ceiling: still less than
 * half the former 85–90% setting, while allowing the oracle to measure rather
 * than guess whether nearby speech survived. Every run must still prove at
 * least 15 dB; macOS's volume scale and two devices' acoustic paths are not
 * assumed linear or equivalent. Device stimuli remain at their attenuated
 * values. These are residential-test ceilings, not AEC tuning targets:
 * exceeding them requires consciously changing this reviewed boundary.
 *
 * The far-end speech value is a renderer coefficient rather than a final PCM peak—the
 * deterministic speech filter applies a 3.6 scale internally. The 3,000 cap
 * was measured to produce a peak around 10,443 and RMS around -20.5 dBFS for
 * the retained six-second fixture. PRBS and tone coefficients are their
 * direct carrier/peak amplitudes.
 */
const ceilings = Object.freeze({
  macOutputVolumePercent: 40,
  matchedPathPilotAmplitude: 256,
  prbsCarrierAmplitude: 3_000,
  speechRendererAmplitude: 3_000,
  toneAmplitude: 6_000,
});

export const quietPhysicalAecAcousticProfile = validatePhysicalAecAcousticProfile({
  macOutputVolumePercent: 40,
  /*
   * XMOS considers a Q31 reference active above -60 dBFS. PCM16 amplitude 64
   * is -54.2 dBFS: enough to retain the AEC path with six decibels of margin,
   * yet more than 37 dB below even this already-quiet PRBS carrier.
   */
  matchedPathPilotAmplitude: 64,
  prbsCarrierAmplitude: 2_250,
  speechRendererAmplitude: 2_250,
  toneAmplitude: 4_500,
});

export function validatePhysicalAecAcousticProfile(
  profile: PhysicalAecAcousticProfile,
): Readonly<PhysicalAecAcousticProfile> {
  const validate = (name: keyof PhysicalAecAcousticProfile, value: number, ceiling: number) => {
    if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
      throw new Error(
        `Physical AEC ${name} must be a positive integer no greater than ${ceiling}; got ${value}.`,
      );
    }
  };
  /*
   * Keep these fields explicit. A cast around Object.entries would make a
   * newly added acoustic control compile while silently skipping validation;
   * duplication here forces every new physical output knob to choose a safety
   * ceiling at the same review point.
   */
  validate(
    "macOutputVolumePercent",
    profile.macOutputVolumePercent,
    ceilings.macOutputVolumePercent,
  );
  validate(
    "matchedPathPilotAmplitude",
    profile.matchedPathPilotAmplitude,
    ceilings.matchedPathPilotAmplitude,
  );
  validate("prbsCarrierAmplitude", profile.prbsCarrierAmplitude, ceilings.prbsCarrierAmplitude);
  validate(
    "speechRendererAmplitude",
    profile.speechRendererAmplitude,
    ceilings.speechRendererAmplitude,
  );
  validate("toneAmplitude", profile.toneAmplitude, ceilings.toneAmplitude);
  return Object.freeze({ ...profile });
}
