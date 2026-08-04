import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { visemeModelBytes } from "./viseme-model.generated.ts";
import {
  computeVisemeFeatureVector,
  createAcousticVisemeClassifier,
  createVisemeChangeTrack,
  createVisemeTracker,
  firmwareVisemes,
  parseVisemeModel,
  visemeSampleRateHz,
  type VisemeChangeEvent,
  type VisemeHopClassification,
} from "./viseme.ts";

/**
 * The deterministic golden signal shared with the C port's test and the
 * upstream oracle (tools/generate_face_viseme_golden.mjs in the stackchan
 * repo): a 173 Hz + 731 Hz two-tone with a linear amplitude ramp.
 */
function buildGoldenPcm(): Int16Array {
  return Int16Array.from({ length: 512 }, (_, index) => {
    const carrier =
      9200 * Math.sin((2 * Math.PI * 173 * index) / 16000) +
      5100 * Math.sin((2 * Math.PI * 731 * index) / 16000);
    const envelope = 0.35 + (0.65 * index) / 511;
    return Math.round(carrier * envelope);
  });
}

describe("feature extraction parity with upstream HeadAudio", () => {
  // The expected values are the upstream JavaScript Processor's feature vector
  // for the golden signal, captured via the oracle script and identical to the
  // C port's GOLDEN_FEATURES. The 1e-4 budget matches the C parity test.
  test.for([
    { coefficient: 0, expected: 1.0 },
    { coefficient: 1, expected: 0.9999417066574097 },
    { coefficient: 2, expected: -0.999945342540741 },
    { coefficient: 3, expected: -0.9999997615814209 },
    { coefficient: 4, expected: 0.7099394202232361 },
    { coefficient: 5, expected: 1.0 },
    { coefficient: 6, expected: 1.0 },
    { coefficient: 7, expected: 1.0 },
    { coefficient: 8, expected: -1.0 },
    { coefficient: 9, expected: -1.0 },
    { coefficient: 10, expected: -1.0 },
    { coefficient: 11, expected: -1.0 },
  ])("coefficient $coefficient matches to 1e-4", ({ coefficient, expected }) => {
    const features = computeVisemeFeatureVector(buildGoldenPcm());
    expect(Math.abs(features[coefficient] - expected)).toBeLessThanOrEqual(1e-4);
  });

  test("speaker mean warp changes the mel filter bank", () => {
    const reference = computeVisemeFeatureVector(buildGoldenPcm());
    const warped = computeVisemeFeatureVector(buildGoldenPcm(), 220);
    expect(Array.from(warped)).not.toEqual(Array.from(reference));
  });

  test("rejects blocks that are not exactly one analysis window", () => {
    expect(() => computeVisemeFeatureVector(new Int16Array(511))).toThrowError(
      "Feature extraction needs exactly 512 samples, got 511.",
    );
  });
});

