import { expect, test } from "vitest";
import { autoCorrelatePitchHz, foldedSemitoneOffset } from "./pitch.ts";

test("detects the pitch of a clean sine in any octave", () => {
  const sampleRate = 44100;
  for (const hz of [110, 220, 261.63, 440]) {
    const samples = new Float32Array(2048);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.4;
    }
    const detected = autoCorrelatePitchHz(samples, sampleRate);
    expect(detected).not.toBeNull();
    // Within a quarter semitone — the game's own tolerance.
    expect(Math.abs(12 * Math.log2(detected! / hz))).toBeLessThan(0.25);
  }
});

test("silence and noise detect as nothing", () => {
  const silence = new Float32Array(2048);
  expect(autoCorrelatePitchHz(silence, 44100)).toBeNull();
  // Deterministic pseudo-noise (no Math.random in tests).
  const noise = new Float32Array(2048);
  let seed = 1;
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 16807) % 2147483647;
    noise[i] = (seed / 2147483647 - 0.5) * 0.6;
  }
  expect(autoCorrelatePitchHz(noise, 44100)).toBeNull();
});

test("semitone offsets fold octaves away", () => {
  const c4 = 261.63;
  expect(foldedSemitoneOffset(c4, c4)).toBeCloseTo(0, 5);
  expect(foldedSemitoneOffset(c4 * 2, c4)).toBeCloseTo(0, 5);
  expect(foldedSemitoneOffset(c4 / 4, c4)).toBeCloseTo(0, 5);
  // A semitone sharp in a different octave is still one semitone sharp.
  expect(foldedSemitoneOffset(c4 * 2 * 2 ** (1 / 12), c4)).toBeCloseTo(1, 5);
  // A semitone flat folds to -1, not +11.
  expect(foldedSemitoneOffset(c4 * 2 ** (-1 / 12), c4)).toBeCloseTo(-1, 5);
});
