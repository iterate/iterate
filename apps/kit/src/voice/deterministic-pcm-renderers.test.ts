import { describe, expect, it } from "vitest";
import { createDualCarrierPrbs31Challenge } from "../device/acoustic-prbs31-challenge.ts";
import {
  createBufferPcm16LeRenderer,
  createChirpPcm16LeRenderer,
  createImpulseTrainPcm16LeRenderer,
  createMultiTonePcm16LeRenderer,
  createPrbs31Pcm16LeRenderer,
  createSpeechShapedPcm16LeRenderer,
  createTonePcm16LeRenderer,
  renderPcm16Le,
} from "./deterministic-pcm-renderers.ts";

describe("deterministic PCM renderers", () => {
  it("streams one retained PCM file without copying or wrapping it", () => {
    /*
     * A physical release run must play the bytes hashed during fixture
     * materialization. Looping or zero-padding a short/corrupt file would make
     * the emitted interval differ from its manifest while still sounding
     * plausible, so exhaustion is a hard error.
     */
    const source = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
    const renderer = createBufferPcm16LeRenderer(source);
    expect(renderer.render(1)).toEqual(new Uint8Array([1, 0]));
    expect(renderer.render(3)).toEqual(new Uint8Array([2, 0, 3, 0, 4, 0]));
    expect(() => renderer.render(1)).toThrow(/exhausted/u);
  });

  it.each([
    [
      "multi-tone",
      () =>
        createMultiTonePcm16LeRenderer({
          amplitude: 12_000,
          frequenciesHz: [251, 997, 3_101],
          sampleRateHz: 16_000,
        }),
    ],
    [
      "chirp",
      () =>
        createChirpPcm16LeRenderer({
          amplitude: 12_000,
          endFrequencyHz: 3_600,
          sampleRateHz: 16_000,
          startFrequencyHz: 120,
          sweepDurationSamples: 13_711,
        }),
    ],
    [
      "impulse train",
      () => createImpulseTrainPcm16LeRenderer({ amplitude: 12_000, periodSamples: 1_003 }),
    ],
  ] as const)("keeps the %s stimulus independent of provider chunking", (_name, create) => {
    /*
     * A production WebSocket is free to split PCM at any byte-conserving
     * boundary. The release matrix uses these sources to diagnose adaptation
     * and transient recovery, so a transport split must not create a different
     * acoustic experiment or an artificial impulse that the AEC never caused.
     */
    const oneShot = renderPcm16Le(create(), 32_003, 32_003);
    const fragmented = renderPcm16Le(create(), 32_003, 487);
    expect(fragmented).toEqual(oneShot);
  });

  it("emits a sparse alternating transient fixture without hidden ringing", () => {
    /*
     * Impulses expose convergence and path-change tails, but a helper that
     * silently windows or filters them would move that ringing into the source.
     * Pin the literal first two periods so residual energy belongs to the
     * physical device/room rather than the oracle.
     */
    const bytes = renderPcm16Le(
      createImpulseTrainPcm16LeRenderer({ amplitude: 12_000, periodSamples: 5 }),
      11,
      3,
    );
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = Array.from({ length: 11 }, (_, index) => view.getInt16(index * 2, true));
    expect(samples).toEqual([12_000, 0, 0, 0, 0, -12_000, 0, 0, 0, 0, 12_000]);
  });

  it("preserves tone phase across hostile transport chunk boundaries", () => {
    /*
     * Provider chunks are deliberately not PCM-frame aligned in the physical
     * rig. Restarting oscillator phase at either boundary can sound plausible
     * while manufacturing discontinuities which AEC then sees as a different
     * reference, so chunking must be observational only.
     */
    const oneShot = renderPcm16Le(
      createTonePcm16LeRenderer({ amplitude: 20_000, frequencyHz: 997, sampleRateHz: 16_000 }),
      16_000,
      16_000,
    );
    const fragmented = renderPcm16Le(
      createTonePcm16LeRenderer({ amplitude: 20_000, frequencyHz: 997, sampleRateHz: 16_000 }),
      16_000,
      313,
    );
    expect(fragmented).toEqual(oneShot);
  });

  it("preserves random and filter state for speech-shaped broadband material", () => {
    /*
     * A per-chunk random seed would let a 1,000-byte WebSocket choice alter
     * the physical stimulus. Exact equality across co-prime chunk sizes makes
     * the retained seed and duration a sufficient description of the source.
     */
    const options = { amplitude: 24_000, sampleRateHz: 16_000, seed: 0x51_7a_c3 };
    const oneShot = renderPcm16Le(createSpeechShapedPcm16LeRenderer(options), 32_000, 32_000);
    const fragmented = renderPcm16Le(createSpeechShapedPcm16LeRenderer(options), 32_000, 487);
    expect(fragmented).toEqual(oneShot);
    expect(new Set(fragmented).size).toBeGreaterThan(128);
  });

  it("attenuates a physical PRBS stimulus without corrupting its versioned challenge", () => {
    /*
     * The first quiet HAVPE AEC run spread a lower carrier amplitude into the
     * challenge object. That object is deliberately self-authenticating, so
     * the second response threw before response.created and the provider
     * correctly tore down the whole PCM generation. Output level is an
     * acoustic-rig concern, not part of PRBS identity: retain the canonical
     * challenge and apply a bounded gain in the renderer instead.
     */
    const challenge = createDualCarrierPrbs31Challenge({ runId: "quiet-physical-aec" });
    const bytes = renderPcm16Le(
      createPrbs31Pcm16LeRenderer(challenge, {
        outputGain: 2_500 / challenge.carrierAmplitude,
      }),
      16_000,
    );
    const samples = new Int16Array(bytes.byteLength / 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = view.getInt16(index * 2, true);
    }
    const peak = samples.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);

    expect(challenge.carrierAmplitude).toBe(9_175);
    expect(peak).toBeGreaterThan(2_500);
    expect(peak).toBeLessThanOrEqual(5_000);
  });
});
