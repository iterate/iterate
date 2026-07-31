import { describe, expect, test } from "vitest";
import { assessPhysicalSpeechTranscription } from "./physical-speech-transcription.ts";

describe("physical speech transcription assessment", () => {
  test("accepts independently recognised speech only when its causal interval rises above ambient", () => {
    /*
     * The STT socket sees only the Mac microphone artifact, so a transcript
     * match proves intelligibility. Requiring several response windows above
     * the measured ambient ceiling prevents an accidental textual match from
     * laundering a silent or incorrectly sliced capture.
     */
    expect(
      assessPhysicalSpeechTranscription({
        baselineMaximumRms: 8,
        microphoneTranscript: "The deployed Stick voice path is working",
        providerTranscript: "The deployed Stick voice path is working.",
        responseClippedSampleCount: 0,
        responseMaximumRms: 40,
        responseRelativeActiveWindowCount: 20,
      }),
    ).toMatchObject({
      acceptance: "independent-stt-provisional",
      normalizedMicrophoneTranscript: "the deployed stick voice path is working",
      normalizedProviderTranscript: "the deployed stick voice path is working",
      passed: true,
      reasons: [],
      responseToBaselineMaximumRmsRatio: 5,
    });
  });

  test("rejects semantic disagreement, a noncausal energy interval, and clipping", () => {
    const assessment = assessPhysicalSpeechTranscription({
      baselineMaximumRms: 8,
      microphoneTranscript: "WebSocket failed",
      providerTranscript: "The deployed Stick voice path is working.",
      responseClippedSampleCount: 1,
      responseMaximumRms: 9,
      responseRelativeActiveWindowCount: 0,
    });

    expect(assessment.passed).toBe(false);
    expect(assessment.acceptance).toBe("failed");
    expect(assessment.reasons).toEqual([
      "The independent microphone transcript did not match Grok's completed output transcript.",
      "The response maximum RMS was only 1.125x the ambient maximum; expected at least 2.5x.",
      "The causal response contained 0 windows above the relative ambient threshold; expected at least 4.",
      "The causal response contained 1 clipped sample.",
    ]);
  });
});
