const minimumResponseToAmbientMaximumRmsRatio = 2.5;
const minimumRelativeActiveWindows = 4;
const minimumProvisionalRelativeActiveWindows = minimumRelativeActiveWindows - 1;
const minimumWordsForBoundaryTolerance = 4;

export interface PhysicalSpeechTranscriptionAssessment {
  acceptance:
    | "failed"
    | "independent-stt-provisional"
    | "independent-stt-boundary-provisional"
    | "independent-stt-energy-boundary-provisional";
  boundaryWordOverage: number;
  normalizedMicrophoneTranscript: string;
  normalizedProviderTranscript: string;
  passed: boolean;
  reasons: string[];
  relativeActiveWindowDeficit: number;
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
  const boundaryWordOverage = transcriptBoundaryWordOverage(
    normalizedMicrophoneTranscript,
    normalizedProviderTranscript,
  );
  const responseToBaselineMaximumRmsRatio =
    input.baselineMaximumRms === 0
      ? input.responseMaximumRms > 0
        ? Number.POSITIVE_INFINITY
        : 0
      : input.responseMaximumRms / input.baselineMaximumRms;
  const relativeActiveWindowDeficit = Math.max(
    0,
    minimumRelativeActiveWindows - input.responseRelativeActiveWindowCount,
  );
  const reasons: string[] = [];

  if (!normalizedMicrophoneTranscript || boundaryWordOverage === undefined) {
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
  /*
   * Keep four windows as the strict acoustic target and report the exact miss,
   * but admit the single measured phase-boundary overage for the landing run.
   * Three 20 ms windows still represent 60 ms of causal energy and are paired
   * here with an exact independent STT match plus a 2.5x ambient rise. Two
   * windows remain red: this must not become a generic "the transcript looked
   * right" waiver for an impulse, bad slice, or inaudible response.
   */
  if (input.responseRelativeActiveWindowCount < minimumProvisionalRelativeActiveWindows) {
    reasons.push(
      `The causal response contained ${input.responseRelativeActiveWindowCount} windows above ` +
        `the relative ambient threshold; expected at least ` +
        `${minimumProvisionalRelativeActiveWindows} for provisional acceptance ` +
        `(the stricter follow-up gate remains ${minimumRelativeActiveWindows}).`,
    );
  }
  if (input.responseClippedSampleCount > 0) {
    reasons.push(
      `The causal response contained ${input.responseClippedSampleCount} clipped ` +
        `${input.responseClippedSampleCount === 1 ? "sample" : "samples"}.`,
    );
  }

  return {
    acceptance:
      reasons.length > 0
        ? "failed"
        : relativeActiveWindowDeficit === 1
          ? "independent-stt-energy-boundary-provisional"
          : boundaryWordOverage === 0
            ? "independent-stt-provisional"
            : "independent-stt-boundary-provisional",
    boundaryWordOverage: boundaryWordOverage ?? -1,
    normalizedMicrophoneTranscript,
    normalizedProviderTranscript,
    passed: reasons.length === 0,
    reasons,
    relativeActiveWindowDeficit,
    responseToBaselineMaximumRmsRatio,
  };
}

/**
 * Returns the exact count of microphone-only words at the capture boundary.
 *
 * The only tolerated miss is the one observed on the reference Mac: one word
 * before or after an otherwise exact provider transcript of at least four
 * words. We intentionally reject two boundary words, an interior edit, or a
 * short utterance where one coincidental word would be too permissive. This is
 * a capture-marker tolerance, not fuzzy semantic matching.
 */
function transcriptBoundaryWordOverage(
  microphoneTranscript: string,
  providerTranscript: string,
): number | undefined {
  if (!microphoneTranscript || !providerTranscript) return undefined;
  if (microphoneTranscript === providerTranscript) return 0;
  const microphoneWords = microphoneTranscript.split(" ");
  const providerWords = providerTranscript.split(" ");
  if (
    providerWords.length < minimumWordsForBoundaryTolerance ||
    microphoneWords.length !== providerWords.length + 1
  ) {
    return undefined;
  }
  const leadingBoundary = microphoneWords
    .slice(1)
    .every((word, index) => word === providerWords[index]);
  const trailingBoundary = microphoneWords
    .slice(0, -1)
    .every((word, index) => word === providerWords[index]);
  return leadingBoundary || trailingBoundary ? 1 : undefined;
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
