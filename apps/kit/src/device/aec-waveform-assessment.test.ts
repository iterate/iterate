import { describe, expect, test } from "vitest";
import {
  assessAecWaveformRun,
  type AecWaveformRunInput,
  type AecWaveformStimulusKind,
} from "./aec-waveform-assessment.ts";

const sampleRateHz = 16_000;
const sampleCount = sampleRateHz * 2;
const requiredStimuli: readonly AecWaveformStimulusKind[] = [
  "tone",
  "dual-carrier-prbs31",
  "speech-shaped",
];

/*
 * These fixtures model the acceptance semantics, not an idealized adaptive
 * filter. In the room, the same Mac waveform reaches the device through a
 * delay, gain, polarity, and loudspeaker/microphone transfer. The oracle must
 * tolerate those ordinary transforms while still rejecting residual device
 * speaker content and destruction of the independently observed near end.
 */
function createPassingRun(): AecWaveformRunInput {
  const ambient = noise(sampleCount, 9, 19);
  const nearSource = speechShaped(sampleCount, 8_000, 73);
  const nearOnlyClean = addSignals(
    delayedScaled(nearSource, 137, 0.58),
    noise(sampleCount, 20, 31),
  );
  const nearRepeatClean = addSignals(
    delayedScaled(nearOnlyClean, 47, 0.97),
    noise(sampleCount, 22, 41),
  );
  const farEndOnly = requiredStimuli.map((kind, index) => {
    const source = stimulus(kind, sampleCount, index + 1);
    return {
      clean: noise(sampleCount, 16, 100 + index),
      kind,
      playbackObserved: true,
      source,
    };
  });
  return {
    ambient,
    doubleTalk: {
      clean: addSignals(delayedScaled(nearOnlyClean, 91, 0.92), noise(sampleCount, 22, 211)),
      farSource: stimulus("dual-carrier-prbs31", sampleCount, 9),
      nearOnlyClean,
      nearSource,
      playbackObserved: true,
    },
    farEndOnly,
    nearEndOnly: { clean: nearOnlyClean, pathReferenceObserved: true, source: nearSource },
    nearEndRepeat: { clean: nearRepeatClean, pathReferenceObserved: true },
    sampleRateHz,
    validity: validTransport(),
  };
}

