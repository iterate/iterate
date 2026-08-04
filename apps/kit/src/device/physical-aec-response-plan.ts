export type PhysicalAecResponseRole =
  | "double-talk-dual-carrier-prbs31"
  | "far-dual-carrier-prbs31"
  | "far-speech-shaped"
  | "far-tone"
  | "near-path-pilot"
  | "near-repeat-path-pilot";

/*
 * The deterministic provider receives only a response ordinal. Treating every
 * later ordinal as the double-talk PRBS previously hid a missing phase behind
 * plausible audio. This tuple is the physical experiment's protocol: the
 * near-path pilot deliberately sits after far-only calibration and before
 * double-talk so XMOS sees an active reference in both nearby-speech captures.
 */
const responseRoles: readonly PhysicalAecResponseRole[] = Object.freeze([
  "far-tone",
  "far-dual-carrier-prbs31",
  "far-speech-shaped",
  "near-path-pilot",
  "near-repeat-path-pilot",
  "double-talk-dual-carrier-prbs31",
]);

export function physicalAecResponseRole(responseIndex: number): PhysicalAecResponseRole {
  if (!Number.isSafeInteger(responseIndex) || responseIndex < 0) {
    throw new Error(`Unmodelled physical AEC response index ${responseIndex}.`);
  }
  const role = responseRoles[responseIndex];
  if (!role) throw new Error(`Unmodelled physical AEC response index ${responseIndex}.`);
  return role;
}
