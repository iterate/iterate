// G.711 mu-law, both directions — the voice wire's audio codec (decision D4).
//
// This is a TypeScript implementation of the same WIRE CONTRACT the C
// firmware implements in voicelab_stream.c, deliberately not shared code
// (decision D8). The encoder carries the firmware's measured fix: -32768 has
// no positive counterpart in sixteen bits, so its magnitude is taken in a
// wide integer — negating it into int16 wrapped straight back, the clip
// never fired, and one full-scale negative sample (exactly what a clipping
// input stage produces) encoded as silence in the middle of loud speech.

export function pcm16ToMulaw(pcm: Buffer): Buffer {
  const BIAS = 0x84;
  const CLIP = 32635;
  const samples = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(samples);
  for (let index = 0; index < samples; index++) {
    const sample = pcm.readInt16LE(index * 2);
    const sign = (sample >> 8) & 0x80;
    // Magnitude in a wide integer, never back into int16 — see file comment.
    let value = sign !== 0 ? -sample : sample;
    if (value > CLIP) value = CLIP;
    const magnitude = value + BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; mask >>= 1) {
      exponent--;
    }
    const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
    out[index] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

export function mulawToPcm16(encoded: Buffer): Buffer {
  const out = Buffer.alloc(encoded.length * 2);
  for (let index = 0; index < encoded.length; index++) {
    const value = ~encoded[index]! & 0xff;
    const sign = value & 0x80;
    const exponent = (value >> 4) & 0x07;
    const mantissa = value & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    out.writeInt16LE(sign === 0 ? sample : -sample, index * 2);
  }
  return out;
}
