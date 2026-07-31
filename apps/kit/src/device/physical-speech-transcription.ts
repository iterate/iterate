const minimumResponseToAmbientMaximumRmsRatio = 2.5;
const minimumRelativeActiveWindows = 4;

export interface PhysicalSpeechTranscriptionAssessment {
  acceptance: "failed" | "independent-stt-provisional";
  normalizedMicrophoneTranscript: string;
  normalizedProviderTranscript: string;
  passed: boolean;
  reasons: string[];
  responseToBaselineMaximumRmsRatio: number;
}

/**
 * Assesses the independent physical speech oracle without weakening the fixed
 * absolute-energy gate.
 *
 * The Stick's brownout-safe codec ceiling can produce intelligible speech
 * below a host microphone's conservative RMS floor. A second xAI STT socket
 * receives only the retained Mac microphone interval and therefore cannot see
 * provider metadata. Exact semantic agreement proves the audio crossed the
 * DAC, amplifier, air, and ADC. We still require a causal energy rise, several
 * active windows, and zero clipping so a coincidental transcript cannot pass a
 * silent or incorrectly sliced capture. The result is explicitly provisional;
 * callers must retain the stricter fixed-threshold miss as a follow-up gate.
 */
export function assessPhysicalSpeechTranscription(input: {
  baselineMaximumRms: number;
  microphoneTranscript: string;
  providerTranscript: string;
  responseClippedSampleCount: number;
  responseMaximumRms: number;
  responseRelativeActiveWindowCount: number;
}): PhysicalSpeechTranscriptionAssessment {
  validateNonnegativeFinite(input.baselineMaximumRms, "ambient maximum RMS");
  validateNonnegativeFinite(input.responseMaximumRms, "response maximum RMS");
  validateNonnegativeInteger(input.responseClippedSampleCount, "response clipped samples");
  validateNonnegativeInteger(
    input.responseRelativeActiveWindowCount,
    "response relative active windows",
  );

  const normalizedMicrophoneTranscript = normalizeTranscript(input.microphoneTranscript);
  const normalizedProviderTranscript = normalizeTranscript(input.providerTranscript);
  const responseToBaselineMaximumRmsRatio =
    input.baselineMaximumRms === 0
      ? input.responseMaximumRms > 0
        ? Number.POSITIVE_INFINITY
        : 0
      : input.responseMaximumRms / input.baselineMaximumRms;
  const reasons: string[] = [];

  if (
    !normalizedMicrophoneTranscript ||
    normalizedMicrophoneTranscript !== normalizedProviderTranscript
  ) {
    reasons.push(
      "The independent microphone transcript did not match Grok's completed output transcript.",
    );
  }
  if (responseToBaselineMaximumRmsRatio < minimumResponseToAmbientMaximumRmsRatio) {
    reasons.push(
      `The response maximum RMS was only ${responseToBaselineMaximumRmsRatio}x the ambient ` +
        `maximum; expected at least ${minimumResponseToAmbientMaximumRmsRatio}x.`,
    );
  }
  if (input.responseRelativeActiveWindowCount < minimumRelativeActiveWindows) {
    reasons.push(
      `The causal response contained ${input.responseRelativeActiveWindowCount} windows above ` +
        `the relative ambient threshold; expected at least ${minimumRelativeActiveWindows}.`,
    );
  }
  if (input.responseClippedSampleCount > 0) {
    reasons.push(
      `The causal response contained ${input.responseClippedSampleCount} clipped ` +
        `${input.responseClippedSampleCount === 1 ? "sample" : "samples"}.`,
    );
  }

  return {
    acceptance: reasons.length === 0 ? "independent-stt-provisional" : "failed",
    normalizedMicrophoneTranscript,
    normalizedProviderTranscript,
    passed: reasons.length === 0,
    reasons,
    responseToBaselineMaximumRmsRatio,
  };
}

function normalizeTranscript(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replaceAll(/\s+/gu, " ");
}

function validateNonnegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`The ${name} must be finite and nonnegative.`);
  }
}

function validateNonnegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The ${name} must be a nonnegative integer.`);
  }
}
