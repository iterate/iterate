import { describe, expect, it } from "vitest";
import { mulawToPcm16, pcm16ToMulaw } from "./mulaw.ts";

describe("mu-law wire codec", () => {
  it("round-trips every 16-bit sample within segment quantization error", () => {
    // The firmware's own proof method: sweep all 65536 samples through
    // encode and expand; every value must come back, none as silence.
    const pcm = Buffer.alloc(65536 * 2);
    for (let value = -32768; value < 32768; value++) {
      pcm.writeInt16LE(value, (value + 32768) * 2);
    }
    const decoded = mulawToPcm16(pcm16ToMulaw(pcm));
    let maxError = 0;
    for (let value = -32768; value < 32768; value++) {
      const back = decoded.readInt16LE((value + 32768) * 2);
      // mu-law's top segment quantizes by 256; the CLIP knocks full-scale
      // down to 32635 before encoding.
      const reference = Math.max(-32635, Math.min(32635, value));
      maxError = Math.max(maxError, Math.abs(back - reference));
      if (Math.abs(reference) > 1000) {
        expect(Math.sign(back)).toBe(Math.sign(reference));
      }
    }
    // The top mu-law segment steps by 1024; truncating encode + midpoint
    // decode bounds the error at half a step.
    expect(maxError).toBeLessThanOrEqual(512);
  });

  it("does not encode INT16_MIN as silence (the firmware's measured defect)", () => {
    const pcm = Buffer.alloc(2);
    pcm.writeInt16LE(-32768, 0);
    const back = mulawToPcm16(pcm16ToMulaw(pcm)).readInt16LE(0);
    // A clipping input stage produces exactly this sample; it must come back
    // as a large negative value, never zero.
    expect(back).toBeLessThan(-30000);
  });

  it("encodes silence as mu-law silence", () => {
    const pcm = Buffer.alloc(4);
    const encoded = pcm16ToMulaw(pcm);
    expect(mulawToPcm16(encoded).readInt16LE(0)).toBe(0);
  });
});
