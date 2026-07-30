import { describe, expect, test } from "vitest";
import { createFixedPcmFrames } from "./voice-e2e-audio.ts";

describe("voice e2e audio", () => {
  test("pads the final PCM frame and appends exact silence frames", () => {
    const input = Uint8Array.from([1, 2, 3, 4, 5, 6]);

    expect(createFixedPcmFrames(input, 4, 2)).toEqual([
      Uint8Array.from([1, 2, 3, 4]),
      Uint8Array.from([5, 6, 0, 0]),
      new Uint8Array(4),
      new Uint8Array(4),
    ]);
  });

  test("rejects samples and frame sizes which cannot contain PCM16", () => {
    expect(() => createFixedPcmFrames(Uint8Array.from([1]), 640, 0)).toThrow("PCM16 input");
    expect(() => createFixedPcmFrames(new Uint8Array(2), 639, 0)).toThrow("frame size");
    expect(() => createFixedPcmFrames(new Uint8Array(2), 640, -1)).toThrow("silence frame count");
  });
});
