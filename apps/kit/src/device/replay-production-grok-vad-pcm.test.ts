import { describe, expect, test } from "vitest";
import { selectPcmReplayInterval } from "../../scripts/replay-production-grok-vad-pcm.ts";

describe("production Grok VAD PCM replay interval", () => {
  test("selects an exact whole-frame interval from one retained physical stream", () => {
    /*
     * Comparing near-only and double-talk must use the original accepted
     * uplink, not manually copied derivative files whose byte provenance can
     * drift. A 20 ms-aligned view preserves the exact production packet shape
     * while selecting only the phase named by the physical timeline.
     */
    const frameSamples = 320;
    const pcm = Uint8Array.from({ length: frameSamples * 2 * 4 }, (_, index) => index & 0xff);

    const selected = selectPcmReplayInterval(pcm, 16_000, {
      endSample: frameSamples * 3,
      startSample: frameSamples,
    });

    expect(selected).toEqual(pcm.subarray(frameSamples * 2, frameSamples * 2 * 3));
  });

  test("rejects a phase boundary that would silently change production framing", () => {
    const pcm = new Uint8Array(640 * 4);

    expect(() =>
      selectPcmReplayInterval(pcm, 16_000, { endSample: 960, startSample: 321 }),
    ).toThrow("20 ms PCM frame boundaries");
  });
});
