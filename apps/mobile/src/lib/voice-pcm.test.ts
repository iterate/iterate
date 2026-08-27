import { expect, test } from "vitest";
import { float32ToPcm16Base64, pcm16Base64ToFloat32, pulseLevel } from "./voice-pcm.ts";

test("float32 → base64 PCM16 → float32 round-trips within quantization error", () => {
  const samples = new Float32Array([0, 0.5, -0.5, 0.999, -1, 0.25]);
  const roundTripped = pcm16Base64ToFloat32(float32ToPcm16Base64(samples));
  expect(roundTripped.length).toBe(samples.length);
  for (let i = 0; i < samples.length; i++) {
    expect(Math.abs(roundTripped[i]! - samples[i]!)).toBeLessThan(2 / 0x7fff);
  }
});

test("out-of-range capture samples clamp instead of wrapping", () => {
  const decoded = pcm16Base64ToFloat32(float32ToPcm16Base64(new Float32Array([2.5, -3])));
  expect(decoded[0]).toBeGreaterThan(0.99);
  expect(decoded[1]).toBeLessThanOrEqual(-0.99);
});

test("a ragged trailing byte is truncated, not fatal", () => {
  /* Three bytes = one full sample and a half; the half must vanish. */
  const decoded = pcm16Base64ToFloat32(btoa("\x00\x40\x7f"));
  expect(decoded.length).toBe(1);
});

test("pulseLevel maps silence to 0 and conversational speech into the visible range", () => {
  expect(pulseLevel(new Float32Array(1024))).toBe(0);
  const speechish = new Float32Array(1024).map((_, i) => 0.1 * Math.sin(i / 5));
  const level = pulseLevel(speechish);
  expect(level).toBeGreaterThan(0.3);
  expect(level).toBeLessThanOrEqual(1);
  expect(pulseLevel(new Float32Array(1024).fill(0.9))).toBe(1);
});
