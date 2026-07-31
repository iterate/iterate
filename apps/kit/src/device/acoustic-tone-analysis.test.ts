import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  analyzeAcousticTonePcm16Artifact,
  analyzeAcousticTonePcm16,
  assessAcousticToneAnalysis,
} from "./acoustic-tone-analysis.ts";

const sampleRateHz = 48_000;
const frequencyHz = 1_000;

async function writeLongToneArtifact(options: {
  clockDriftPpm?: number;
  durationMs: number;
  echoDelaySamples?: number;
  echoGain?: number;
  frequencyHz: number;
  noiseAmplitude?: number;
  sampleRateHz: number;
  sourceDuplicateAtMs?: number;
}) {
  const directory = await mkdtemp(join(tmpdir(), "iterate-kit-acoustic-analysis-"));
  const artifactPath = join(directory, "tone.pcm16le");
  const artifact = await open(artifactPath, "w");
  const chunk = Buffer.alloc(64 * 1_024);
  const sampleCount = (options.durationMs * options.sampleRateHz) / 1_000;
  let writtenSamples = 0;
  try {
    while (writtenSamples < sampleCount) {
      const chunkSamples = Math.min(chunk.byteLength / 2, sampleCount - writtenSamples);
      for (let index = 0; index < chunkSamples; index += 1) {
        const absoluteIndex = writtenSamples + index;
        const driftScale = 1 + (options.clockDriftPpm ?? 0) / 1_000_000;
        const duplicatedSamples =
          options.sourceDuplicateAtMs !== undefined &&
          absoluteIndex >= (options.sourceDuplicateAtMs * options.sampleRateHz) / 1_000
            ? (options.sampleRateHz * 20) / 1_000
            : 0;
        const sourceIndex = (absoluteIndex - duplicatedSamples) * driftScale;
        const direct =
          10_000 *
          Math.sin((2 * Math.PI * options.frequencyHz * sourceIndex) / options.sampleRateHz);
        const echo =
          (options.echoGain ?? 0) *
          10_000 *
          Math.sin(
            (2 * Math.PI * options.frequencyHz * (sourceIndex - (options.echoDelaySamples ?? 0))) /
              options.sampleRateHz,
          );
        const noise = ((((absoluteIndex * 7_919) % 97) - 48) / 48) * (options.noiseAmplitude ?? 0);
        chunk.writeInt16LE(Math.round(direct + echo + noise), index * 2);
      }
      await artifact.write(chunk, 0, chunkSamples * 2);
      writtenSamples += chunkSamples;
    }
  } finally {
    await artifact.close();
  }
  return {
    artifactPath,
    cleanup: () => rm(directory, { force: true, recursive: true }),
  };
}

async function writePcm16Artifact(samples: Int16Array) {
  const directory = await mkdtemp(join(tmpdir(), "iterate-kit-acoustic-analysis-"));
  const artifactPath = join(directory, "fixture.pcm16le");
  const artifact = await open(artifactPath, "w");
  const chunk = Buffer.alloc(64 * 1_024);
  let writtenSamples = 0;
  try {
    while (writtenSamples < samples.length) {
      const chunkSamples = Math.min(chunk.byteLength / 2, samples.length - writtenSamples);
      for (let index = 0; index < chunkSamples; index += 1) {
        chunk.writeInt16LE(samples[writtenSamples + index]!, index * 2);
      }
      await artifact.write(chunk, 0, chunkSamples * 2);
      writtenSamples += chunkSamples;
    }
  } finally {
    await artifact.close();
  }
  return {
    artifactPath,
    cleanup: () => rm(directory, { force: true, recursive: true }),
  };
}

