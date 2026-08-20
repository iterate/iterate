import { describe, expect, test } from "vitest";

import { mulawToPcm16 } from "./audio.ts";

describe("mu-law playout decode", () => {
  test("expands silence and both full-scale signs to little-endian PCM16", () => {
    const pcm = mulawToPcm16(Buffer.from([0xff, 0x7f, 0x80, 0x00]));
    expect(pcm.length).toBe(8);
    expect([...new Int16Array(pcm.buffer, pcm.byteOffset, 4)]).toEqual([0, 0, 32_124, -32_124]);
  });
});
