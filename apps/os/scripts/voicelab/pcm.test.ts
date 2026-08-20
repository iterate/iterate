/**
 * The resampler's proofs, as arithmetic on signals rather than opinions
 * about sound.
 *
 * Each test pins one property whose absence was audible in the linear
 * version: aliasing rejection (the metallic grit), chunk-invariance (the
 * per-delta seams), rate accuracy (endpoint pinning resampled every delta
 * at a slightly wrong rate), and amplitude honesty (per-phase DC ripple
 * would be a tone at the phase rate).
 */
import { describe, expect, it } from "vitest";
import { Pcm16Resampler } from "../../../../configs/voice-agent/pcm.ts";

/** A mono PCM16 sine, as the wire would carry it. */
function sineBytes(freqHz: number, rateHz: number, ms: number, amplitude = 12_000): Uint8Array {
  const samples = Math.round((rateHz * ms) / 1000);
  const out = new Int16Array(samples);
  for (let index = 0; index < samples; index++) {
    out[index] = Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * index) / rateHz));
  }
  return new Uint8Array(out.buffer);
}

function samplesOf(bytes: Uint8Array): Int16Array {
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

/** Root-mean-square, skipping the filter's settle-in at the head. */
function rmsOf(bytes: Uint8Array, skip = 200): number {
  const samples = samplesOf(bytes);
  let sum = 0;
  let counted = 0;
  for (let index = skip; index < samples.length; index++) {
    sum += samples[index]! * samples[index]!;
    counted++;
  }
  return counted === 0 ? 0 : Math.sqrt(sum / counted);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("Pcm16Resampler", () => {
  it("is a true identity at equal rates", () => {
    const resampler = new Pcm16Resampler(16_000, 16_000);
    const bytes = sineBytes(1_000, 16_000, 20);
    expect(resampler.push(bytes)).toBe(bytes);
  });

  it("reaches the exact 2:3 ratio per push once running", () => {
    /* The kernel holds its half-width of input until the next push proves
     * what follows, so the FIRST push is short by that fixed lookahead —
     * and only the first: the debt is constant, so steady-state pushes
     * convert at exactly the ratio. */
    const resampler = new Pcm16Resampler(24_000, 16_000);
    const first = resampler.push(sineBytes(440, 24_000, 20));
    expect(first.length).toBeGreaterThanOrEqual(560);
    expect(first.length).toBeLessThanOrEqual(640);
    for (let push = 0; push < 5; push++) {
      expect(resampler.push(sineBytes(440, 24_000, 20)).length).toBe(640);
    }
    const up = new Pcm16Resampler(16_000, 24_000);
    up.push(sineBytes(440, 16_000, 20));
    for (let push = 0; push < 5; push++) {
      expect(up.push(sineBytes(440, 16_000, 20)).length).toBe(960);
    }
  });

  it("produces identical audio however the input was chunked", () => {
    /* THE SEAM TEST. The old per-delta conversion was correct-ish inside a
     * chunk and wrong at every boundary; a phase carried across pushes has
     * no boundaries to be wrong at. Byte-for-byte, not approximately. */
    const whole = sineBytes(1_337, 24_000, 250);
    const oneShot = new Pcm16Resampler(24_000, 16_000).push(whole);
    const chunked = new Pcm16Resampler(24_000, 16_000);
    const pieces: Uint8Array[] = [];
    const cuts = [2, 14, 320, 666, 1_282, 4_096];
    let at = 0;
    for (let index = 0; at < whole.length; index++) {
      const take = Math.min(cuts[index % cuts.length]!, whole.length - at);
      pieces.push(chunked.push(whole.subarray(at, at + take)));
      at += take;
    }
    expect(concatBytes(pieces)).toEqual(oneShot);
  });

  it("rejects what would alias instead of folding it into the passband", () => {
    /* 10 kHz exists at 24 kHz and cannot exist at 16; the linear version
     * delivered it anyway, mirrored to 6 kHz at nearly full strength. A
     * real filter delivers silence. */
    const resampler = new Pcm16Resampler(24_000, 16_000);
    const inBand = sineBytes(10_000, 24_000, 300);
    const out = resampler.push(inBand);
    expect(rmsOf(out)).toBeLessThan(rmsOf(inBand) * 0.02);
  });

  it("passes speech-band content at unity gain", () => {
    const resampler = new Pcm16Resampler(24_000, 16_000);
    const inBand = sineBytes(3_000, 24_000, 300);
    const out = resampler.push(inBand);
    expect(rmsOf(out)).toBeGreaterThan(rmsOf(inBand) * 0.95);
    expect(rmsOf(out)).toBeLessThan(rmsOf(inBand) * 1.05);
  });

  it("keeps the tone at its true frequency", () => {
    /* Endpoint pinning resampled every chunk at (n-1)/(m-1) instead of
     * n/m — a rate error that shifted pitch by a chunk-dependent hair.
     * Count zero crossings: a 3 kHz tone must cross zero 6,000 times a
     * second at ANY correct rate. */
    const resampler = new Pcm16Resampler(24_000, 16_000);
    const out = samplesOf(resampler.push(sineBytes(3_000, 24_000, 500)));
    let crossings = 0;
    for (let index = 1; index < out.length; index++) {
      if (out[index - 1]! < 0 !== out[index]! < 0) crossings++;
    }
    const seconds = out.length / 16_000;
    expect(Math.abs(crossings / seconds - 6_000)).toBeLessThan(60);
  });

  it("upsamples without inventing images", () => {
    /* Zero-stuffing 16 -> 24 kHz without a filter mirrors a 5 kHz tone at
     * 11 kHz, which RMS sees as extra energy. Unity RMS means the image
     * is gone. */
    const resampler = new Pcm16Resampler(16_000, 24_000);
    const inBand = sineBytes(5_000, 16_000, 300);
    const out = resampler.push(inBand);
    expect(rmsOf(out)).toBeGreaterThan(rmsOf(inBand) * 0.95);
    expect(rmsOf(out)).toBeLessThan(rmsOf(inBand) * 1.05);
  });

  it("holds DC steady across every polyphase arm", () => {
    /* Each phase's taps are normalised separately; normalised together,
     * the leftover per-phase error is periodic at the output rate over
     * gcd — a tone. Constant in, constant out, every sample. */
    const resampler = new Pcm16Resampler(24_000, 16_000);
    const flat = new Int16Array(2_400).fill(8_000);
    const out = samplesOf(resampler.push(new Uint8Array(flat.buffer)));
    for (let index = 100; index < out.length; index++) {
      expect(Math.abs(out[index]! - 8_000)).toBeLessThanOrEqual(2);
    }
  });

  it("starts a fresh stream on reset", () => {
    const resampler = new Pcm16Resampler(24_000, 16_000);
    const bytes = sineBytes(2_000, 24_000, 100);
    const first = resampler.push(bytes);
    resampler.reset();
    expect(resampler.push(bytes)).toEqual(first);
  });

  it("returns nothing for nothing", () => {
    const resampler = new Pcm16Resampler(24_000, 16_000);
    expect(resampler.push(new Uint8Array(0)).length).toBe(0);
  });
});