describe("model binary", () => {
  test("the embedded base64 module decodes to the exact committed binary", () => {
    const committed = new Uint8Array(readFileSync(new URL("./viseme-model.bin", import.meta.url)));
    expect(visemeModelBytes()).toEqual(committed);
  });

  test("parses 39 prototypes with exactly one silence prototype", () => {
    const prototypes = parseVisemeModel(visemeModelBytes());
    expect(prototypes).toHaveLength(39);
    expect(prototypes.filter((p) => p.viseme === firmwareVisemes.SIL)).toHaveLength(1);
    for (const prototype of prototypes) {
      expect(prototype.mean).toHaveLength(12);
      expect(prototype.inverseCovarianceLower).toHaveLength(78);
    }
  });

  // Spot checks decoded by hand from the binary layout: big-endian codepoint
  // pair, viseme id at byte 7, little-endian float32 mean and packed
  // lower-triangular inverse covariance.
  test.for([
    { record: 0, phoneme: "ð", viseme: firmwareVisemes.TH, mean0: -0.160645813, cov0: 1.90052056 },
    { record: 1, phoneme: "ə", viseme: firmwareVisemes.E, mean0: 0.0960886329, cov0: 2.10783911 },
    { record: 14, phoneme: "m", viseme: firmwareVisemes.PP, mean0: 0.172758654, cov0: 2.05331159 },
    {
      record: 38,
      phoneme: "s1",
      viseme: firmwareVisemes.SIL,
      mean0: -0.000332854281,
      cov0: 1206.82983,
    },
  ])("prototype $record is $phoneme", ({ record, phoneme, viseme, mean0, cov0 }) => {
    const prototype = parseVisemeModel(visemeModelBytes())[record];
    expect(prototype.phoneme).toBe(phoneme);
    expect(prototype.viseme).toBe(viseme);
    expect(prototype.mean[0]).toBeCloseTo(mean0, 6);
    expect(prototype.inverseCovarianceLower[0]).toBeCloseTo(cov0, 3);
  });

  test("rejects truncated, mislabeled, and non-finite models", () => {
    const bytes = visemeModelBytes();
    expect(() => parseVisemeModel(bytes.slice(0, 100))).toThrowError(
      "A viseme model must be a non-empty multiple of 368 bytes, got 100.",
    );
    const badViseme = visemeModelBytes();
    badViseme[7] = 99;
    expect(() => parseVisemeModel(badViseme)).toThrowError(
      "Prototype 0 has out-of-range viseme id 99.",
    );
    const badFloat = visemeModelBytes();
    new DataView(badFloat.buffer).setFloat32(8, Number.NaN, true);
    expect(() => parseVisemeModel(badFloat)).toThrowError(
      "Prototype 0 has a non-finite mean value.",
    );
  });
});

describe("firmware viseme ids", () => {
  test("mirror the device enum in face_pose.h", () => {
    expect(firmwareVisemes).toEqual({
      AA: 0,
      E: 1,
      I: 2,
      O: 3,
      U: 4,
      PP: 5,
      SS: 6,
      TH: 7,
      DD: 8,
      FF: 9,
      KK: 10,
      NN: 11,
      RR: 12,
      CH: 13,
      SIL: 14,
    });
  });
});

/** The C parity test's pseudo-random 4097-sample signal. */
function buildInvariancePcm(): Int16Array {
  return Int16Array.from({ length: 4097 }, (_, index) => {
    const value = ((index * 7919 + 1237) & 0xffff) - 32768;
    return Math.trunc(value / 3);
  });
}

function collectHops(
  pushChunks: (
    classifier: ReturnType<typeof createAcousticVisemeClassifier>,
    collect: (hop: VisemeHopClassification) => void,
  ) => void,
): VisemeHopClassification[] {
  const classifier = createAcousticVisemeClassifier();
  const hops: VisemeHopClassification[] = [];
  pushChunks(classifier, (hop) => hops.push({ ...hop }));
  return hops;
}

describe("packet-boundary invariance", () => {
  // The C parity test's chunk cycle, deliberately awkward sizes.
  const chunkCycle = [1, 37, 3, 159, 320, 11, 503, 2, 697];

  test("chunked pushes classify identically to one contiguous push", () => {
    const pcm = buildInvariancePcm();
    const contiguous = collectHops((classifier, collect) => classifier.push(pcm, collect));
    const fragmented = collectHops((classifier, collect) => {
      let offset = 0;
      let chunkIndex = 0;
      while (offset < pcm.length) {
        const count = Math.min(chunkCycle[chunkIndex % chunkCycle.length], pcm.length - offset);
        classifier.push(pcm.subarray(offset, offset + count), collect);
        offset += count;
        chunkIndex += 1;
      }
    });

    // 4097 samples: first hop once the 512-sample window fills, then every 256.
    expect(contiguous).toHaveLength(15);
    expect(contiguous.map((hop) => hop.playoutSamples)).toEqual([
      512, 768, 1024, 1280, 1536, 1792, 2048, 2304, 2560, 2816, 3072, 3328, 3584, 3840, 4096,
    ]);
    for (const hop of contiguous) {
      expect(Number.isInteger(hop.confidence)).toBe(true);
      expect(hop.confidence).toBeGreaterThanOrEqual(0);
      expect(hop.confidence).toBeLessThanOrEqual(255);
    }
    expect(fragmented).toEqual(contiguous);
  });

  test("reset restores the exact initial state", () => {
    const pcm = buildInvariancePcm();
    const fresh = collectHops((classifier, collect) => classifier.push(pcm, collect));
    const classifier = createAcousticVisemeClassifier();
    classifier.push(buildGoldenPcm(), () => {});
    classifier.reset();
    const reused: VisemeHopClassification[] = [];
    classifier.push(pcm, (hop) => reused.push({ ...hop }));
    expect(reused).toEqual(fresh);
  });
});

