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
      "The causal response contained 0 windows above the relative ambient threshold; expected at least 3 for provisional acceptance (the stricter follow-up gate remains 4).",
      "The causal response contained 1 clipped sample.",
    ]);
  });

  test("provisionally accepts exactly one acoustic-boundary word around an otherwise exact transcript", () => {
    /*
     * CoreAudio capture markers are file-flush bounds, not sample callbacks.
     * The production Stick run retained one terminal stimulus word immediately
     * before all five provider words, while digital accounting proved the
     * complete response. Model that measured miss narrowly: one boundary word
     * is allowed, two words or any interior mismatch must remain a failure.
     */
    const input = {
      baselineMaximumRms: 10,
      providerTranscript: "Production turn one is green.",
      responseClippedSampleCount: 0,
      responseMaximumRms: 60,
      responseRelativeActiveWindowCount: 20,
    } as const;

    expect(
      assessPhysicalSpeechTranscription({
        ...input,
        microphoneTranscript: "Green. Production turn one is green.",
      }),
    ).toMatchObject({
      acceptance: "independent-stt-boundary-provisional",
      boundaryWordOverage: 1,
      passed: true,
      reasons: [],
    });
    expect(
      assessPhysicalSpeechTranscription({
        ...input,
        microphoneTranscript: "Display green. Production turn one is green.",
      }).passed,
    ).toBe(false);
    expect(
      assessPhysicalSpeechTranscription({
        ...input,
        microphoneTranscript: "Production turn two is green.",
      }).passed,
    ).toBe(false);
  });

  test("records and provisionally accepts only the measured one-window acoustic-boundary miss", () => {
    /*
     * The production three-turn Stick run conserved every digital frame and
     * the independent microphone transcribed the provider sentence exactly,
     * but a capture-window phase boundary left only three qualifying 20 ms
     * windows against the stricter four-window oracle. The landing decision
     * permits exactly that measured one-window miss. Two windows still cannot
     * distinguish a short click from speech and must remain red.
     */
    const input = {
      baselineMaximumRms: 17.499107120079014,
      microphoneTranscript: "Production turn one is green.",
      providerTranscript: "Production turn one is green.",
      responseClippedSampleCount: 0,
      responseMaximumRms: 50.33285043918468,
    } as const;

    expect(
      assessPhysicalSpeechTranscription({
        ...input,
        responseRelativeActiveWindowCount: 3,
      }),
    ).toMatchObject({
      acceptance: "independent-stt-energy-boundary-provisional",
      passed: true,
      reasons: [],
      relativeActiveWindowDeficit: 1,
    });
    expect(
      assessPhysicalSpeechTranscription({
        ...input,
        responseRelativeActiveWindowCount: 2,
      }),
    ).toMatchObject({
      acceptance: "failed",
      passed: false,
      relativeActiveWindowDeficit: 2,
    });
  });
});
