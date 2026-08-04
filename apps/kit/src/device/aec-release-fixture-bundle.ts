import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { renderPcm16Le } from "../voice/deterministic-pcm-renderers.ts";
import {
  createAecReleaseFixturePlan,
  createAecReleaseFixtureRenderer,
  type AecReleaseFixturePlan,
  type AecReleaseFarSource,
} from "./aec-release-fixture-plan.ts";
import type { AecReleaseDevice } from "./aec-release-matrix.ts";

export interface AecReleasePcmArtifact {
  bytes: number;
  measuredPeak: number;
  path: string;
  sha256: string;
}

export function repeatPcm16LeToDuration(
  source: Uint8Array,
  options: { durationMs: number; sampleRateHz: number },
) {
  if (source.byteLength === 0 || source.byteLength % 2 !== 0) {
    throw new Error("AEC near source must contain whole non-empty PCM16 samples.");
  }
  const targetBytes = (options.durationMs * options.sampleRateHz * 2) / 1_000;
  if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0) {
    throw new Error("AEC near source duration must produce whole positive PCM16 samples.");
  }
  const repeated = new Uint8Array(targetBytes);
  for (let offset = 0; offset < repeated.byteLength; offset += source.byteLength) {
    repeated.set(
      source.subarray(0, Math.min(source.byteLength, repeated.byteLength - offset)),
      offset,
    );
  }
  return repeated;
}