describe("shared physical AEC waveform assessment", () => {
  test("accepts an empty far-only uplink and a preserved Mac signal during double-talk", () => {
    const assessment = assessAecWaveformRun(createPassingRun());

    expect(assessment.reasons).toEqual([]);
    expect(assessment.passed).toBe(true);
    expect(assessment.farEnd.every((result) => result.passed)).toBe(true);
    expect(assessment.nearEnd.sourceSimilarity).toBeGreaterThan(0.9);
    expect(assessment.nearEnd.repeat.similarity).toBeGreaterThan(0.99);
    expect(assessment.nearEnd.repeat.residualToReferenceDb).toBeLessThan(-20);
    expect(assessment.doubleTalk.nearEndSimilarity).toBeGreaterThan(0.99);
    expect(assessment.doubleTalk.residualToNearEndDb).toBeLessThan(-20);
    expect(assessment.doubleTalk.similarityLossFromRepeat).toBeLessThan(0.01);
  });

  test("rejects audible device-speaker residue even when the transport is lossless", () => {
    const run = createPassingRun();
    const source = run.farEndOnly[1]!.source;
    run.farEndOnly[1] = {
      ...run.farEndOnly[1]!,
      clean: addSignals(delayedScaled(source, 173, 0.22), noise(sampleCount, 16, 313)),
    };

    const assessment = assessAecWaveformRun(run);
    expect(assessment.passed).toBe(false);
    expect(assessment.farEnd[1]!.sourceSimilarity).toBeGreaterThan(0.8);
    expect(assessment.reasons.join(" ")).toContain("dual-carrier-prbs31 far-only clean uplink");
  });

  test("does not let an unplayed speaker or dead microphone manufacture perfect suppression", () => {
    const run = createPassingRun();
    run.farEndOnly[0] = {
      ...run.farEndOnly[0]!,
      clean: new Int16Array(sampleCount),
      playbackObserved: false,
    };
    run.nearEndOnly = {
      ...run.nearEndOnly,
      clean: new Int16Array(sampleCount),
    };

    const assessment = assessAecWaveformRun(run);
    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain(
      "tone far-only speaker playback was not physically observed.",
    );
    expect(assessment.reasons.join(" ")).toContain("Mac-only signal did not rise above ambient");
  });

  test("rejects a repeatable but quantisation-bound near-end reference", () => {
    const run = createPassingRun();
    /*
     * The first quiet physical spoken runs produced only 4-5 PCM counts RMS
     * against roughly one count of ambient noise. Correlation still found the
     * sentence, but the comparison was dominated by quantisation. Keep the
     * synthetic phrase perfectly repeatable so this test isolates stimulus
     * validity rather than blaming AEC or timing.
     */
    const barelyAudible = delayedScaled(run.nearEndOnly.source, 137, 0.02);
    run.nearEndOnly = { ...run.nearEndOnly, clean: barelyAudible };
    run.nearEndRepeat = {
      ...run.nearEndRepeat,
      clean: delayedScaled(barelyAudible, 47, 0.97),
    };
    run.doubleTalk = {
      ...run.doubleTalk,
      clean: delayedScaled(barelyAudible, 91, 0.92),
      nearOnlyClean: barelyAudible,
    };

    const assessment = assessAecWaveformRun(run);
    expect(assessment.passed).toBe(false);
    expect(assessment.reasons.join(" ")).toContain(
      "Mac-only signal did not provide enough SNR for the double-talk comparison",
    );
  });

  test("accepts a comparison with enough headroom for the absolute residual floor", () => {
    const run = createPassingRun();
    /*
     * The XMOS AEC-only stage deliberately leaves more stationary noise than
     * its noise-suppression stage. The retained physical run had 17.64 dB of
     * near-end headroom while still producing a -7.39 dB double-talk residual
     * and an exact independent transcript. Requiring 20 dB here would reject
     * that measurable signal even though the oracle's absolute residual floor
     * is only -6 dB. This fixture protects the mathematical requirement: at
     * least 15 dB of headroom, rather than a policy accidentally inherited
     * from the abandoned -12 dB floor.
     */
    run.ambient = noise(sampleCount, 175, 313);

    const assessment = assessAecWaveformRun(run);
    expect(assessment.nearEnd.aboveAmbientDb).toBeGreaterThan(15);
    expect(assessment.nearEnd.aboveAmbientDb).toBeLessThan(20);
    expect(assessment.nearEnd.passed).toBe(true);
    expect(assessment.passed).toBe(true);
  });

  test("rejects a near-end control captured after XMOS left the AEC path", () => {
    const run = createPassingRun();
    run.nearEndOnly = { ...run.nearEndOnly, pathReferenceObserved: false };

    const assessment = assessAecWaveformRun(run);
    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain(
      "The near-end control did not physically exercise its matched AEC reference path.",
    );
  });

  test("rejects a repeated control captured after XMOS left the AEC path", () => {
    const run = createPassingRun();
    run.nearEndRepeat = { ...run.nearEndRepeat, pathReferenceObserved: false };

    const assessment = assessAecWaveformRun(run);
    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain(
      "The repeated near-end control did not physically exercise its matched AEC reference path.",
    );
  });

  test("rejects a room-transfer control too unstable to calibrate double-talk", () => {
    const run = createPassingRun();
    run.nearEndRepeat = {
      ...run.nearEndRepeat,
      clean: noise(sampleCount, 3_000, 707),
    };

    const assessment = assessAecWaveformRun(run);
    expect(assessment.passed).toBe(false);
    expect(assessment.nearEnd.repeat.passed).toBe(false);
    expect(assessment.reasons.join(" ")).toContain(
      "Repeated Mac-only capture was not sufficiently close to the first control",
    );
  });

  test("rejects double-talk degradation beyond measured room-transfer repeatability", () => {
    const run = createPassingRun();
    run.doubleTalk = {
      ...run.doubleTalk,
      clean: addSignals(
        delayedScaled(run.doubleTalk.nearOnlyClean, 91, 0.92),
        noise(sampleCount, 500, 811),
      ),
    };

    const assessment = assessAecWaveformRun(run);
    expect(assessment.passed).toBe(false);
    expect(assessment.doubleTalk.nearEndSimilarity).toBeGreaterThan(0.85);
    expect(assessment.reasons.join(" ")).toContain(
      "Double-talk degraded beyond repeated near-end control",
    );
  });

  test("accepts the bounded nonlinear transform of a usable vendor AEC double-talk path", () => {
    const run = createPassingRun();
    /*
     * A hardware AEC is not a linear wire during double-talk: its adaptive
     * filter changes the nearby waveform even when it removes the far-end
     * signal correctly. These levels reproduce the retained HAVPE evidence:
     * a stable repeat near 0.98 similarity, a double-talk capture near 0.91,
     * bounded gain, and residual energy roughly 7 dB below the near speech.
     * The far source is deliberately orders of magnitude larger so unrelated
     * near-path distortion cannot masquerade as leaked speaker audio.
     */
    const nearOnlyClean = addSignals(
      delayedScaled(run.nearEndOnly.source, 137, 0.025),
      noise(sampleCount, 1, 317),
    );
    run.ambient = noise(sampleCount, 4, 319);
    run.nearEndOnly = { ...run.nearEndOnly, clean: nearOnlyClean };
    run.nearEndRepeat = {
      ...run.nearEndRepeat,
      clean: addSignals(delayedScaled(nearOnlyClean, 47, 0.95), noise(sampleCount, 10, 331)),
    };
    run.doubleTalk = {
      ...run.doubleTalk,
      clean: addSignals(delayedScaled(nearOnlyClean, 91, 0.93), noise(sampleCount, 22, 337)),
      nearOnlyClean,
    };

    const assessment = assessAecWaveformRun(run);
    expect(assessment.nearEnd.repeat.similarity).toBeGreaterThan(0.95);
    expect(assessment.doubleTalk.nearEndSimilarity).toBeGreaterThan(0.85);
    expect(assessment.doubleTalk.similarityLossFromRepeat).toBeGreaterThan(0.03);
    expect(assessment.doubleTalk.similarityLossFromRepeat).toBeLessThan(0.1);
    expect(assessment.doubleTalk.residualDegradationFromRepeatDb).toBeGreaterThan(2);
    expect(assessment.doubleTalk.residualDegradationFromRepeatDb).toBeLessThan(8);
    expect(assessment.doubleTalk.farEndResidualDb).toBeLessThan(-40);
    expect(assessment.passed).toBe(true);
  });

  test("does not call uncorrelated room noise residual far-end echo", () => {
    const run = createPassingRun();
    /*
     * Double-talk compares two separate physical microphone recordings. Even
     * a perfect echo canceller therefore leaves the independent ambient noise
     * from both recordings in the subtraction residual. That energy cannot be
     * 40 dB below a deliberately quiet far stimulus in every real room. The
     * known far waveform is the discriminating witness: uncorrelated residual
     * is room/near-path variation, while correlated residual is self-talk.
     *
     * Keep the near speech strong and usable here, but add enough independent
     * room noise to cross the old absolute-energy threshold. This must pass;
     * the adjacent residual-echo fixture remains the negative control.
     */
    run.ambient = noise(sampleCount, 140, 919);
    run.nearEndRepeat = {
      ...run.nearEndRepeat,
      clean: addSignals(
        delayedScaled(run.doubleTalk.nearOnlyClean, 47, 0.82),
        noise(sampleCount, 210, 923),
      ),
    };
    run.doubleTalk = {
      ...run.doubleTalk,
      clean: addSignals(
        delayedScaled(run.doubleTalk.nearOnlyClean, 91, 0.82),
        noise(sampleCount, 210, 929),
      ),
    };

    const assessment = assessAecWaveformRun(run);
    expect(assessment.doubleTalk.nearEndSimilarity).toBeGreaterThan(0.95);
    expect(assessment.doubleTalk.farEndSimilarity).toBeLessThan(0.02);
    expect(assessment.doubleTalk.farEndResidualDb).toBeGreaterThan(-40);
    expect(assessment.reasons).toEqual([]);
    expect(assessment.passed).toBe(true);
  });

  test("accepts a deliberately licensed near-end gain even when composite similarity is lower", () => {
    const run = createPassingRun();
    /*
     * Similarity combines gain and unexplained residual into one value. At the
     * explicitly supported 0.5-2.0 double-talk gain range, an otherwise good
     * capture can fall below 0.85 solely because it was ducked: with gain
     * around 0.58 and an -8 dB residual the mathematical ceiling is about
     * 0.83. Judge those independent properties independently, otherwise the
     * documented gain range is fictitious and the retained StackChan run is
     * impossible to pass even with no correlated far-end leakage.
     */
    const nearOnlyClean = addSignals(
      delayedScaled(run.nearEndOnly.source, 137, 0.025),
      noise(sampleCount, 1, 941),
    );
    run.ambient = noise(sampleCount, 4, 947);
    run.nearEndOnly = { ...run.nearEndOnly, clean: nearOnlyClean };
    run.nearEndRepeat = {
      ...run.nearEndRepeat,
      clean: addSignals(delayedScaled(nearOnlyClean, 47, 0.95), noise(sampleCount, 10, 953)),
    };
    run.doubleTalk = {
      ...run.doubleTalk,
      clean: addSignals(delayedScaled(nearOnlyClean, 91, 0.583), noise(sampleCount, 18, 967)),
      nearOnlyClean,
    };

    const assessment = assessAecWaveformRun(run);
    expect(assessment.doubleTalk.nearEndGain).toBeGreaterThan(0.55);
    expect(assessment.doubleTalk.nearEndGain).toBeLessThan(0.62);
    expect(assessment.doubleTalk.nearEndSimilarity).toBeLessThan(0.85);
    expect(assessment.doubleTalk.residualToNearEndDb).toBeLessThan(-6);
    expect(assessment.doubleTalk.farEndSimilarity).toBeLessThan(0.02);
    expect(assessment.reasons).toEqual([]);
    expect(assessment.passed).toBe(true);
  });

  test("rejects a suppressor which erases the Mac speaker during double-talk", () => {
    const run = createPassingRun();
    run.doubleTalk = {
      ...run.doubleTalk,
      clean: noise(sampleCount, 18, 501),
    };

    const assessment = assessAecWaveformRun(run);
    expect(assessment.passed).toBe(false);
    expect(assessment.doubleTalk.nearEndSimilarity).toBeLessThan(0.2);
    expect(assessment.reasons.join(" ")).toContain("Double-talk clean uplink did not preserve");
  });

  test("rejects residual far-end echo mixed into otherwise preserved near speech", () => {
    const run = createPassingRun();
    run.doubleTalk = {
      ...run.doubleTalk,
      clean: addSignals(
        delayedScaled(run.doubleTalk.nearOnlyClean, 91, 0.92),
        delayedScaled(run.doubleTalk.farSource, 211, 0.3),
      ),
    };

    const assessment = assessAecWaveformRun(run);
    expect(assessment.passed).toBe(false);
    expect(assessment.doubleTalk.residualToNearEndDb).toBeGreaterThan(-12);
  });

  test("fails closed on loss, reconnects, resets, recorder overflow, or timing discontinuity", () => {
    const run = createPassingRun();
    run.validity = {
      ...run.validity,
      captureFrameDrops: 1,
      clockDiscontinuities: 1,
      networkValid: false,
      playbackUnderrunIncidents: 1,
      recorderComplete: false,
      websocketReconnects: 1,
    };

    const assessment = assessAecWaveformRun(run);
    expect(assessment.passed).toBe(false);
    expect(assessment.validity.passed).toBe(false);
    expect(assessment.reasons.join(" ")).toContain("recorder did not close complete");
    expect(assessment.reasons.join(" ")).toContain("network interval was not valid");
    expect(assessment.reasons.join(" ")).toContain("clock/timeline discontinuity");
  });

  test("requires the complete representative far-end stimulus suite", () => {
    const run = createPassingRun();
    run.farEndOnly = run.farEndOnly.filter((phase) => phase.kind !== "speech-shaped");

    const assessment = assessAecWaveformRun(run);
    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain("Missing required speech-shaped far-only AEC phase.");
  });
});

