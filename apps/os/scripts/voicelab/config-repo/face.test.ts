/**
 * The face module, pinned WITHOUT the harness: pcm chunks, answer boundaries
 * and barge events in, one newest face value out. The processor's own tests
 * (voice-agent.test.ts, "the face") prove the call sites against a pretend
 * provider; these prove the mechanism itself — which is the point of it being
 * pure: no sockets, no clock, no fixture, just inputs.
 */
import { describe, expect, it } from "vitest";
import { createFace } from "./face.ts";
import { firmwareVisemes } from "./viseme.ts";

/** An answer with real spectral shape, so the classifier has something to
 * classify — silence classifies as SIL, which proves nothing moved. */
function voicedPcm(ms: number): Uint8Array {
  const samples = new Int16Array(ms * 16);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = Math.round(
      9_000 * Math.sin((2 * Math.PI * 220 * index) / 16_000) +
        4_000 * Math.sin((2 * Math.PI * 700 * index) / 16_000),
    );
  }
  return new Uint8Array(samples.buffer);
}

describe("the face module", () => {
  it("is null until the mouth first moves, and silence never moves it", () => {
    const face = createFace();
    expect(face.read()).toBeNull();
    face.answerStarted();
    /* 600 ms of digital silence: the VAD never opens, the track stays SIL,
     * and SIL-to-SIL is no change — so nothing folds. */
    face.audio(new Uint8Array(600 * 32), 1_000);
    expect(face.read()).toBeNull();
  });

  it("publishes the newest shape during audio, stamped with the caller's clock", () => {
    const face = createFace();
    face.answerStarted();
    face.audio(voicedPcm(600), 4_242);
    const value = face.read();
    expect(value).not.toBeNull();
    expect(value!.answer).toBe(1);
    expect(value!.viseme).toBeGreaterThanOrEqual(0);
    expect(value!.viseme).toBeLessThan(firmwareVisemes.SIL);
    expect(value!.playoutSamples).toBeGreaterThanOrEqual(0);
    expect(value!.at).toBe(4_242);
  });

  it("closes with SIL when the answer's track ends", () => {
    const face = createFace();
    face.answerStarted();
    face.audio(voicedPcm(600), 100);
    face.answerAudioDone(250);
    const value = face.read();
    expect(value!.viseme).toBe(firmwareVisemes.SIL);
    expect(value!.confidence).toBe(0);
    expect(value!.answer).toBe(1);
    expect(value!.at).toBe(250);
    /* The close lands at (or after) the end of the answer's own samples. */
    expect(value!.playoutSamples).toBeGreaterThanOrEqual(600 * 16);
  });

  it("a barge shuts the mouth at once, playout clock zeroed", () => {
    const face = createFace();
    face.answerStarted();
    face.audio(voicedPcm(2_000), 100);
    expect(face.read()!.viseme).not.toBe(firmwareVisemes.SIL);
    face.barge(333);
    const value = face.read();
    expect(value!.viseme).toBe(firmwareVisemes.SIL);
    expect(value!.playoutSamples).toBe(0);
    expect(value!.confidence).toBe(0);
    expect(value!.answer).toBe(1);
    expect(value!.at).toBe(333);
  });

  it("numbers answers 1-based, playout clock restarting with each", () => {
    const face = createFace();
    face.answerStarted();
    face.audio(voicedPcm(600), 100);
    expect(face.read()!.answer).toBe(1);
    face.answerStarted();
    face.audio(voicedPcm(600), 200);
    const value = face.read();
    expect(value!.answer).toBe(2);
    /* Relative to THIS answer's first sample — a shape carrying the first
     * answer's offsets would move the mouth against the wrong audio. */
    expect(value!.playoutSamples).toBeLessThanOrEqual(600 * 16);
  });

  it("is deterministic: the same inputs always produce the same value", () => {
    const run = () => {
      const face = createFace();
      face.answerStarted();
      face.audio(voicedPcm(300), 10);
      face.audio(voicedPcm(300), 20);
      face.answerAudioDone(30);
      return face.read();
    };
    expect(run()).toEqual(run());
  });
});
