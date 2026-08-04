import { describe, expect, test } from "vitest";
import { stackChanMatchedReferenceObserved } from "./physical-aec-playback-observation.ts";

describe("physical AEC playback observation", () => {
  test("requires both hardware content progress and the quiet StackChan reference pilot", () => {
    /*
     * The retained physical run measured the amplitude-64 pilot near 55 mean
     * counts after the synchronous analog divider. Its former peak>=500 gate
     * could only pass on a stale loud tail from the preceding phase. A phase
     * is valid only when I2S consumes at least 0.5 seconds of new content and
     * the matched analog reference rises above half the commanded pilot; each
     * fact alone admits exactly the false-positive mode seen on hardware.
     */
    expect(
      stackChanMatchedReferenceObserved([
        { lifetimePlaybackContentSamples: 395_520, referenceMeanAbsolute: 19 },
        { lifetimePlaybackContentSamples: 411_392, referenceMeanAbsolute: 55 },
      ]),
    ).toBe(true);
    expect(
      stackChanMatchedReferenceObserved([
        { lifetimePlaybackContentSamples: 395_520, referenceMeanAbsolute: 608 },
        { lifetimePlaybackContentSamples: 395_520, referenceMeanAbsolute: 6 },
      ]),
    ).toBe(false);
    expect(
      stackChanMatchedReferenceObserved([
        { lifetimePlaybackContentSamples: 395_520, referenceMeanAbsolute: 6 },
        { lifetimePlaybackContentSamples: 411_392, referenceMeanAbsolute: 6 },
      ]),
    ).toBe(false);
  });
});