function validTransport() {
  return {
    captureFailures: 0,
    captureFrameDrops: 0,
    clockDiscontinuities: 0,
    networkValid: true,
    playbackDroppedFrames: 0,
    playbackIntegrityFailures: 0,
    playbackResets: 0,
    playbackUnderrunIncidents: 0,
    recorderComplete: true,
    uplinkFrameDrops: 0,
    uplinkRestarts: 0,
    websocketReconnects: 0,
  };
}

function stimulus(kind: AecWaveformStimulusKind, length: number, seed: number) {
  if (kind === "speech-shaped") return speechShaped(length, 15_000, seed);
  const samples = new Int16Array(length);
  let state = (seed | 1) >>> 0;
  let sign = 1;
  for (let index = 0; index < length; index += 1) {
    if (kind === "tone") {
      samples[index] = Math.round(15_000 * Math.sin((2 * Math.PI * 997 * index) / sampleRateHz));
      continue;
    }
    if (index % 16 === 0) {
      state = lfsr(state);
      sign = (state & 1) === 0 ? -1 : 1;
    }
    const carrier =
      Math.sin((2 * Math.PI * 1_003 * index) / sampleRateHz) +
      Math.sin((2 * Math.PI * 2_117 * index) / sampleRateHz);
    samples[index] = Math.round(sign * 7_500 * carrier);
  }
  return samples;
}

