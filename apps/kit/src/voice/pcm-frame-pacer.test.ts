import { describe, expect, test } from "vitest";
import { nextPcmFrameDeadline } from "./pcm-frame-pacer.ts";

describe("PCM frame pacing", () => {
  test("uses an absolute grid so ordinary timer lateness does not accumulate", () => {
    const frameDurationMs = 20;
    const firstDeadline = nextPcmFrameDeadline(0, 100, frameDurationMs);
    const secondDeadline = nextPcmFrameDeadline(firstDeadline, 125, frameDurationMs);
    const thirdDeadline = nextPcmFrameDeadline(secondDeadline, 145, frameDurationMs);

    expect(firstDeadline).toBe(120);
    expect(secondDeadline).toBe(140);
    expect(thirdDeadline).toBe(160);
  });

  test("resets after a full-frame miss instead of emitting a catch-up burst", () => {
    expect(nextPcmFrameDeadline(120, 160, 20)).toBe(180);
  });
});
