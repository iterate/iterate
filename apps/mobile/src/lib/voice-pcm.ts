// PCM arithmetic for the voice client — pure and Node-importable, like
// encoding.ts: the capture callback hands us Float32 [-1, 1] and the wire
// speaks base64 PCM16 mono 16 kHz (the only encoding the voice lane carries —
// see apps/os/scripts/voicelab/README.md), so these four functions ARE the
// audio boundary's math. Kept off the native module so vitest and the live
// e2e exercise the exact shipped conversion.
import { base64ToUint8Array, uint8ArrayToBase64 } from "./encoding.ts";

export const VOICE_SAMPLE_RATE = 16_000;

/** Capture Float32 → wire base64 PCM16 (little-endian, mono). */
export function float32ToPcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    /* Asymmetric on purpose: 0x7fff up, 0x8000 down — the standard PCM16
     * mapping; scaling by 0x8000 alone overflows +1.0. */
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return uint8ArrayToBase64(bytes);
}

/** Wire base64 PCM16 → playback Float32. Truncates a ragged trailing byte
 * rather than throwing: one corrupt frame must not end a call. */
export function pcm16Base64ToFloat32(base64: string): Float32Array<ArrayBuffer> {
  const bytes = base64ToUint8Array(base64);
  const sampleCount = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return samples;
}

/**
 * A frame's loudness for the pulse, mapped from raw RMS to a UI-friendly
 * 0..1: speech RMS on a phone mic lives around 0.02–0.3, so raw RMS barely
 * moves a UI. The divisor puts conversational speech mid-range; purely
 * visual, never touches the wire (grill decision: the pulse is local VU
 * feedback, not a turn control).
 */
export function pulseLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sumSquares / samples.length);
  return Math.min(1, rms / 0.15);
}