function renderRecording(options: {
  amplitudeAlternation?: {
    highGain: number;
    intervalMs: number;
    lowGain: number;
  };
  coherentLeakageRuns?: {
    endMs: number;
    gain: number;
    startMs: number;
  }[];
  durationMs: number;
  frequencyHz?: number;
  gap?: { endMs: number; startMs: number };
  leadMs?: number;
  sourceSampleShift?: { atMs: number; samples: number };
  trailMs?: number;
}) {
  const leadMs = options.leadMs ?? 200;
  const trailMs = options.trailMs ?? 200;
  const renderedFrequencyHz = options.frequencyHz ?? frequencyHz;
  const sampleCount = ((leadMs + options.durationMs + trailMs) * sampleRateHz) / 1_000;
  const samples = new Int16Array(sampleCount);
  const toneStart = (leadMs * sampleRateHz) / 1_000;
  const toneEnd = ((leadMs + options.durationMs) * sampleRateHz) / 1_000;
  const gapStart = options.gap ? ((leadMs + options.gap.startMs) * sampleRateHz) / 1_000 : -1;
  const gapEnd = options.gap ? ((leadMs + options.gap.endMs) * sampleRateHz) / 1_000 : -1;
  for (let index = 0; index < samples.length; index += 1) {
    /*
     * Fixed low-level broadband-ish background keeps the fixture honest: tone
     * detection must use frequency coherence rather than treating every
     * non-zero microphone sample as audible playback.
     */
    const noise = ((index * 7919) % 97) - 48;
    if (index >= toneStart && index < toneEnd && !(index >= gapStart && index < gapEnd)) {
      const relativeToneIndex = index - toneStart;
      const shiftedToneIndex =
        options.sourceSampleShift &&
        relativeToneIndex >= (options.sourceSampleShift.atMs * sampleRateHz) / 1_000
          ? relativeToneIndex + options.sourceSampleShift.samples
          : relativeToneIndex;
      const amplitudeGain = options.amplitudeAlternation
        ? Math.floor(
            relativeToneIndex / ((options.amplitudeAlternation.intervalMs * sampleRateHz) / 1_000),
          ) %
            2 ===
          0
          ? options.amplitudeAlternation.highGain
          : options.amplitudeAlternation.lowGain
        : 1;
      samples[index] = Math.round(
        amplitudeGain *
          12_000 *
          Math.sin((2 * Math.PI * renderedFrequencyHz * shiftedToneIndex) / sampleRateHz) +
          noise,
      );
    } else {
      const recordingTimeMs = (index * 1_000) / sampleRateHz;
      const leakage = options.coherentLeakageRuns?.find(
        (run) => recordingTimeMs >= run.startMs && recordingTimeMs < run.endMs,
      );
      samples[index] =
        leakage === undefined
          ? noise
          : Math.round(
              leakage.gain *
                12_000 *
                Math.sin((2 * Math.PI * renderedFrequencyHz * index) / sampleRateHz) +
                noise,
            );
    }
  }
  return samples;
}