const fileArtifactSchema = z.strictObject({
  bytes: z.number().int().positive().safe(),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const pcmArtifactSchema = fileArtifactSchema.extend({
  measuredPeak: z.number().int().min(1).max(32_767),
});
const phaseArtifactSchema = z.strictObject({
  farArtifact: pcmArtifactSchema.nullable(),
  id: z.string().min(1),
  nearArtifact: z
    .strictObject({
      macOutputVolumePercent: z.number().int().min(1).max(100),
      pcmPath: z.string().min(1),
      pcmSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      wavePath: z.string().min(1),
      waveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .nullable(),
});
const fixtureManifestSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  farSpeechArtifact: z.strictObject({
    bytes: z.number().int().positive().safe(),
    pcmPath: z.string().min(1),
    pcmSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    rateWordsPerMinute: z.number().int().positive().safe(),
    sourceClippedSamples: z.literal(0),
    synthesisWaveBytes: z.number().int().positive().safe(),
    synthesisWavePath: z.string().min(1),
    synthesisWaveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    text: z.string().min(1),
    voice: z.string().min(1),
  }),
  nearArtifact: z.strictObject({
    bytes: z.number().int().positive().safe(),
    durationMs: z.number().int().positive().safe(),
    pcmPath: z.string().min(1),
    pcmSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    rateWordsPerMinute: z.number().int().positive().safe(),
    sourceClippedSamples: z.literal(0),
    synthesisWaveBytes: z.number().int().positive().safe(),
    synthesisWavePath: z.string().min(1),
    synthesisWaveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    text: z.string().min(1),
    voice: z.string().min(1),
    waveBytes: z.number().int().positive().safe(),
    wavePath: z.string().min(1),
    waveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  phaseArtifacts: z.array(phaseArtifactSchema),
  plan: z.unknown(),
  schemaVersion: z.literal(2),
  sourceCalibration: z.string().min(1),
});

export interface LoadedAecReleaseFixtureBundle {
  directory: string;
  farSpeechArtifact: z.infer<typeof fixtureManifestSchema>["farSpeechArtifact"];
  manifestSha256: string;
  nearArtifact: z.infer<typeof fixtureManifestSchema>["nearArtifact"];
  phaseArtifacts: ReadonlyMap<string, z.infer<typeof phaseArtifactSchema>>;
  plan: AecReleaseFixturePlan;
  readFarPcm(phaseId: string): Promise<Uint8Array>;
  readNearPcm(): Promise<Uint8Array>;
  readNearWave(): Promise<Uint8Array>;
}

/**
 * Loads the immutable plan and verifies each source lazily at speaker use.
 *
 * The ten-minute source is about 19 MB. Retaining all 28 sources in memory
 * would make the Mac harness needlessly unlike the bounded device path, while
 * trusting only startup metadata would permit post-load mutation. The runner
 * therefore gets a phase reader which resolves and hashes that one file again
 * immediately before constructing its one-shot provider renderer.
 */
export async function loadAecReleaseFixtureBundle(options: {
  bundleDirectory: string;
  expectedDeviceId: AecReleaseDevice;
  expectedMac: string;
}): Promise<LoadedAecReleaseFixtureBundle> {
  const directory = await realpath(options.bundleDirectory);
  const manifestBytes = await readFile(resolve(directory, "fixture-manifest.json"));
  const rawManifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  const manifest = fixtureManifestSchema.parse(rawManifest);
  if (!manifest.plan || typeof manifest.plan !== "object") {
    throw new Error("AEC fixture manifest has no release plan object.");
  }
  const rawPlan = manifest.plan as Record<string, unknown>;
  if (typeof rawPlan.runId !== "string" || !rawPlan.runId) {
    throw new Error("AEC fixture manifest plan has no run ID.");
  }
  const plan = createAecReleaseFixturePlan(rawPlan.calibration, {
    expectedDeviceId: options.expectedDeviceId,
    expectedMac: options.expectedMac,
    runId: rawPlan.runId,
  });
  if (!isDeepStrictEqual(rawPlan, plan)) {
    throw new Error("AEC fixture manifest plan differs from the canonical shared release matrix.");
  }
  if (manifest.phaseArtifacts.length !== plan.phases.length) {
    throw new Error(
      `AEC fixture manifest has ${manifest.phaseArtifacts.length} phase artifacts; ` +
        `expected ${plan.phases.length}.`,
    );
  }
  const phaseArtifacts = new Map<string, z.infer<typeof phaseArtifactSchema>>();
  await Promise.all([
    readVerifiedBundleArtifact(directory, {
      bytes: manifest.farSpeechArtifact.bytes,
      path: manifest.farSpeechArtifact.pcmPath,
      sha256: manifest.farSpeechArtifact.pcmSha256,
    }),
    readVerifiedBundleArtifact(directory, {
      bytes: manifest.farSpeechArtifact.synthesisWaveBytes,
      path: manifest.farSpeechArtifact.synthesisWavePath,
      sha256: manifest.farSpeechArtifact.synthesisWaveSha256,
    }),
  ]);
  const maximumNearDurationMs = Math.max(
    ...plan.phases.filter((phase) => phase.nearSource !== null).map((phase) => phase.durationMs),
  );
  const expectedNearBytes = (maximumNearDurationMs * plan.sampleRateHz * 2) / 1_000;
  if (
    manifest.nearArtifact.durationMs !== maximumNearDurationMs ||
    manifest.nearArtifact.bytes !== expectedNearBytes
  ) {
    throw new Error("AEC fixture near source does not cover the longest near-end phase exactly.");
  }
  for (let index = 0; index < plan.phases.length; index += 1) {
    const phase = plan.phases[index]!;
    const artifact = manifest.phaseArtifacts[index]!;
    if (artifact.id !== phase.id || phaseArtifacts.has(artifact.id)) {
      throw new Error(
        `AEC fixture phase ${index} was ${artifact.id}; expected ordered phase ${phase.id}.`,
      );
    }
    if ((phase.farSource === null) !== (artifact.farArtifact === null)) {
      throw new Error(`AEC fixture phase ${phase.id} has inconsistent far-source evidence.`);
    }
    if (phase.farSource && artifact.farArtifact?.measuredPeak !== phase.farSource.peakAmplitude) {
      throw new Error(`AEC fixture phase ${phase.id} did not reach its exact calibrated peak.`);
    }
    if ((phase.nearSource === null) !== (artifact.nearArtifact === null)) {
      throw new Error(`AEC fixture phase ${phase.id} has inconsistent near-source evidence.`);
    }
    if (
      phase.nearSource &&
      (artifact.nearArtifact?.macOutputVolumePercent !== phase.nearSource.macOutputVolumePercent ||
        artifact.nearArtifact.pcmPath !== manifest.nearArtifact.pcmPath ||
        artifact.nearArtifact.pcmSha256 !== manifest.nearArtifact.pcmSha256 ||
        artifact.nearArtifact.wavePath !== manifest.nearArtifact.wavePath ||
        artifact.nearArtifact.waveSha256 !== manifest.nearArtifact.waveSha256)
    ) {
      throw new Error(`AEC fixture phase ${phase.id} does not reference the retained near source.`);
    }
    phaseArtifacts.set(artifact.id, artifact);
  }
  return {
    directory,
    farSpeechArtifact: manifest.farSpeechArtifact,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    nearArtifact: manifest.nearArtifact,
    phaseArtifacts,
    plan,
    async readFarPcm(phaseId) {
      const phase = phaseArtifacts.get(phaseId);
      if (!phase) throw new Error(`AEC fixture bundle has no phase ${phaseId}.`);
      if (!phase.farArtifact) throw new Error(`AEC fixture phase ${phaseId} has no far source.`);
      return readVerifiedAecPcmArtifact(directory, {
        bytes: phase.farArtifact.bytes,
        path: phase.farArtifact.path,
        sha256: phase.farArtifact.sha256,
      });
    },
    readNearPcm() {
      return readVerifiedAecPcmArtifact(directory, {
        bytes: manifest.nearArtifact.bytes,
        path: manifest.nearArtifact.pcmPath,
        sha256: manifest.nearArtifact.pcmSha256,
      });
    },
    readNearWave() {
      return readVerifiedBundleArtifact(directory, {
        bytes: manifest.nearArtifact.waveBytes,
        path: manifest.nearArtifact.wavePath,
        sha256: manifest.nearArtifact.waveSha256,
      });
    },
  };
}

export async function readVerifiedAecPcmArtifact(
  bundleDirectory: string,
  artifact: { bytes: number; path: string; sha256: string },
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes <= 0 ||
    artifact.bytes % Int16Array.BYTES_PER_ELEMENT !== 0 ||
    !/^[a-f0-9]{64}$/u.test(artifact.sha256)
  ) {
    throw new Error("AEC PCM artifact metadata is malformed.");
  }
  return readVerifiedBundleArtifact(bundleDirectory, artifact, true);
}

async function readVerifiedBundleArtifact(
  bundleDirectory: string,
  artifact: { bytes: number; path: string; sha256: string },
  requirePcm16 = false,
): Promise<Uint8Array> {
  if (!fileArtifactSchema.safeParse(artifact).success) {
    throw new Error("AEC fixture artifact metadata is malformed.");
  }
  if (requirePcm16 && artifact.bytes % Int16Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("AEC PCM artifact metadata is malformed.");
  }
  const root = await realpath(bundleDirectory);
  const requested = resolve(root, artifact.path);
  /*
   * Fixture paths cross a trust boundary when a retained manifest is reused.
   * Refuse absolute/traversal escapes before reading: authenticated tunnel
   * access does not make arbitrary host files valid audio fixtures.
   */
  if (requested !== root && !requested.startsWith(`${root}/`)) {
    throw new Error(`AEC PCM artifact ${artifact.path} escaped its fixture bundle.`);
  }
  const actual = await realpath(requested);
  if (actual !== root && !actual.startsWith(`${root}/`)) {
    throw new Error(`AEC PCM artifact ${artifact.path} escaped its fixture bundle.`);
  }
  const bytes = await readFile(actual);
  if (bytes.byteLength !== artifact.bytes) {
    throw new Error(
      `AEC PCM artifact ${artifact.path} had ${bytes.byteLength} bytes; expected ${artifact.bytes}.`,
    );
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== artifact.sha256) {
    throw new Error(`AEC PCM artifact ${artifact.path} hash did not match its manifest.`);
  }
  return bytes;
}

/**
 * Materializes and verifies one phase before it can reach a physical speaker.
 *
 * The full ten-minute phase is about 19 MB at 16 kHz mono, which is modest on
 * the Mac and deliberately never enters ESP memory. Keeping the complete file
 * makes playback byte-identical, supports offline rescoring without rerunning
 * hardware, and prevents a late renderer exception from masquerading as a
 * device socket failure halfway through a release experiment.
 */
export async function writeAecReleaseFarSource(options: {
  durationMs: number;
  path: string;
  source: AecReleaseFarSource;
}): Promise<AecReleasePcmArtifact> {
  if (options.source.kind === "retained-speech") {
    throw new Error("Retained AEC speech requires its exact synthesized source bytes.");
  }
  const sampleCount = (options.durationMs * options.source.sampleRateHz) / 1_000;
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0 || sampleCount > 10_000_000) {
    throw new Error("AEC fixture duration must produce at most ten million whole samples.");
  }
  const rendered = renderPcm16Le(
    createAecReleaseFixtureRenderer(options.source),
    sampleCount,
    4_093,
  );
  const renderedPeak = measurePcm16LePeak(rendered);
  if (renderedPeak === 0 || renderedPeak > options.source.peakAmplitude) {
    throw new Error(
      `AEC fixture ${options.source.kind} peak ${renderedPeak} exceeded calibrated ` +
        `boundary ${options.source.peakAmplitude}.`,
    );
  }
  const bytes =
    renderedPeak === options.source.peakAmplitude
      ? rendered
      : normalizePcm16LePeak(rendered, renderedPeak, options.source.peakAmplitude);
  const measuredPeak = measurePcm16LePeak(bytes);
  if (measuredPeak === 0 || measuredPeak > options.source.peakAmplitude) {
    throw new Error(
      `AEC fixture ${options.source.kind} peak ${measuredPeak} exceeded calibrated ` +
        `boundary ${options.source.peakAmplitude}.`,
    );
  }
  await mkdir(dirname(options.path), { recursive: true });
  await writeFile(options.path, bytes);
  return {
    bytes: bytes.byteLength,
    measuredPeak,
    path: options.path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * Turns one retained voice synthesis into exact per-phase speaker bytes.
 *
 * The host performs this before opening a tunnel. Repeating and normalizing a
 * frozen source keeps every physical replay byte-identical while avoiding the
 * weak proxy of asking a speech recognizer to distinguish speech from shaped
 * noise. This function never synthesizes or streams: provenance remains a
 * separately hashed WAVE in the bundle.
 */
export async function writeAecReleaseRetainedFarSpeech(options: {
  durationMs: number;
  path: string;
  peakAmplitude: number;
  sampleRateHz: number;
  source: Uint8Array;
}): Promise<AecReleasePcmArtifact> {
  const repeated = repeatPcm16LeToDuration(options.source, {
    durationMs: options.durationMs,
    sampleRateHz: options.sampleRateHz,
  });
  const sourcePeak = measurePcm16LePeak(repeated);
  if (sourcePeak === 0) throw new Error("Retained AEC far speech was silent.");
  const bytes = normalizePcm16LePeak(repeated, sourcePeak, options.peakAmplitude);
  const measuredPeak = measurePcm16LePeak(bytes);
  if (measuredPeak !== options.peakAmplitude) {
    throw new Error(
      `Retained AEC far speech peak ${measuredPeak} did not reach calibrated ` +
        `drive ${options.peakAmplitude}.`,
    );
  }
  await mkdir(dirname(options.path), { recursive: true });
  await writeFile(options.path, bytes);
  return {
    bytes: bytes.byteLength,
    measuredPeak,
    path: options.path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function measurePcm16LePeak(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let peak = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    peak = Math.max(peak, Math.abs(view.getInt16(offset, true)));
  }
  return peak;
}

function normalizePcm16LePeak(bytes: Uint8Array, measuredPeak: number, targetPeak: number) {
  /*
   * Calibration names an exact PCM drive level. Normalize only after the full
   * phase is materialized so shaped/nonstationary sources keep their crest
   * factor while every stimulus reaches the same known electrical boundary.
   * The retained file—not this renderer—is what the physical runner replays.
   */
  const normalized = bytes.slice();
  const view = new DataView(normalized.buffer, normalized.byteOffset, normalized.byteLength);
  for (let offset = 0; offset < normalized.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true);
    view.setInt16(offset, Math.round((sample * targetPeak) / measuredPeak), true);
  }
  return normalized;
}
