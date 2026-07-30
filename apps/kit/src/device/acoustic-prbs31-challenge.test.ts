import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeDualCarrierPrbs31Pcm16,
  analyzeDualCarrierPrbs31Pcm16Artifact,
  assessDualCarrierPrbs31Analysis,
  computeDualCarrierPrbs31Pcm16SourceIdentity,
  createDualCarrierPrbs31Challenge,
  dualCarrierPrbs31DefaultThresholds,
  renderDualCarrierPrbs31Pcm16,
} from "./acoustic-prbs31-challenge.ts";

const captureSampleRateHz = 48_000;
const durationMs = 2_000;

describe("dual-carrier PRBS31 acoustic challenge", () => {
  test("computes the exact retained provider source identity with bounded storage", () => {
    /*
     * A physical gap is attributable to the device only if the host can prove
     * the source it attempted to send was itself complete. Hash the canonical
     * PCM stream independently of provider chunking, while retaining only one
     * small encoding buffer even for the eventual ten-minute stage.
     */
    const challenge = createDualCarrierPrbs31Challenge({ runId: "source-identity" });
    const rendered = renderDualCarrierPrbs31Pcm16({
      challenge,
      chunkSamples: 173,
      durationMs: 137,
    });
    const encoded = encodePcm16Le(rendered);
    const identity = computeDualCarrierPrbs31Pcm16SourceIdentity({
      challenge,
      durationMs: 137,
    });

    expect(identity).toEqual({
      byteLength: encoded.byteLength,
      maximumBufferedAudioBytes: encoded.byteLength,
      sha256: createHash("sha256").update(encoded).digest("hex"),
    });
  });

  test("binds two independent maximal-sequence carriers to the run identity", () => {
    /*
     * A fixed waveform can be replayed from an earlier green run. Deriving
     * both carrier states from this run ID makes stale audio fail the same
     * physical oracle that detects transport faults, while the commitment is
     * compact enough to retain in every manifest.
     */
    const first = createDualCarrierPrbs31Challenge({ runId: "run-a" });
    const repeated = createDualCarrierPrbs31Challenge({ runId: "run-a" });
    const second = createDualCarrierPrbs31Challenge({ runId: "run-b" });

    expect(first).toEqual(repeated);
    expect(first).toMatchObject({
      carrierAmplitude: 9_175,
      carrierFrequenciesHz: [1_000, 2_000],
      chipSamples: 16,
      frameChips: 20,
      kind: "dual-carrier-prbs31",
      runId: "run-a",
      sampleRateHz: 16_000,
      specVersion: 1,
    });
    expect(first.seedCommitmentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.seedCommitmentSha256).not.toBe(first.seedCommitmentSha256);
  });

  test("renders identically across odd provider chunk boundaries", () => {
    /*
     * Provider chunks are deliberately not aligned to one-millisecond chips.
     * Chunking must never reset either LFSR or carrier phase, because that
     * would make the harness itself manufacture the discontinuity it judges.
     */
    const challenge = createDualCarrierPrbs31Challenge({ runId: "chunk-invariance" });
    const whole = renderDualCarrierPrbs31Pcm16({
      challenge,
      durationMs: 100,
      chunkSamples: 1_600,
    });
    const oddChunks = renderDualCarrierPrbs31Pcm16({
      challenge,
      durationMs: 100,
      chunkSamples: 173,
    });

    expect(oddChunks).toEqual(whole);
    for (let chip = 0; chip <= 100; chip += 1) {
      expect(whole[chip * challenge.chipSamples] ?? 0).toBe(0);
    }
  });

  test("acquires a healthy room-shaped capture with odd lead-in and clock drift", () => {
    /*
     * Capture begins at an arbitrary Mac microphone sample and the two codec
     * clocks are not identical. Slow gain movement, bounded broadband room
     * noise, and a non-integer 7.3 ms lead-in are healthy perturbations; the
     * detector must fit one affine clock rather than retiming every anomaly.
     */
    const challenge = createDualCarrierPrbs31Challenge({ runId: "healthy-room" });
    const capture = makeCapture({
      challenge,
      clockDriftPpm: 150,
      durationMs,
      leadingSamples: 350,
      noiseAmplitude: 80,
      trailingSamples: 241,
    });
    const analysis = analyzeDualCarrierPrbs31Pcm16({
      challenge,
      expectedDurationMs: durationMs,
      sampleRateHz: captureSampleRateHz,
      samples: capture,
    });

    expect(analysis).toMatchObject({
      acquired: true,
      carrierAgreement: true,
      decodedSeedMatchesExpected: true,
      duplicatedChipCount: 0,
      expectedSeedCommitment: challenge.seedCommitmentSha256,
      skippedChipCount: 0,
      specVersion: 1,
      timelineDiscontinuityCount: 0,
    });
    expect(analysis.fittedClockDriftPpm).toBeCloseTo(150, -1);
    expect(assessDualCarrierPrbs31Analysis(analysis).passed).toBe(true);
  });

  test("fails an audible 10 Hz playback gain jiggle even when PRBS identity is intact", () => {
    /*
     * PRBS correlation answers “was the right timeline played?”, not “was its
     * level steady?”. A speaker can preserve every chip while audibly pumping
     * between half and full gain. That is exactly the jiggly long-playback
     * failure this physical oracle exists to catch, so amplitude continuity
     * must remain an independent acceptance dimension.
     */
    const challenge = createDualCarrierPrbs31Challenge({ runId: "gain-jiggle" });
    const leadingSamples = 211;
    const capture = makeCapture({
      challenge,
      clockDriftPpm: 0,
      durationMs,
      leadingSamples,
      noiseAmplitude: 0,
      trailingSamples: 137,
    });
    const activeSampleCount = (durationMs * captureSampleRateHz) / 1_000;
    for (let index = 0; index < activeSampleCount; index += 1) {
      const gain = 0.75 + 0.25 * Math.sin((2 * Math.PI * 10 * index) / captureSampleRateHz);
      const captureIndex = leadingSamples + index;
      capture[captureIndex] = Math.round(capture[captureIndex]! * gain);
    }
    const analysis = analyzeDualCarrierPrbs31Pcm16({
      challenge,
      expectedDurationMs: durationMs,
      sampleRateHz: captureSampleRateHz,
      samples: capture,
    });
    const assessment = assessDualCarrierPrbs31Analysis(analysis);

    expect(analysis.decodedSeedMatchesExpected).toBe(true);
    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContainEqual(expect.stringContaining("amplitude envelope"));
  });

  test("uses the retained versioned watermark thresholds rather than hidden defaults", () => {
    /*
     * A manifest is only reproducible if changing its declared policy changes
     * the verdict. This guards against accidentally reintroducing hard-coded
     * limits while serializing a decorative threshold object.
     */
    const challenge = createDualCarrierPrbs31Challenge({ runId: "threshold-authority" });
    const emitted = renderDualCarrierPrbs31Pcm16({
      challenge,
      chunkSamples: 173,
      durationMs,
    });
    const analysis = {
      ...analyzeDualCarrierPrbs31Pcm16({
        challenge,
        expectedDurationMs: durationMs,
        sampleRateHz: 16_000,
        samples: emitted,
      }),
      maximumAdjacentAmplitudeStepDecibels: 1,
    };

    expect(assessDualCarrierPrbs31Analysis(analysis).passed).toBe(true);
    expect(
      assessDualCarrierPrbs31Analysis(analysis, {
        ...dualCarrierPrbs31DefaultThresholds,
        maximumAdjacentAmplitudeStepDecibels: 0.5,
      }),
    ).toMatchObject({
      passed: false,
      reasons: [expect.stringContaining("exceeding 0.5dB")],
    });
  });

  test("accepts ordinary short room reflections without calling them playback jiggle", () => {
    /*
     * A room and the Mac/device enclosures convolve adjacent PRBS symbols.
     * Individual one-millisecond carrier projections therefore move with the
     * code even at perfectly steady speaker gain. The amplitude oracle must
     * aggregate that deterministic inter-symbol energy before judging the
     * slower common gain envelope.
     */
    const challenge = createDualCarrierPrbs31Challenge({ runId: "ordinary-room-echo" });
    const dry = makeCapture({
      challenge,
      clockDriftPpm: 0,
      durationMs,
      leadingSamples: 211,
      noiseAmplitude: 0,
      trailingSamples: 137,
    });
    const wet = dry.slice();
    const echoDelaySamples = (captureSampleRateHz * 1) / 1_000;
    for (let index = echoDelaySamples; index < wet.length; index += 1) {
      wet[index] = Math.max(
        -32_768,
        Math.min(32_767, Math.round(dry[index]! + 0.1 * dry[index - echoDelaySamples]!)),
      );
    }
    const analysis = analyzeDualCarrierPrbs31Pcm16({
      challenge,
      expectedDurationMs: durationMs,
      sampleRateHz: captureSampleRateHz,
      samples: wet,
    });

    expect(assessDualCarrierPrbs31Analysis(analysis).reasons).toEqual([]);
  });

  test.each([
    {
      label: "duplicates one whole PCM frame",
      mutate: (source: Int16Array) => insertSamples(source, 800, source.slice(480, 800)),
      reason: "duplicated",
    },
    {
      label: "skips one whole PCM frame",
      mutate: (source: Int16Array) => deleteSamples(source, 800, 320),
      reason: "skipped",
    },
    {
      label: "replays an earlier frame without changing duration",
      mutate: (source: Int16Array) => replaceSamples(source, 1_600, source.slice(480, 800)),
      reason: "timeline",
    },
  ])("fails when playback $label", ({ mutate, reason }) => {
    /*
     * A 997 Hz carrier alone has periodic blind spots. These mutations contain
     * no silence and can remain perfectly smooth at a frame boundary, yet the
     * run-keyed logical code must expose their changed timeline.
     */
    const challenge = createDualCarrierPrbs31Challenge({ runId: `fault-${reason}` });
    const source = renderDualCarrierPrbs31Pcm16({
      challenge,
      durationMs,
      chunkSamples: 173,
    });
    const capture = resampleWithLead(mutate(source), 0, 137, 149);
    const analysis = analyzeDualCarrierPrbs31Pcm16({
      challenge,
      expectedDurationMs: durationMs,
      sampleRateHz: captureSampleRateHz,
      samples: capture,
    });
    const assessment = assessDualCarrierPrbs31Analysis(analysis);

    expect(assessment.passed).toBe(false);
    expect(
      analysis.timelineDiscontinuityCount +
        analysis.duplicatedChipCount +
        analysis.skippedChipCount +
        (analysis.decodedSeedMatchesExpected ? 0 : 1),
    ).toBeGreaterThan(0);
  });

  test.each([
    { chipCount: 1, withinChipOffset: 3 },
    { chipCount: 1, withinChipOffset: 11 },
    { chipCount: 2, withinChipOffset: 5 },
  ])(
    "fails a $chipCount ms acoustic hole at within-chip phase $withinChipOffset",
    ({ chipCount, withinChipOffset }) => {
      /*
       * Starting the hole at several carrier phases prevents a lucky
       * zero-crossing from turning a real dropout into a fixture-specific
       * green. Both signed carriers must retain confidence in every chip.
       */
      const challenge = createDualCarrierPrbs31Challenge({
        runId: `hole-${chipCount}-${withinChipOffset}`,
      });
      const source = renderDualCarrierPrbs31Pcm16({
        challenge,
        durationMs,
        chunkSamples: 173,
      });
      source.fill(
        0,
        12_000 + withinChipOffset,
        12_000 + withinChipOffset + chipCount * challenge.chipSamples,
      );
      const capture = resampleWithLead(source, 0, 223, 91);
      const analysis = analyzeDualCarrierPrbs31Pcm16({
        challenge,
        expectedDurationMs: durationMs,
        sampleRateHz: captureSampleRateHz,
        samples: capture,
      });

      expect(assessDualCarrierPrbs31Analysis(analysis).passed).toBe(false);
      expect(analysis.longestUncertainRunChips).toBeGreaterThanOrEqual(chipCount);
    },
  );

  test("rejects a healthy waveform carrying a different run's code", () => {
    const recordedChallenge = createDualCarrierPrbs31Challenge({ runId: "recorded-run" });
    const expectedChallenge = createDualCarrierPrbs31Challenge({ runId: "expected-run" });
    const source = renderDualCarrierPrbs31Pcm16({
      challenge: recordedChallenge,
      durationMs,
      chunkSamples: 173,
    });
    const capture = resampleWithLead(source, -100, 281, 83);
    const analysis = analyzeDualCarrierPrbs31Pcm16({
      challenge: expectedChallenge,
      expectedDurationMs: durationMs,
      sampleRateHz: captureSampleRateHz,
      samples: capture,
    });

    expect(assessDualCarrierPrbs31Analysis(analysis).passed).toBe(false);
    expect(analysis.decodedSeedMatchesExpected).toBe(false);
  });

  test("hashes and reanalyzes a retained artifact with one bounded buffer", async () => {
    /*
     * Acceptance must be reproducible from disk after the adapter is gone.
     * This path receives no claimed hash or analysis object and demonstrates
     * that a larger duration changes disk/time, not analyzer audio storage.
     */
    const challenge = createDualCarrierPrbs31Challenge({ runId: "artifact-authority" });
    const samples = renderDualCarrierPrbs31Pcm16({
      challenge,
      durationMs,
      chunkSamples: 173,
    });
    const directory = await mkdtemp(join(tmpdir(), "iterate-prbs31-artifact-"));
    const artifactPath = join(directory, "capture.pcm16le");
    try {
      const encoded = encodePcm16Le(samples);
      await writeFile(artifactPath, encoded);
      const analysis = analyzeDualCarrierPrbs31Pcm16Artifact({
        artifactPath,
        challenge,
        expectedDurationMs: durationMs,
        readChunkBytes: 4_096,
        sampleRateHz: 16_000,
      });

      expect(analysis.maximumBufferedAudioBytes).toBe(4_096);
      expect(analysis.artifactByteLength).toBe(encoded.byteLength);
      expect(analysis.artifactSha256).toBe(createHash("sha256").update(encoded).digest("hex"));
      expect(assessDualCarrierPrbs31Analysis(analysis).reasons).toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("rejects an emitted artifact truncated by one PCM sample", () => {
    /*
     * Evaluating the exact upper capture boundary must not buy leniency for a
     * genuinely incomplete artifact. The last sample is part of the physical
     * challenge even though acquisition tolerates oscillator drift when a
     * real capture contains enough leading/trailing evidence.
     */
    const challenge = createDualCarrierPrbs31Challenge({ runId: "one-sample-short" });
    const emitted = renderDualCarrierPrbs31Pcm16({
      challenge,
      durationMs,
      chunkSamples: 173,
    });
    const analysis = analyzeDualCarrierPrbs31Pcm16({
      challenge,
      expectedDurationMs: durationMs,
      sampleRateHz: 16_000,
      samples: emitted.subarray(0, emitted.length - 1),
    });

    expect(assessDualCarrierPrbs31Analysis(analysis).passed).toBe(false);
    expect(analysis.longestUncertainRunChips).toBeGreaterThan(0);
  });

  test("rejects a stale artifact even when an adapter could claim green metadata", async () => {
    const recorded = createDualCarrierPrbs31Challenge({ runId: "stale-recording" });
    const expected = createDualCarrierPrbs31Challenge({ runId: "current-run" });
    const samples = renderDualCarrierPrbs31Pcm16({
      challenge: recorded,
      durationMs,
      chunkSamples: 173,
    });
    const directory = await mkdtemp(join(tmpdir(), "iterate-prbs31-artifact-"));
    const artifactPath = join(directory, "capture.pcm16le");
    try {
      await writeFile(artifactPath, encodePcm16Le(samples));
      const official = analyzeDualCarrierPrbs31Pcm16Artifact({
        artifactPath,
        challenge: expected,
        expectedDurationMs: durationMs,
        readChunkBytes: 4_096,
        sampleRateHz: 16_000,
      });

      expect(assessDualCarrierPrbs31Analysis(official).passed).toBe(false);
      expect(official.decodedSeedMatchesExpected).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("rejects a non-file path as retained acoustic evidence", async () => {
    /*
     * A directory, pipe, or device node does not have immutable regular-file
     * read semantics. Hashing one view and analyzing another could otherwise
     * manufacture a proof that cannot be replayed from the retained artifact.
     */
    const challenge = createDualCarrierPrbs31Challenge({ runId: "regular-file-only" });
    const directory = await mkdtemp(join(tmpdir(), "iterate-prbs31-artifact-"));
    try {
      expect(() =>
        analyzeDualCarrierPrbs31Pcm16Artifact({
          artifactPath: directory,
          challenge,
          expectedDurationMs: durationMs,
          sampleRateHz: 16_000,
        }),
      ).toThrow("regular file");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("fails when strong carriers decode to different logical offsets", () => {
    /*
     * Independent carriers exist to distinguish a real code transition from
     * narrow-band room noise. Both can individually correlate strongly while
     * disagreeing about time; collapsing them to the stronger offset would
     * erase exactly that uncertainty and create a false green.
     */
    const challenge = createDualCarrierPrbs31Challenge({ runId: "carrier-disagreement" });
    const capture = renderCarrierDisagreement(challenge, durationMs, 1_000, 20);
    const analysis = analyzeDualCarrierPrbs31Pcm16({
      challenge,
      expectedDurationMs: durationMs,
      sampleRateHz: captureSampleRateHz,
      samples: capture,
    });

    expect(analysis.carrierAgreement).toBe(false);
    expect(assessDualCarrierPrbs31Analysis(analysis).passed).toBe(false);
  });

  test("fails an implausible fitted clock warp", () => {
    /*
     * The global affine fit is allowed to explain oscillator drift, not a
     * missing chunk of audio spread across the whole run. Acceptance must put
     * an explicit ceiling on that degree of freedom.
     */
    const challenge = createDualCarrierPrbs31Challenge({ runId: "clock-warp" });
    const capture = makeCapture({
      challenge,
      clockDriftPpm: 0,
      durationMs,
      leadingSamples: 211,
      noiseAmplitude: 0,
      trailingSamples: 137,
    });
    const analysis = analyzeDualCarrierPrbs31Pcm16({
      challenge,
      expectedDurationMs: durationMs,
      sampleRateHz: captureSampleRateHz,
      samples: capture,
    });

    expect(
      assessDualCarrierPrbs31Analysis({
        ...analysis,
        fittedClockDriftPpm: 501,
      }),
    ).toMatchObject({
      passed: false,
      reasons: [expect.stringContaining("clock drift")],
    });
  });
});

function makeCapture(options: {
  challenge: ReturnType<typeof createDualCarrierPrbs31Challenge>;
  clockDriftPpm: number;
  durationMs: number;
  leadingSamples: number;
  noiseAmplitude: number;
  trailingSamples: number;
}) {
  const source = renderDualCarrierPrbs31Pcm16({
    challenge: options.challenge,
    durationMs: options.durationMs,
    chunkSamples: 173,
  });
  const resampled = resample(source, options.clockDriftPpm);
  const capture = new Int16Array(
    options.leadingSamples + resampled.length + options.trailingSamples,
  );
  let noiseState = 0x1234_5678;
  for (let index = 0; index < resampled.length; index += 1) {
    noiseState = (Math.imul(noiseState, 1_664_525) + 1_013_904_223) >>> 0;
    const noise = (((noiseState >>> 16) / 0xffff) * 2 - 1) * options.noiseAmplitude;
    const gain = 0.72 + 0.18 * (index / Math.max(1, resampled.length - 1));
    capture[options.leadingSamples + index] = Math.max(
      -32_768,
      Math.min(32_767, Math.round(resampled[index]! * gain + noise)),
    );
  }
  return capture;
}

function resampleWithLead(
  source: Int16Array,
  clockDriftPpm: number,
  leadingSamples: number,
  trailingSamples: number,
) {
  const resampled = resample(source, clockDriftPpm);
  const capture = new Int16Array(leadingSamples + resampled.length + trailingSamples);
  capture.set(resampled, leadingSamples);
  return capture;
}

function resample(source: Int16Array, clockDriftPpm: number) {
  const scale = (captureSampleRateHz / 16_000) * (1 + clockDriftPpm / 1_000_000);
  const output = new Int16Array(Math.round(source.length * scale));
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const sourcePosition = outputIndex / scale;
    const leftIndex = Math.min(source.length - 1, Math.floor(sourcePosition));
    const rightIndex = Math.min(source.length - 1, leftIndex + 1);
    const fraction = sourcePosition - leftIndex;
    output[outputIndex] = Math.round(
      source[leftIndex]! * (1 - fraction) + source[rightIndex]! * fraction,
    );
  }
  return output;
}

function insertSamples(source: Int16Array, at: number, inserted: Int16Array) {
  const result = new Int16Array(source.length + inserted.length);
  result.set(source.subarray(0, at), 0);
  result.set(inserted, at);
  result.set(source.subarray(at), at + inserted.length);
  return result;
}

function deleteSamples(source: Int16Array, at: number, count: number) {
  const result = new Int16Array(source.length - count);
  result.set(source.subarray(0, at), 0);
  result.set(source.subarray(at + count), at);
  return result;
}

function replaceSamples(source: Int16Array, at: number, replacement: Int16Array) {
  const result = source.slice();
  result.set(replacement, at);
  return result;
}

function renderCarrierDisagreement(
  challenge: ReturnType<typeof createDualCarrierPrbs31Challenge>,
  renderedDurationMs: number,
  transitionChip: number,
  carrier1OffsetChips: number,
) {
  const leadingSamples = 173;
  const trailingSamples = 137;
  const samplesPerChip = captureSampleRateHz / 1_000;
  const capture = new Int16Array(
    leadingSamples + renderedDurationMs * samplesPerChip + trailingSamples,
  );
  const carrierStates = [
    deriveTestCarrierSeed(challenge.runId, 0),
    deriveTestCarrierSeed(challenge.runId, 1),
  ];
  const carrierSigns = [
    new Int8Array(renderedDurationMs + carrier1OffsetChips),
    new Int8Array(renderedDurationMs + carrier1OffsetChips),
  ];
  for (let chip = 0; chip < carrierSigns[0]!.length; chip += 1) {
    for (let carrier = 0; carrier < 2; carrier += 1) {
      carrierSigns[carrier]![chip] = (carrierStates[carrier]! >>> 30) & 1 ? 1 : -1;
      const feedback = ((carrierStates[carrier]! >>> 30) ^ (carrierStates[carrier]! >>> 27)) & 1;
      carrierStates[carrier] = ((carrierStates[carrier]! << 1) & 0x7fff_ffff) | feedback;
    }
  }
  for (let chip = 0; chip < renderedDurationMs; chip += 1) {
    const carrier1Chip = chip < transitionChip ? chip : chip + carrier1OffsetChips;
    for (let sample = 0; sample < samplesPerChip; sample += 1) {
      capture[leadingSamples + chip * samplesPerChip + sample] = Math.round(
        challenge.carrierAmplitude *
          (carrierSigns[0]![chip]! * Math.sin((2 * Math.PI * sample) / samplesPerChip) +
            carrierSigns[1]![carrier1Chip]! * Math.sin((4 * Math.PI * sample) / samplesPerChip)),
      );
    }
  }
  return capture;
}

function deriveTestCarrierSeed(runId: string, carrier: number) {
  const digest = createHash("sha256")
    .update(`itx-kit-acoustic-prbs31/v1\0${runId}\0carrier-${carrier}`)
    .digest();
  const seed = digest.readUInt32LE(0) & 0x7fff_ffff;
  return seed === 0 ? 1 : seed;
}

function encodePcm16Le(samples: Int16Array) {
  const encoded = Buffer.allocUnsafe(samples.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    encoded.writeInt16LE(samples[index]!, index * Int16Array.BYTES_PER_ELEMENT);
  }
  return encoded;
}
