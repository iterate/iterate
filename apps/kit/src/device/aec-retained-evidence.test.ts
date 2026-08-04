import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { encodeMonoPcm16Wave } from "./pcm16-wave-file.ts";
import { scoreRetainedAecEvidence } from "./aec-retained-evidence.ts";

const phaseNames = [
  "ambient",
  "far-tone",
  "far-dual-carrier-prbs31",
  "far-speech-shaped",
  "near-only",
  "near-repeat",
  "double-talk",
] as const;

describe("retained AEC evidence scoring", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it("scores the device-clean and transported-uplink lanes independently from retained bytes", async () => {
    /*
     * A network drop can corrupt `/pcm` while the on-device DSP was correct,
     * and a perfect socket can carry bad DSP output without losing a byte.
     * Re-scoring those same bytes as one unnamed signal would destroy the
     * attribution the physical harness exists to provide. This fixture makes
     * the clean plane audibly different from the transported plane and proves
     * the offline result preserves both rather than trusting the old JSON
     * verdict written during acquisition.
     */
    const runDirectory = await mkdtemp(join(tmpdir(), "iterate-aec-evidence-"));
    temporaryDirectories.push(runDirectory);
    const sampleRateHz = 16_000;
    const durationSamples = sampleRateHz;
    const nearWaveSamples = sampleRateHz * 2;
    const clean = constantPcm(durationSamples, 100);
    const uplink = constantPcm(durationSamples, 1_000);
    const source = tonePcm(durationSamples, 700, 4_000, sampleRateHz);
    const nearWave = tonePcm(nearWaveSamples, 430, 3_000, sampleRateHz);

    for (const phase of phaseNames) {
      const directory = join(runDirectory, "aec-traces", phase);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "clean.pcm16le"), pcmBytes(clean));
      await writeFile(join(directory, "raw-microphone.pcm16le"), pcmBytes(uplink));
      await writeFile(join(directory, "pcm-uplink.pcm16le"), pcmBytes(uplink));
      await writeFile(
        join(directory, "fixture-downlink.pcm16le"),
        phase === "ambient" ? new Uint8Array() : pcmBytes(source),
      );
      await writeFile(
        join(directory, "metadata.json"),
        JSON.stringify({
          availablePlanes: 17,
          captureSamples: durationSamples,
          capturedSamples: durationSamples,
          sampleRateHz,
          state: 3,
        }),
      );
    }
    await writeFile(
      join(runDirectory, "mac-near-source.wav"),
      encodeMonoPcm16Wave(pcmBytes(nearWave), sampleRateHz),
    );
    await writeFile(
      join(runDirectory, "manifest.json"),
      JSON.stringify({
        device: "home-assistant-voice-preview-edition",
        schemaVersion: 2,
        stimuli: {
          nearSourceWindow: { durationSamples, offsetSamples: 0 },
        },
        transportValidity: {
          captureFailures: 0,
          captureFrameDrops: 0,
          clockDiscontinuities: 0,
          networkValid: true,
          playbackDroppedFrames: 0,
          playbackIntegrityFailures: 0,
          playbackResets: 0,
          playbackUnderrunIncidents: 0,
          recorderComplete: true,
          uplinkFrameDrops: 0,
          uplinkRestarts: 0,
          websocketReconnects: 0,
        },
      }),
    );
    await writeFile(
      join(runDirectory, "aec-metrics.json"),
      JSON.stringify({
        stackchan: [],
        voicePe: phaseNames.flatMap((phase) => [
          { phase, value: { playbackContentSamples: phase === "ambient" ? 0 : 8_000 } },
        ]),
      }),
    );

    const score = await scoreRetainedAecEvidence(runDirectory);

    expect(score.schemaVersion).toBe(1);
    expect(score.deviceSignal.assessment.ambient.dbfs).toBeLessThan(
      score.pcmTransport.assessment.ambient.dbfs,
    );
    expect(score.inputFiles["aec-traces/ambient/clean.pcm16le"]?.sha256).toBe(
      createHash("sha256").update(pcmBytes(clean)).digest("hex"),
    );
    expect(score.deviceSignal.validitySource).toBe("signal-only-zero-fault-baseline");
    expect(score.rawMicrophone.assessment.ambient.dbfs).toBe(
      score.pcmTransport.assessment.ambient.dbfs,
    );
    expect(score.pcmTransport.validitySource).toBe("manifest.transportValidity");
  });

  it("rejects an incomplete device trace instead of silently scoring partial DSP evidence", async () => {
    const runDirectory = await mkdtemp(join(tmpdir(), "iterate-aec-evidence-"));
    temporaryDirectories.push(runDirectory);
    await mkdir(join(runDirectory, "aec-traces", "ambient"), { recursive: true });
    await writeFile(
      join(runDirectory, "aec-traces", "ambient", "metadata.json"),
      JSON.stringify({ captureSamples: 16_000, capturedSamples: 15_680, sampleRateHz: 16_000 }),
    );
    await writeFile(
      join(runDirectory, "manifest.json"),
      JSON.stringify({
        device: "home-assistant-voice-preview-edition",
        schemaVersion: 2,
        transportValidity: {
          captureFailures: 0,
          captureFrameDrops: 0,
          clockDiscontinuities: 0,
          networkValid: true,
          playbackDroppedFrames: 0,
          playbackIntegrityFailures: 0,
          playbackResets: 0,
          playbackUnderrunIncidents: 0,
          recorderComplete: true,
          uplinkFrameDrops: 0,
          uplinkRestarts: 0,
          websocketReconnects: 0,
        },
      }),
    );

    await expect(scoreRetainedAecEvidence(runDirectory)).rejects.toThrow(
      /ambient.*incomplete.*15680.*16000/iu,
    );
  });
});

function pcmBytes(samples: Int16Array) {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

function constantPcm(length: number, value: number) {
  const samples = new Int16Array(length);
  samples.fill(value);
  return samples;
}

function tonePcm(length: number, frequencyHz: number, amplitude: number, sampleRateHz: number) {
  const samples = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    samples[index] = Math.round(
      Math.sin((2 * Math.PI * frequencyHz * index) / sampleRateHz) * amplitude,
    );
  }
  return samples;
}
