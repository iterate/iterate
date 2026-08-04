import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadAecReleaseFixtureBundle,
  readVerifiedAecPcmArtifact,
  repeatPcm16LeToDuration,
  writeAecReleaseFarSource,
  writeAecReleaseRetainedFarSpeech,
} from "./aec-release-fixture-bundle.ts";
import { createAecReleaseFixturePlan } from "./aec-release-fixture-plan.ts";

const calibration = {
  artifactDirectory: "evidence/havpe/calibration-2026-08-04",
  calibratedAt: "2026-08-04T09:00:00.000Z",
  codecDrive: { decibels: 0, kind: "aic3204-dac-decibels" as const },
  deviceId: "home-assistant-voice-preview-edition" as const,
  exactMac: "D8:3B:DA:46:20:34",
  levels: {
    "maximum-non-clipping": {
      pcmPeakAmplitude: 6_000,
      playoutClippedSamples: 0,
      rawMicClippedSamples: 0,
      sourceClippedSamples: 0,
    },
    nominal: {
      pcmPeakAmplitude: 4_000,
      playoutClippedSamples: 0,
      rawMicClippedSamples: 0,
      sourceClippedSamples: 0,
    },
    quiet: {
      pcmPeakAmplitude: 2_000,
      playoutClippedSamples: 0,
      rawMicClippedSamples: 0,
      sourceClippedSamples: 0,
    },
  },
  maximumBoundary: {
    nextRejectedAmplitude: 7_000,
    nextRejectedClippedSamples: 17,
    safetyCeilingReached: false,
  },
  nearLevels: {
    loud: { macOutputVolumePercent: 40, sourceClippedSamples: 0 },
    nominal: { macOutputVolumePercent: 30, sourceClippedSamples: 0 },
    quiet: { macOutputVolumePercent: 20, sourceClippedSamples: 0 },
  },
};