/** Appends a phase-continuous multi-tone burst to a growing signal. */
function appendTone(
  target: number[],
  seconds: number,
  frequenciesHz: number[],
  amplitude: number,
): void {
  const start = target.length;
  const count = Math.round(seconds * visemeSampleRateHz);
  for (let index = 0; index < count; index += 1) {
    let value = 0;
    for (const frequencyHz of frequenciesHz) {
      value += Math.sin((2 * Math.PI * frequencyHz * (start + index)) / visemeSampleRateHz);
    }
    target.push(Math.round((amplitude * value) / frequenciesHz.length));
  }
}

/** Appends digital silence to a growing signal. */
function appendSilence(target: number[], seconds: number): void {
  const count = Math.round(seconds * visemeSampleRateHz);
  for (let index = 0; index < count; index += 1) {
    target.push(0);
  }
}

/**
 * Two loud vowel-ish tone bursts separated by real silence:
 * 0.5 s silence, 0.6 s burst, 0.4 s silence, 0.6 s burst, 0.7 s silence.
 * Burst one spans samples 8000-17599, burst two 24000-33599; 44800 in total.
 */
function buildBurstPcm(): Int16Array {
  const signal: number[] = [];
  appendSilence(signal, 0.5);
  appendTone(signal, 0.6, [220, 440, 880], 6000);
  appendSilence(signal, 0.4);
  appendTone(signal, 0.6, [180, 1200], 6000);
  appendSilence(signal, 0.7);
  return Int16Array.from(signal);
}

function trackBursts(): VisemeChangeEvent[] {
  const tracker = createVisemeTracker();
  const pcm = buildBurstPcm();
  const events: VisemeChangeEvent[] = [];
  // 20 ms frames, the shape the PCM pacing worker feeds.
  for (let offset = 0; offset < pcm.length; offset += 320) {
    events.push(...tracker.push(pcm.subarray(offset, Math.min(offset + 320, pcm.length))));
  }
  const closing = tracker.end();
  if (closing !== undefined) {
    events.push(closing);
  }
  return events;
}

