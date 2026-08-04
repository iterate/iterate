import { describe, expect, test } from "vitest";
import { createDualCarrierPrbs31Challenge } from "../../device/acoustic-prbs31-challenge.ts";
import { physicalAecResponseRole } from "../../device/physical-aec-response-plan.ts";
import {
  createPrbs31Pcm16LeRenderer,
  createSpeechShapedPcm16LeRenderer,
  createTonePcm16LeRenderer,
} from "../../voice/deterministic-pcm-renderers.ts";
import {
  createDeterministicAecRenderer,
  deterministicAecResponseRole,
  DETERMINISTIC_AEC_DOUBLE_TALK_PRBS_RUN_ID,
  DETERMINISTIC_AEC_FAR_PRBS_RUN_ID,
} from "./deterministic-aec-fixture.ts";

describe("deployed deterministic AEC fixture", () => {
  test("keeps the deployed response protocol identical to the physical host oracle", () => {
    /*
     * The deployed worker and local harness cannot import one another after
     * installation. Their six response ordinals nevertheless describe one
     * physical experiment. If either side inserts or reorders a phase, every
     * later capture remains plausible PCM but is attributed to the wrong
     * source—much worse than a loud failure—so compare the whole protocol.
     */
    for (let responseIndex = 0; responseIndex < 6; responseIndex += 1) {
      expect(deterministicAecResponseRole(responseIndex)).toBe(
        physicalAecResponseRole(responseIndex),
      );
    }
    expect(() => deterministicAecResponseRole(6)).toThrow(/Unmodelled/u);
  });

  test("renders the quiet tone and speech fixtures byte-for-byte like the host sources", () => {
    const sampleCount = 3_211;
    const deployedTone = createDeterministicAecRenderer(0).render(sampleCount);
    const hostTone = createTonePcm16LeRenderer({
      amplitude: 4_500,
      frequencyHz: 997,
      sampleRateHz: 16_000,
    }).render(sampleCount);
    expect(deployedTone).toEqual(hostTone);

    const deployedSpeech = createDeterministicAecRenderer(2).render(sampleCount);
    const hostSpeech = createSpeechShapedPcm16LeRenderer({
      amplitude: 2_250,
      sampleRateHz: 16_000,
      seed: 0x5a_17_20_26,
    }).render(sampleCount);
    expect(deployedSpeech).toEqual(hostSpeech);
  });

  test.each([
    [1, DETERMINISTIC_AEC_FAR_PRBS_RUN_ID],
    [5, DETERMINISTIC_AEC_DOUBLE_TALK_PRBS_RUN_ID],
  ] as const)(
    "renders response %i from the committed host PRBS challenge",
    (responseIndex, runId) => {
      /*
       * Workerd uses pre-derived synchronous seed constants so audio rendering
       * never waits for Web Crypto. Independently deriving the source from its
       * public run ID catches a typo or stale constant while retaining the exact
       * host-side commitment and analyser used by the acoustic harness.
       */
      const challenge = createDualCarrierPrbs31Challenge({ runId });
      const host = createPrbs31Pcm16LeRenderer(challenge, {
        outputGain: 2_250 / challenge.carrierAmplitude,
      });
      expect(createDeterministicAecRenderer(responseIndex).render(4_997)).toEqual(
        host.render(4_997),
      );
    },
  );

  test("retains oscillator and PRBS state across inconvenient provider chunks", () => {
    for (const responseIndex of [0, 1, 2, 3, 4, 5]) {
      const whole = createDeterministicAecRenderer(responseIndex).render(5_003);
      const chunkedRenderer = createDeterministicAecRenderer(responseIndex);
      const chunked = new Uint8Array(whole.byteLength);
      let sampleOffset = 0;
      for (const sampleCount of [1, 319, 997, 2_111, 1_575]) {
        chunked.set(chunkedRenderer.render(sampleCount), sampleOffset * 2);
        sampleOffset += sampleCount;
      }
      expect(sampleOffset).toBe(5_003);
      expect(chunked).toEqual(whole);
    }
  });
});
