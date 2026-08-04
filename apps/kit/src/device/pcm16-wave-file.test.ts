import { describe, expect, it } from "vitest";
import { decodeMonoPcm16Wave, encodeMonoPcm16Wave } from "./pcm16-wave-file.ts";

describe("encodeMonoPcm16Wave", () => {
  it("retains exact PCM bytes behind an explicit mono 16 kHz header", () => {
    /*
     * The double-talk oracle compares a repeat of one exact Mac stimulus.
     * Letting an external encoder choose channels, sample width, or source
     * bytes would make two nominally equal acoustic phases incomparable.
     */
    const pcm = Uint8Array.of(0x34, 0x12, 0xcc, 0xed);
    const wave = encodeMonoPcm16Wave(pcm, 16_000);
    const view = new DataView(wave.buffer);
    expect(new TextDecoder().decode(wave.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wave.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(pcm.byteLength);
    expect(wave.subarray(44)).toEqual(pcm);
  });
});

describe("decodeMonoPcm16Wave", () => {
  it("finds mono PCM behind the large filler chunk emitted by macOS say", () => {
    /*
     * `say` deliberately aligns its WAVE data at byte 4096 with an FLLR
     * chunk. Assuming the common 44-byte header would feed chunk metadata to
     * the acoustic oracle and make a repeated spoken phrase incomparable to
     * itself. This compact fixture protects chunk walking without retaining a
     * machine-generated voice asset in git.
     */
    const pcm = Uint8Array.of(0x34, 0x12, 0xcc, 0xed);
    const ordinary = encodeMonoPcm16Wave(pcm, 16_000);
    const fillerBytes = 4;
    const chunkBytes = 8 + fillerBytes;
    const withFiller = new Uint8Array(ordinary.byteLength + chunkBytes);
    withFiller.set(ordinary.subarray(0, 36), 0);
    withFiller.set(new TextEncoder().encode("FLLR"), 36);
    const view = new DataView(withFiller.buffer);
    view.setUint32(40, fillerBytes, true);
    withFiller.set(Uint8Array.of(1, 2, 3, 4), 44);
    withFiller.set(ordinary.subarray(36), 48);
    view.setUint32(4, withFiller.byteLength - 8, true);

    expect(decodeMonoPcm16Wave(withFiller)).toEqual({
      pcm,
      sampleRateHz: 16_000,
    });
  });

  it("rejects a stereo WAVE before it can invalidate a mono acoustic oracle", () => {
    const wave = encodeMonoPcm16Wave(Uint8Array.of(0, 0), 16_000);
    new DataView(wave.buffer).setUint16(22, 2, true);
    expect(() => decodeMonoPcm16Wave(wave)).toThrow(/mono PCM16/u);
  });
});
