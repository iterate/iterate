import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { decodeMonoPcm16Wave, encodeMonoPcm16Wave } from "../src/device/pcm16-wave-file.ts";
import {
  repeatPcm16LeToDuration,
  writeAecReleaseFarSource,
  writeAecReleaseRetainedFarSpeech,
} from "../src/device/aec-release-fixture-bundle.ts";
import { createAecReleaseFixturePlan } from "../src/device/aec-release-fixture-plan.ts";

const executeFile = promisify(execFile);
const nearSpeech = Object.freeze({
  rateWordsPerMinute: 180,
  text:
    "Please verify that this nearby voice remains clear while the device speaker is talking. " +
    "This sentence repeats identically in every comparison phase.",
  voice: "Samantha",
});
const farSpeech = Object.freeze({
  rateWordsPerMinute: 165,
  text:
    "This retained voice is coming from the device speaker and must not return through its " +
    "clean microphone channel. The phrase changes rhythm and consonants so the echo canceller " +
    "must follow real nonstationary speech rather than classify a convenient test noise.",
  voice: "Daniel",
});

interface CliOptions {
  calibrationPath: string;
  outputDirectory: string;
  runId: string;
}

async function main(args: readonly string[]) {
  const options = parseCli(args);
  const rawCalibration: unknown = JSON.parse(await readFile(options.calibrationPath, "utf8"));
  if (!rawCalibration || typeof rawCalibration !== "object") {
    throw new Error("AEC calibration must be a JSON object.");
  }
  const candidate = rawCalibration as Record<string, unknown>;
  if (typeof candidate.deviceId !== "string" || typeof candidate.exactMac !== "string") {
    throw new Error("AEC calibration must declare deviceId and exactMac.");
  }
  const plan = createAecReleaseFixturePlan(rawCalibration, {
    expectedDeviceId: candidate.deviceId as "home-assistant-voice-preview-edition" | "stackchan",
    expectedMac: candidate.exactMac,
    runId: options.runId,
  });
  await mkdir(dirname(options.outputDirectory), { recursive: true });
  await mkdir(options.outputDirectory, { recursive: false });

  /*
   * Generate the independent near source once. Re-synthesizing speech for
   * each phase would make nominal and double-talk captures incomparable even
   * with the same words. The physical runner changes only the retained macOS
   * output-volume calibration while replaying these exact WAVE bytes.
   */
  const nearDirectory = join(options.outputDirectory, "near");
  await mkdir(nearDirectory);
  const synthesisWavePath = join(nearDirectory, "synthesized-once.wav");
  await executeFile("/usr/bin/say", [
    "-v",
    nearSpeech.voice,
    "-r",
    String(nearSpeech.rateWordsPerMinute),
    "-o",
    synthesisWavePath,
    "--file-format=WAVE",
    `--data-format=LEI16@${plan.sampleRateHz}`,
    "--channels=1",
    nearSpeech.text,
  ]);
  const synthesisWave = await readFile(synthesisWavePath);
  const decodedNear = decodeMonoPcm16Wave(synthesisWave);
  if (decodedNear.sampleRateHz !== plan.sampleRateHz) {
    throw new Error(
      `Near source was ${decodedNear.sampleRateHz} Hz, expected ${plan.sampleRateHz}.`,
    );
  }
  const nearDurationMs = Math.max(
    ...plan.phases.filter((phase) => phase.nearSource !== null).map((phase) => phase.durationMs),
  );
  const nearPcm = repeatPcm16LeToDuration(decodedNear.pcm, {
    durationMs: nearDurationMs,
    sampleRateHz: plan.sampleRateHz,
  });
  const nearSourceClippedSamples = countFullScalePcm16LeSamples(nearPcm);
  if (nearSourceClippedSamples > 0) {
    throw new Error(
      `Near source contained ${nearSourceClippedSamples} full-scale samples and is clipped.`,
    );
  }
  const nearPcmPath = join(nearDirectory, "deterministic-speech.pcm16le");
  await writeFile(nearPcmPath, nearPcm);
  const nearWavePath = join(nearDirectory, "deterministic-speech.wav");
  const nearWave = encodeMonoPcm16Wave(nearPcm, plan.sampleRateHz);
  await writeFile(nearWavePath, nearWave);
  const nearArtifact = {
    bytes: nearPcm.byteLength,
    durationMs: nearDurationMs,
    pcmPath: relativeArtifactPath(options.outputDirectory, nearPcmPath),
    pcmSha256: createHash("sha256").update(nearPcm).digest("hex"),
    text: nearSpeech.text,
    voice: nearSpeech.voice,
    rateWordsPerMinute: nearSpeech.rateWordsPerMinute,
    sourceClippedSamples: nearSourceClippedSamples,
    synthesisWaveBytes: synthesisWave.byteLength,
    synthesisWavePath: relativeArtifactPath(options.outputDirectory, synthesisWavePath),
    synthesisWaveSha256: createHash("sha256").update(synthesisWave).digest("hex"),
    waveBytes: nearWave.byteLength,
    wavePath: relativeArtifactPath(options.outputDirectory, nearWavePath),
    waveSha256: createHash("sha256").update(nearWave).digest("hex"),
  };

  /*
   * Far-end speech is synthesized once and retained independently from the
   * Samantha near-end source. Replaying the same voice on both sides would
   * make double-talk artificially correlated; regenerating it per phase would
   * make comparisons depend on host TTS variation rather than the AEC.
   */
  const farSpeechDirectory = join(options.outputDirectory, "far-speech");
  await mkdir(farSpeechDirectory);
  const farSpeechWavePath = join(farSpeechDirectory, "synthesized-once.wav");
  await executeFile("/usr/bin/say", [
    "-v",
    farSpeech.voice,
    "-r",
    String(farSpeech.rateWordsPerMinute),
    "-o",
    farSpeechWavePath,
    "--file-format=WAVE",
    `--data-format=LEI16@${plan.sampleRateHz}`,
    "--channels=1",
    farSpeech.text,
  ]);
  const farSpeechWave = await readFile(farSpeechWavePath);
  const decodedFarSpeech = decodeMonoPcm16Wave(farSpeechWave);
  if (decodedFarSpeech.sampleRateHz !== plan.sampleRateHz) {
    throw new Error(
      `Far speech source was ${decodedFarSpeech.sampleRateHz} Hz, expected ${plan.sampleRateHz}.`,
    );
  }
  const farSpeechClippedSamples = countFullScalePcm16LeSamples(decodedFarSpeech.pcm);
  if (farSpeechClippedSamples > 0) {
    throw new Error(`Far speech source contained ${farSpeechClippedSamples} clipped samples.`);
  }
  const farSpeechPcmPath = join(farSpeechDirectory, "synthesized-once.pcm16le");
  await writeFile(farSpeechPcmPath, decodedFarSpeech.pcm);
  const farSpeechArtifact = {
    bytes: decodedFarSpeech.pcm.byteLength,
    pcmPath: relativeArtifactPath(options.outputDirectory, farSpeechPcmPath),
    pcmSha256: createHash("sha256").update(decodedFarSpeech.pcm).digest("hex"),
    rateWordsPerMinute: farSpeech.rateWordsPerMinute,
    sourceClippedSamples: farSpeechClippedSamples,
    synthesisWaveBytes: farSpeechWave.byteLength,
    synthesisWavePath: relativeArtifactPath(options.outputDirectory, farSpeechWavePath),
    synthesisWaveSha256: createHash("sha256").update(farSpeechWave).digest("hex"),
    text: farSpeech.text,
    voice: farSpeech.voice,
  };

  const phaseArtifacts = [];
  for (const phase of plan.phases) {
    let farArtifact = null;
    if (phase.farSource) {
      const path = join(options.outputDirectory, "far", `${phase.id}.pcm16le`);
      const written =
        phase.farSource.kind === "retained-speech"
          ? await writeAecReleaseRetainedFarSpeech({
              durationMs: phase.durationMs,
              path,
              peakAmplitude: phase.farSource.peakAmplitude,
              sampleRateHz: phase.farSource.sampleRateHz,
              source: decodedFarSpeech.pcm,
            })
          : await writeAecReleaseFarSource({
              durationMs: phase.durationMs,
              path,
              source: phase.farSource,
            });
      farArtifact = {
        ...written,
        path: relativeArtifactPath(options.outputDirectory, written.path),
      };
    }
    phaseArtifacts.push({
      farArtifact,
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
    });
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    farSpeechArtifact,
    nearArtifact,
    phaseArtifacts,
    plan,
    schemaVersion: 2,
    sourceCalibration: basename(options.calibrationPath),
  };
  await writeFile(
    join(options.outputDirectory, "fixture-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(
    `aec_fixture_bundle_complete device=${plan.calibration.deviceId} phases=${plan.phases.length} ` +
      `output=${options.outputDirectory}`,
  );
}

function parseCli(args: readonly string[]): CliOptions {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  let calibrationPath: string | undefined;
  let outputDirectory: string | undefined;
  let runId: string = randomUUID();
  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index];
    const value = normalized[index + 1];
    if (argument === "--calibration" && value) calibrationPath = resolve(value);
    else if (argument === "--output" && value) outputDirectory = resolve(value);
    else if (argument === "--run-id" && value) runId = value;
    else throw new Error(`Unknown or incomplete AEC fixture argument ${argument}.`);
    index += 1;
  }
  if (!calibrationPath || !outputDirectory || !runId) {
    throw new Error("Usage: --calibration <json> --output <new-directory> [--run-id <id>]");
  }
  return { calibrationPath, outputDirectory, runId };
}

function relativeArtifactPath(outputDirectory: string, path: string) {
  const prefix = `${outputDirectory}/`;
  if (!path.startsWith(prefix)) throw new Error(`Artifact ${path} escaped ${outputDirectory}.`);
  return path.slice(prefix.length);
}

function countFullScalePcm16LeSamples(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let clipped = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true);
    if (sample === -32_768 || sample === 32_767) clipped += 1;
  }
  return clipped;
}

await main(process.argv.slice(2));