function speechShaped(length: number, amplitude: number, seed: number) {
  const samples = new Int16Array(length);
  let state = (seed | 1) >>> 0;
  let low = 0;
  for (let index = 0; index < length; index += 1) {
    state = lfsr(state);
    const white = ((state / 0xffff_ffff) * 2 - 1) * amplitude;
    low += 0.18 * (white - low);
    const envelope = 0.2 + 0.8 * Math.sin((Math.PI * (index % 2_400)) / 2_400) ** 2;
    samples[index] = clampPcm16(low * envelope);
  }
  return samples;
}

function noise(length: number, amplitude: number, seed: number) {
  const samples = new Int16Array(length);
  let state = (seed | 1) >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = lfsr(state);
    samples[index] = Math.round(((state / 0xffff_ffff) * 2 - 1) * amplitude);
  }
  return samples;
}

function delayedScaled(samples: Int16Array, delaySamples: number, gain: number) {
  const output = new Int16Array(samples.length);
  for (let index = delaySamples; index < samples.length; index += 1) {
    output[index] = clampPcm16(samples[index - delaySamples]! * gain);
  }
  return output;
}

function addSignals(...signals: readonly Int16Array[]) {
  const output = new Int16Array(signals[0]!.length);
  for (let index = 0; index < output.length; index += 1) {
    let value = 0;
    for (const signal of signals) value += signal[index]!;
    output[index] = clampPcm16(value);
  }
  return output;
}

function clampPcm16(value: number) {
  return Math.max(-32_768, Math.min(32_767, Math.round(value)));
}

function lfsr(state: number) {
  return ((state >>> 1) ^ (-(state & 1) & 0xd000_0001)) >>> 0;
}