describe("AEC release fixture bundle", () => {
  it("builds one exact-duration near source without playback-process gaps", () => {
    /*
     * Launching afplay repeatedly would insert scheduler-dependent silence
     * between utterances. Materialize one complete WAVE instead, including a
     * deterministic final partial repetition when the phase is not a multiple
     * of the synthesized phrase duration.
     */
    expect(
      repeatPcm16LeToDuration(new Uint8Array([1, 0, 2, 0, 3, 0]), {
        durationMs: 5,
        sampleRateHz: 1_000,
      }),
    ).toEqual(new Uint8Array([1, 0, 2, 0, 3, 0, 1, 0, 2, 0]));
  });

  it("writes the exact bounded PCM bytes described by the retained source", async () => {
    /*
     * Qualification must replay a retained file, not regenerate an allegedly
     * equivalent signal while the physical run is already underway. This
     * small fixture pins the writer's byte count, content hash, and measured
     * peak so a corrupt or clipped source fails before any device is flashed.
     */
    const directory = await mkdtemp(join(tmpdir(), "iterate-aec-fixture-"));
    try {
      const path = join(directory, "tone.pcm16le");
      const artifact = await writeAecReleaseFarSource({
        durationMs: 25,
        path,
        source: {
          kind: "tone",
          peakAmplitude: 4_000,
          sampleRateHz: 16_000,
        },
      });
      const bytes = await readFile(path);
      expect(artifact).toEqual({
        bytes: 800,
        measuredPeak: 4_000,
        path,
        sha256: "df90885d0e04dcd5633d274306ec1b428c736d660731e3b58321d5314640355a",
      });
      expect(bytes.byteLength).toBe(800);
      await expect(
        readVerifiedAecPcmArtifact(directory, {
          bytes: artifact.bytes,
          path: "tone.pcm16le",
          sha256: artifact.sha256,
        }),
      ).resolves.toEqual(bytes);
      bytes[0] ^= 1;
      await writeFile(path, bytes);
      await expect(
        readVerifiedAecPcmArtifact(directory, {
          bytes: artifact.bytes,
          path: "tone.pcm16le",
          sha256: artifact.sha256,
        }),
      ).rejects.toThrow(/hash/u);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("normalizes shaped fixtures to the exact calibrated PCM peak", async () => {
    /*
     * Speaker drive levels are release inputs, not descriptive upper bounds.
     * If shaped speech happens to peak well below its calibration value, a
     * nominal-volume test silently becomes a quiet-volume test and results
     * cannot be compared across stimuli or devices.
     */
    const directory = await mkdtemp(join(tmpdir(), "iterate-aec-fixture-"));
    try {
      const artifact = await writeAecReleaseFarSource({
        durationMs: 100,
        path: join(directory, "speech.pcm16le"),
        source: {
          kind: "speech-shaped",
          peakAmplitude: 7_321,
          sampleRateHz: 16_000,
          seed: 42,
        },
      });
      expect(artifact.measuredPeak).toBe(7_321);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("materializes retained real speech at the exact calibrated drive", async () => {
    /*
     * Noise-shaped energy is useful for filter diagnosis but is an easy
     * semantic negative for Grok. Release speech rows must therefore replay a
     * retained voice waveform, byte for byte, while preserving the calibrated
     * electrical peak and exact phase duration.
     */
    const directory = await mkdtemp(join(tmpdir(), "iterate-aec-fixture-"));
    try {
      const source = new Uint8Array([0x10, 0x00, 0xf0, 0xff, 0x20, 0x00]);
      const path = join(directory, "voice.pcm16le");
      const artifact = await writeAecReleaseRetainedFarSpeech({
        durationMs: 5,
        path,
        peakAmplitude: 4_000,
        sampleRateHz: 1_000,
        source,
      });
      expect(artifact.bytes).toBe(10);
      expect(artifact.measuredPeak).toBe(4_000);
      expect(await readFile(path)).toHaveLength(10);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("refuses a bundle-local symlink which resolves outside the retained bundle", async () => {
    /*
     * A manifest is retained evidence and may be reused later. Lexical path
     * containment alone is insufficient because readFile follows symlinks;
     * the verifier must constrain the final filesystem object it hashes.
     */
    const directory = await mkdtemp(join(tmpdir(), "iterate-aec-fixture-"));
    const outside = await mkdtemp(join(tmpdir(), "iterate-aec-outside-"));
    try {
      const bytes = Buffer.from([1, 0]);
      const outsidePath = join(outside, "secret.pcm16le");
      await writeFile(outsidePath, bytes);
      await symlink(outsidePath, join(directory, "linked.pcm16le"));
      await expect(
        readVerifiedAecPcmArtifact(directory, {
          bytes: bytes.byteLength,
          path: "linked.pcm16le",
          sha256: "47dc540c94ceb704a23875c11273e16bb0eeb7c67f7d0c29f633b7c29bfe911b",
        }),
      ).rejects.toThrow(/escaped/u);
    } finally {
      await rm(directory, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("recomputes the canonical matrix and hashes a phase immediately before replay", async () => {
    /*
     * The acquisition process must not trust a plausible-looking manifest or
     * eagerly cache every ten-minute source. Pin the intended seam: canonical
     * phase order is checked at load, while the selected phase file is read
     * and hashed lazily just before the provider consumes it.
     */
    const directory = await mkdtemp(join(tmpdir(), "iterate-aec-fixture-"));
    try {
      const plan = createAecReleaseFixturePlan(calibration, {
        expectedDeviceId: "home-assistant-voice-preview-edition",
        expectedMac: "D8:3B:DA:46:20:34",
        runId: "bundle-load-test",
      });
      const tonePhase = plan.phases.find((phase) => phase.id === "quiet-far-tone")!;
      const tonePath = join(directory, "far", `${tonePhase.id}.pcm16le`);
      const writtenTone = await writeAecReleaseFarSource({
        durationMs: tonePhase.durationMs,
        path: tonePath,
        source: tonePhase.farSource!,
      });
      const nearArtifact = {
        bytes: 640_000,
        durationMs: 20_000,
        pcmPath: "near/speech.pcm16le",
        pcmSha256: "0".repeat(64),
        rateWordsPerMinute: 180,
        sourceClippedSamples: 0,
        synthesisWaveBytes: 2,
        synthesisWavePath: "near/synthesized-once.wav",
        synthesisWaveSha256: "3".repeat(64),
        text: "Retained speech",
        voice: "Samantha",
        waveBytes: 2,
        wavePath: "near/speech.wav",
        waveSha256: "1".repeat(64),
      };
      const phaseArtifacts = plan.phases.map((phase) => ({
        farArtifact:
          phase.farSource === null
            ? null
            : phase.id === tonePhase.id
              ? { ...writtenTone, path: `far/${tonePhase.id}.pcm16le` }
              : {
                  bytes: (phase.durationMs * plan.sampleRateHz * 2) / 1_000,
                  measuredPeak: phase.farSource.peakAmplitude,
                  path: `far/${phase.id}.pcm16le`,
                  sha256: "2".repeat(64),
                },
        id: phase.id,
        nearArtifact:
          phase.nearSource === null
            ? null
            : {
                macOutputVolumePercent: phase.nearSource.macOutputVolumePercent,
                pcmPath: nearArtifact.pcmPath,
                pcmSha256: nearArtifact.pcmSha256,
                wavePath: nearArtifact.wavePath,
                waveSha256: nearArtifact.waveSha256,
              },
      }));
      const farSpeechBytes = Buffer.from([1, 0]);
      const farSpeechHash = "47dc540c94ceb704a23875c11273e16bb0b8a87aed84de911f2133568115f254";
      await writeFile(join(directory, "far-speech.pcm16le"), farSpeechBytes);
      await writeFile(join(directory, "far-speech.wav"), farSpeechBytes);
      const farSpeechArtifact = {
        bytes: farSpeechBytes.byteLength,
        pcmPath: "far-speech.pcm16le",
        pcmSha256: farSpeechHash,
        rateWordsPerMinute: 165,
        sourceClippedSamples: 0,
        synthesisWaveBytes: farSpeechBytes.byteLength,
        synthesisWavePath: "far-speech.wav",
        synthesisWaveSha256: farSpeechHash,
        text: "Retained far speech",
        voice: "Daniel",
      };
      await writeFile(
        join(directory, "fixture-manifest.json"),
        JSON.stringify({
          createdAt: "2026-08-04T10:00:00.000Z",
          farSpeechArtifact,
          nearArtifact,
          phaseArtifacts,
          plan,
          schemaVersion: 2,
          sourceCalibration: "calibration.json",
        }),
      );

      const loaded = await loadAecReleaseFixtureBundle({
        bundleDirectory: directory,
        expectedDeviceId: "home-assistant-voice-preview-edition",
        expectedMac: "D8:3B:DA:46:20:34",
      });
      await expect(loaded.readFarPcm(tonePhase.id)).resolves.toEqual(await readFile(tonePath));

      phaseArtifacts.reverse();
      await writeFile(
        join(directory, "fixture-manifest.json"),
        JSON.stringify({
          createdAt: "2026-08-04T10:00:00.000Z",
          farSpeechArtifact,
          nearArtifact,
          phaseArtifacts,
          plan,
          schemaVersion: 2,
          sourceCalibration: "calibration.json",
        }),
      );
      await expect(
        loadAecReleaseFixtureBundle({
          bundleDirectory: directory,
          expectedDeviceId: "home-assistant-voice-preview-edition",
          expectedMac: "D8:3B:DA:46:20:34",
        }),
      ).rejects.toThrow(/ordered phase/u);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