describe("viseme change track on synthetic bursts", () => {
  // Offsets asserted exactly are decided by integer level arithmetic alone
  // (hop boundaries fall every 256 samples from 512): the VAD opens on the
  // first hop whose window overlaps a burst loudly enough. Offsets that hinge
  // on near-silence classifications (where prototypes are nearly tied) get
  // ranges instead, bounded by the VAD release plus the minimum hold.
  test("emits sparse events that open on speech and always close with SIL", () => {
    const events = trackBursts();

    // VAD opens on the hops covering samples 7936-8191 and 23808-24063.
    expect(events[0].playoutSamples).toBe(8192);
    expect(events[0].viseme).not.toBe(firmwareVisemes.SIL);
    expect(events.some((event) => event.playoutSamples === 24064)).toBe(true);

    // Exactly one SIL per burst tail, each within release-plus-hold of the
    // burst end, and the track finishes closed.
    const silences = events.filter((event) => event.viseme === firmwareVisemes.SIL);
    expect(silences).toHaveLength(2);
    expect(silences[0].playoutSamples).toBeGreaterThanOrEqual(17920);
    expect(silences[0].playoutSamples).toBeLessThanOrEqual(19968);
    expect(silences[1].playoutSamples).toBeGreaterThanOrEqual(33920);
    expect(silences[1].playoutSamples).toBeLessThanOrEqual(35968);
    expect(events[events.length - 1]).toEqual(silences[1]);
    expect(silences.map((event) => event.confidence)).toEqual([0, 0]);

    // Nothing before speech and nothing once each tail has settled.
    for (const event of events) {
      expect(event.playoutSamples).toBeGreaterThanOrEqual(8192);
      const inFirstGap = event.playoutSamples > 19968 && event.playoutSamples < 24064;
      expect(inFirstGap).toBe(false);
    }

    // ~1.2 s of "speech" yields a handful of events, never a flood.
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events.length).toBeLessThanOrEqual(12);
  });

  test("never flickers: consecutive events differ and respect the minimum hold", () => {
    const events = trackBursts();
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index].viseme).not.toBe(events[index - 1].viseme);
      // 80 ms minimum hold at 16 kHz.
      expect(
        events[index].playoutSamples - events[index - 1].playoutSamples,
      ).toBeGreaterThanOrEqual(1280);
    }
  });

  test("confidence is always a 0-255 integer", () => {
    for (const event of trackBursts()) {
      expect(Number.isInteger(event.confidence)).toBe(true);
      expect(event.confidence).toBeGreaterThanOrEqual(0);
      expect(event.confidence).toBeLessThanOrEqual(255);
    }
  });

  test("a quiet noise floor below the VAD open level never emits", () => {
    const quiet = Int16Array.from({ length: visemeSampleRateHz }, (_, index) =>
      Math.round(30 * Math.sin((2 * Math.PI * 300 * index) / visemeSampleRateHz)),
    );
    const tracker = createVisemeTracker();
    expect(tracker.push(quiet)).toEqual([]);
    expect(tracker.end()).toBeUndefined();
  });
});

describe("answer boundaries", () => {
  test("reset makes the next answer identical and offsets answer-relative", () => {
    const pcm = buildBurstPcm();
    const tracker = createVisemeTracker();
    const first = [...tracker.push(pcm)];
    const closing = tracker.end();
    expect(closing).toBeUndefined(); // the burst tail already released to SIL
    tracker.reset();
    const second = [...tracker.push(pcm)];
    expect(second).toEqual(first);
  });

  test("end forces a closing SIL when the answer stops mid-speech", () => {
    const tracker = createVisemeTracker();
    const pcm = buildBurstPcm();
    // Stop right inside the first burst, while a viseme is still showing.
    const events = tracker.push(pcm.subarray(0, 12000));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1].viseme).not.toBe(firmwareVisemes.SIL);
    expect(tracker.end()).toEqual({
      playoutSamples: 12000,
      viseme: firmwareVisemes.SIL,
      confidence: 0,
    });
    // Ending twice stays closed instead of emitting a second SIL.
    expect(tracker.end()).toBeUndefined();
  });

  test("the change track refuses hops after end until reset", () => {
    const track = createVisemeChangeTrack();
    track.end(0);
    expect(() =>
      track.pushHop({
        viseme: firmwareVisemes.AA,
        confidence: 200,
        level: 500,
        playoutSamples: 512,
      }),
    ).toThrowError("The viseme change track already ended; reset it first.");
    track.reset();
    expect(
      track.pushHop({
        viseme: firmwareVisemes.AA,
        confidence: 200,
        level: 500,
        playoutSamples: 512,
      }),
    ).toEqual({ playoutSamples: 512, viseme: firmwareVisemes.AA, confidence: 200 });
  });
});