describe("acoustic tone analysis", () => {
  test("analyzes a ten-minute artifact without retaining ten minutes of PCM", async () => {
    /*
     * The endurance proof is supposed to run longer as confidence grows.
     * If its oracle calls readFile(), a ten-minute 48 kHz recording adds
     * 57.6 MB twice (Buffer plus Int16Array) and eventually makes test length
     * a memory-risk knob. Use a lower sample rate to keep CI quick while
     * preserving the ten-minute duration, then require the public diagnostic
     * to prove that buffered audio is bounded by one read chunk plus one
     * overlapping correlation window.
     */
    const fixture = await writeLongToneArtifact({
      clockDriftPpm: 500,
      durationMs: 600_000,
      echoDelaySamples: 24,
      echoGain: 0.2,
      frequencyHz: 997,
      noiseAmplitude: 500,
      sampleRateHz: 8_000,
    });
    try {
      const analysis = await analyzeAcousticTonePcm16Artifact({
        artifactPath: fixture.artifactPath,
        expectedDurationMs: 600_000,
        frequencyHz: 997,
        readChunkBytes: 64 * 1_024,
        sampleRateHz: 8_000,
      });

      expect(analysis.totalDurationMs).toBe(600_000);
      expect(analysis.longestInternalGapMs).toBe(0);
      /*
       * A maximum over roughly 240,000 overlapping windows is deliberately
       * adversarial: a per-window detector with even a small false-positive
       * tail will eventually fail a healthy ten-minute run.
       */
      expect(analysis.maximumPhaseStepErrorRadians).toBeLessThan(0.1);
      /*
       * 64 KiB read buffer + one 5 ms PCM16 window at 8 kHz. This exact
       * public diagnostic turns accidental whole-file buffering into a test
       * failure rather than an inference from noisy process RSS.
       */
      expect(analysis.maximumBufferedAudioBytes).toBe(64 * 1_024 + 80);
      expect(
        assessAcousticToneAnalysis(analysis, {
          maximumAmplitudeStepDecibels: 1.5,
          maximumAmplitudeStepP99Decibels: 1.5,
          maximumDurationErrorMs: 20,
          maximumInternalGapMs: 0,
          maximumMissingToneMs: 20,
          maximumPhaseStepErrorRadians: 0.1,
        }),
      ).toEqual({ passed: true, reasons: [] });
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  test("finds one duplicated frame inside a long noisy drifting recording", async () => {
    const fixture = await writeLongToneArtifact({
      clockDriftPpm: 500,
      durationMs: 600_000,
      echoDelaySamples: 24,
      echoGain: 0.2,
      frequencyHz: 997,
      noiseAmplitude: 500,
      sampleRateHz: 8_000,
      sourceDuplicateAtMs: 300_000,
    });
    try {
      const analysis = await analyzeAcousticTonePcm16Artifact({
        artifactPath: fixture.artifactPath,
        expectedDurationMs: 600_000,
        frequencyHz: 997,
        sampleRateHz: 8_000,
      });

      expect(analysis.maximumPhaseStepErrorRadians).toBeGreaterThan(0.2);
      expect(analysis.phaseDiscontinuityCount).toBeGreaterThan(0);
      expect(
        assessAcousticToneAnalysis(analysis, {
          maximumAmplitudeStepDecibels: 1.5,
          maximumAmplitudeStepP99Decibels: 1.5,
          maximumDurationErrorMs: 20,
          maximumInternalGapMs: 0,
          maximumMissingToneMs: 20,
          maximumPhaseStepErrorRadians: 0.1,
        }).passed,
      ).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  test("accepts a continuous room-recorded tone with quiet lead and trail", () => {
    const analysis = analyzeAcousticTonePcm16({
      expectedDurationMs: 2_000,
      frequencyHz,
      samples: renderRecording({ durationMs: 2_000 }),
      sampleRateHz,
    });

    expect(analysis.longestInternalGapMs).toBe(0);
    expect(analysis.missingToneMs).toBeLessThanOrEqual(10);
    /*
     * An overlapping correlation window can extend the detected edge by at
     * most one analysis window. The physical pass/fail threshold below owns
     * that uncertainty; requiring an exact synthetic edge would encourage a
     * detector tuned to this fixture rather than room recordings.
     */
    expect(Math.abs(analysis.observedSpanMs - 2_000)).toBeLessThanOrEqual(
      analysis.windowDurationMs,
    );
    expect(
      assessAcousticToneAnalysis(analysis, {
        maximumAmplitudeStepDecibels: 1.5,
        maximumAmplitudeStepP99Decibels: 1.5,
        maximumDurationErrorMs: 20,
        maximumInternalGapMs: 10,
        maximumMissingToneMs: 20,
        maximumPhaseStepErrorRadians: 0.1,
      }),
    ).toEqual({ passed: true, reasons: [] });
  });

  test("does not mistake the bounded speaker-onset transient for an internal phase jump", async () => {
    /*
     * A physical codec does not reach its steady acoustic transfer function on
     * the exact sample where correlation first calls the tone present. The
     * production Stick recordings showed the only >0.1 rad phase observation
     * at the very first eligible comparison, with the remaining ~1.95 s
     * continuous. Model that bounded onset settling as a one-sample phase
     * offset during the first half-window.
     *
     * Ignoring a small correlation-edge context is not a relaxed continuity
     * threshold: the whole-frame-duplicate tests below still inject their jump
     * in the interior and must remain red. Both analysis implementations are
     * covered because production uses the bounded-memory artifact reader.
     */
    const leadMs = 200;
    const samples = renderRecording({ durationMs: 2_000, leadMs });
    const toneStartSample = (leadMs * sampleRateHz) / 1_000;
    const settlingSamples = (2.5 * sampleRateHz) / 1_000;
    for (let relativeIndex = 0; relativeIndex < settlingSamples; relativeIndex += 1) {
      const absoluteIndex = toneStartSample + relativeIndex;
      const noise = ((absoluteIndex * 7919) % 97) - 48;
      samples[absoluteIndex] = Math.round(
        12_000 * Math.sin((2 * Math.PI * frequencyHz * (relativeIndex + 1)) / sampleRateHz) + noise,
      );
    }

    const analysis = analyzeAcousticTonePcm16({
      expectedDurationMs: 2_000,
      frequencyHz,
      samples,
      sampleRateHz,
    });
    expect(analysis.maximumPhaseStepErrorRadians).toBeLessThan(0.1);
    expect(analysis.phaseDiscontinuityCount).toBe(0);

    const fixture = await writePcm16Artifact(samples);
    try {
      const artifactAnalysis = await analyzeAcousticTonePcm16Artifact({
        artifactPath: fixture.artifactPath,
        expectedDurationMs: 2_000,
        frequencyHz,
        sampleRateHz,
      });
      expect(artifactAnalysis.maximumPhaseStepErrorRadians).toBeLessThan(0.1);
      expect(artifactAnalysis.phaseDiscontinuityCount).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("reports a jiggly internal hole even when the total tone later resumes", () => {
    const analysis = analyzeAcousticTonePcm16({
      expectedDurationMs: 2_000,
      frequencyHz,
      samples: renderRecording({
        durationMs: 2_000,
        gap: { endMs: 870, startMs: 820 },
      }),
      sampleRateHz,
    });
    const assessment = assessAcousticToneAnalysis(analysis, {
      maximumAmplitudeStepDecibels: 1.5,
      maximumAmplitudeStepP99Decibels: 1.5,
      maximumDurationErrorMs: 20,
      maximumInternalGapMs: 10,
      maximumMissingToneMs: 20,
      maximumPhaseStepErrorRadians: 0.1,
    });

    expect(analysis.longestInternalGapMs).toBeGreaterThanOrEqual(40);
    /*
     * Partly active edge windows deliberately make this a lower bound: the
     * detector must not claim more silence than it actually observed. A
     * 50 ms physical hole still has at least 30 ms of unequivocal silence.
     */
    expect(analysis.missingToneMs).toBeGreaterThanOrEqual(30);
    expect(assessment.passed).toBe(false);
    expect(assessment.reasons.join(" ")).toContain("internal gap");
  });

  test("does not join weak coherent boundary leakage to the played tone", async () => {
    /*
     * A nearby Mac microphone can hear a short, quiet copy of the carrier
     * before or after the actual speaker episode: codec startup leakage,
     * room echo, and recorder processing are all plausible sources. Merely
     * requiring frequency coherence makes those islands look like playback
     * and turns harmless capture lead-in into a fictitious internal outage.
     *
     * Level remains useful for rejecting ring-down, but it cannot reject a
     * full-level buffer replay from an earlier capture. Selecting the longest
     * run would make a same-level tone that resumes after a real outage look
     * healthy. The marker-anchored tests below therefore protect the separate
     * positional boundary while this fixture protects the level boundary.
     */
    const samples = renderRecording({
      coherentLeakageRuns: [
        { endMs: 15, gain: 0.15, startMs: 0 },
        { endMs: 2_775, gain: 0.15, startMs: 2_700 },
      ],
      durationMs: 2_000,
      leadMs: 500,
      trailMs: 500,
    });
    const fixture = await writePcm16Artifact(samples);
    try {
      const analysis = await analyzeAcousticTonePcm16Artifact({
        artifactPath: fixture.artifactPath,
        expectedDurationMs: 2_000,
        frequencyHz,
        sampleRateHz,
      });

      expect(analysis.observedStartMs).toBeCloseTo(500, -1);
      expect(analysis.longestInternalGapMs).toBe(0);
      expect(
        assessAcousticToneAnalysis(analysis, {
          maximumAmplitudeStepDecibels: 1.5,
          maximumAmplitudeStepP99Decibels: 1.5,
          maximumDurationErrorMs: 20,
          maximumInternalGapMs: 0,
          maximumMissingToneMs: 20,
          maximumPhaseStepErrorRadians: 0.1,
        }),
      ).toEqual({ passed: true, reasons: [] });
    } finally {
      await fixture.cleanup();
    }
  });

  test("excludes full-level coherent audio before the capture marker", async () => {
    /*
     * CoreAudio has physically replayed roughly one stale HAL buffer at the
     * start of consecutive captures. In retained runs that buffer can contain
     * the same carrier at full playback level, so neither coherence nor a
     * relative amplitude floor can distinguish it from this run's device.
     *
     * The provider-request capture marker is different: it is recorded before
     * a new response is requested, so playback from that response is
     * impossible before that file position. The analyzer must exclude that
     * region without silently erasing it from diagnostics.
     */
    const fixture = await writePcm16Artifact(
      renderRecording({
        coherentLeakageRuns: [{ endMs: 11, gain: 1, startMs: 0 }],
        durationMs: 2_000,
        leadMs: 500,
        trailMs: 500,
      }),
    );
    try {
      const analysis = await analyzeAcousticTonePcm16Artifact({
        analysisStartMs: 341,
        artifactPath: fixture.artifactPath,
        expectedDurationMs: 2_000,
        frequencyHz,
        sampleRateHz,
      });

      expect(analysis.observedStartMs).toBeCloseTo(500, -1);
      expect(analysis.longestInternalGapMs).toBe(0);
      expect(analysis.excludedCoherentWindowCount).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("does not let a capture marker hide a real mid-stream outage", () => {
    /*
     * A positional anchor is safe only if it changes the attribution boundary,
     * not the waveform policy inside that boundary. This is deliberately the
     * same stale full-level head followed by a real 300 ms device outage. A
     * longest-episode heuristic would be tempted to select one healthy half;
     * the external marker must leave the internal outage intact.
     */
    const analysis = analyzeAcousticTonePcm16({
      analysisStartMs: 341,
      expectedDurationMs: 2_000,
      frequencyHz,
      samples: renderRecording({
        coherentLeakageRuns: [{ endMs: 11, gain: 1, startMs: 0 }],
        durationMs: 2_000,
        gap: { endMs: 1_150, startMs: 850 },
        leadMs: 500,
        trailMs: 500,
      }),
      sampleRateHz,
    });

    expect(analysis.longestInternalGapMs).toBeGreaterThanOrEqual(290);
  });

  test("keeps coherent pre-onset audio visible when it occurs after the marker", () => {
    /*
     * The marker is a statement of physical possibility, not a generic
     * pre-roll cleanser. Coherent audio after the request may be a genuine
     * stale device frame or an unintended codec start, so the quiet interval
     * between it and normal playback must remain an attributable gap.
     */
    const analysis = analyzeAcousticTonePcm16({
      analysisStartMs: 341,
      expectedDurationMs: 2_000,
      frequencyHz,
      samples: renderRecording({
        coherentLeakageRuns: [{ endMs: 375, gain: 1, startMs: 360 }],
        durationMs: 2_000,
        leadMs: 500,
        trailMs: 500,
      }),
      sampleRateHz,
    });

    expect(analysis.observedStartMs).toBeCloseTo(360, -1);
    expect(analysis.longestInternalGapMs).toBeGreaterThanOrEqual(110);
  });

  test("rejects sustained gain jiggle even when tone presence and phase stay perfect", async () => {
    /*
     * The first physical Stick tone sounded periodically “jiggly” without
     * becoming silent. A presence/phase-only oracle calls this waveform
     * perfect: every 5 ms window contains the right frequency at the right
     * phase. The local high-percentile gain-step metric must catch sustained
     * 20 ms volume pumping without making one room-noise outlier decisive.
     */
    const samples = renderRecording({
      amplitudeAlternation: {
        highGain: 0.95,
        intervalMs: 20,
        lowGain: 0.45,
      },
      durationMs: 2_000,
      frequencyHz: 997,
    });
    const thresholds = {
      maximumAmplitudeStepDecibels: 1.5,
      maximumAmplitudeStepP99Decibels: 1.5,
      maximumDurationErrorMs: 20,
      maximumInternalGapMs: 0,
      maximumMissingToneMs: 20,
      maximumPhaseStepErrorRadians: 0.1,
    };
    const analysis = analyzeAcousticTonePcm16({
      expectedDurationMs: 2_000,
      frequencyHz: 997,
      samples,
      sampleRateHz,
    });

    expect(analysis.longestInternalGapMs).toBe(0);
    expect(analysis.maximumPhaseStepErrorRadians).toBeLessThan(0.1);
    expect(Reflect.get(analysis, "amplitudeStepP99Decibels")).toBeGreaterThan(
      thresholds.maximumAmplitudeStepP99Decibels,
    );
    expect(assessAcousticToneAnalysis(analysis, thresholds).passed).toBe(false);

    const fixture = await writePcm16Artifact(samples);
    try {
      const artifactAnalysis = await analyzeAcousticTonePcm16Artifact({
        artifactPath: fixture.artifactPath,
        expectedDurationMs: 2_000,
        frequencyHz: 997,
        sampleRateHz,
      });
      expect(artifactAnalysis.amplitudeStepP99Decibels).toBeGreaterThan(
        thresholds.maximumAmplitudeStepP99Decibels,
      );
      expect(assessAcousticToneAnalysis(artifactAnalysis, thresholds).passed).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  test.each([
    { durationMs: 1, startMs: 800 },
    { durationMs: 2, startMs: 800.37 },
  ])(
    "rejects a $durationMs ms isolated dropout without relying on carrier phase",
    async ({ durationMs, startMs }) => {
      /*
       * A 997 Hz carrier can make an approximately one-cycle deletion nearly
       * phase-invisible, while a five-millisecond coherence window can remain
       * active through a short zero interval. The edge-trimmed maximum local
       * envelope step is the independent evidence for this rare click; a
       * percentile alone would dilute it across a ten-minute recording.
       */
      const samples = renderRecording({
        durationMs: 2_000,
        frequencyHz: 997,
        gap: { endMs: startMs + durationMs, startMs },
      });
      const thresholds = {
        maximumAmplitudeStepDecibels: 1.5,
        maximumAmplitudeStepP99Decibels: 1.5,
        maximumDurationErrorMs: 20,
        maximumInternalGapMs: 0,
        maximumMissingToneMs: 20,
        maximumPhaseStepErrorRadians: 0.1,
      };
      const analysis = analyzeAcousticTonePcm16({
        expectedDurationMs: 2_000,
        frequencyHz: 997,
        samples,
        sampleRateHz,
      });

      expect(analysis.maximumAmplitudeStepDecibels).toBeGreaterThan(
        thresholds.maximumAmplitudeStepDecibels,
      );
      expect(assessAcousticToneAnalysis(analysis, thresholds).passed).toBe(false);

      const fixture = await writePcm16Artifact(samples);
      try {
        const artifactAnalysis = await analyzeAcousticTonePcm16Artifact({
          artifactPath: fixture.artifactPath,
          expectedDurationMs: 2_000,
          frequencyHz: 997,
          sampleRateHz,
        });
        expect(artifactAnalysis.maximumAmplitudeStepDecibels).toBeGreaterThan(
          thresholds.maximumAmplitudeStepDecibels,
        );
        expect(assessAcousticToneAnalysis(artifactAnalysis, thresholds).passed).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  test("finds a dropout split across adjacent analysis-window boundaries", async () => {
    /*
     * A non-overlapping 10 ms detector can see two plausible half-tone windows
     * when a 5 ms hardware underrun starts 5 ms into one window. The audible
     * interruption then disappears from the metric. This phase-shifted fixture
     * preserves the exact incident Fable found and requires analysis resolution
     * fine enough to make the harness's zero-gap acceptance policy honest.
     */
    const samples = renderRecording({
      durationMs: 2_000,
      gap: { endMs: 830, startMs: 825 },
    });
    const analysis = analyzeAcousticTonePcm16({
      expectedDurationMs: 2_000,
      frequencyHz,
      samples,
      sampleRateHz,
    });

    expect(analysis.longestInternalGapMs).toBeGreaterThan(0);

    const fixture = await writePcm16Artifact(samples);
    try {
      const artifactAnalysis = await analyzeAcousticTonePcm16Artifact({
        artifactPath: fixture.artifactPath,
        expectedDurationMs: 2_000,
        frequencyHz,
        sampleRateHz,
      });
      expect(artifactAnalysis.longestInternalGapMs).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("finds a whole-frame duplicate even when tone magnitude never drops", async () => {
    /*
     * At 997 Hz a duplicated 20 ms frame creates a phase jump but no silence.
     * Magnitude-only correlation calls every window active, so the endurance
     * harness must retain phase and reject this otherwise inaudible-to-the-
     * analyzer data-integrity failure.
     */
    const samples = renderRecording({
      durationMs: 2_000,
      frequencyHz: 997,
      sourceSampleShift: {
        atMs: 1_000,
        samples: -(sampleRateHz * 20) / 1_000,
      },
    });
    const analysis = analyzeAcousticTonePcm16({
      expectedDurationMs: 2_000,
      frequencyHz: 997,
      samples,
      sampleRateHz,
    });

    expect(analysis).toMatchObject({
      maximumPhaseStepErrorRadians: expect.any(Number),
      phaseDiscontinuityCount: expect.any(Number),
    });
    expect(Reflect.get(analysis, "maximumPhaseStepErrorRadians")).toBeGreaterThan(0.2);
    expect(Reflect.get(analysis, "phaseDiscontinuityCount")).toBeGreaterThan(0);

    const fixture = await writePcm16Artifact(samples);
    try {
      const artifactAnalysis = await analyzeAcousticTonePcm16Artifact({
        artifactPath: fixture.artifactPath,
        expectedDurationMs: 2_000,
        frequencyHz: 997,
        sampleRateHz,
      });
      expect(artifactAnalysis.maximumPhaseStepErrorRadians).toBeGreaterThan(0.2);
      expect(artifactAnalysis.phaseDiscontinuityCount).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects invalid analysis inputs instead of manufacturing a pass", () => {
    expect(() =>
      analyzeAcousticTonePcm16({
        expectedDurationMs: 1_000,
        frequencyHz: sampleRateHz / 2,
        samples: new Int16Array(100),
        sampleRateHz,
      }),
    ).toThrow("frequency");
    expect(() =>
      analyzeAcousticTonePcm16({
        expectedDurationMs: 1_000,
        frequencyHz,
        samples: new Int16Array(0),
        sampleRateHz,
      }),
    ).toThrow("samples");
  });
});
