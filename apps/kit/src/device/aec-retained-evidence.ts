import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assessAecWaveformRun,
  type AecWaveformAssessment,
  type AecWaveformRunInput,
  type AecWaveformTransportValidity,
} from "./aec-waveform-assessment.ts";
import { decodeMonoPcm16Wave } from "./pcm16-wave-file.ts";
import { stackChanMatchedReferenceObserved } from "./physical-aec-playback-observation.ts";

const phases = [
  "ambient",
  "far-tone",
  "far-dual-carrier-prbs31",
  "far-speech-shaped",
  "near-only",
  "near-repeat",
  "double-talk",
] as const;

type Phase = (typeof phases)[number];
type Device = "home-assistant-voice-preview-edition" | "stackchan";

interface Manifest {
  device: Device;
  schemaVersion: number;
  stimuli?: {
    nearSourceWindow?: {
      durationSamples?: number;
      offsetSamples?: number;
    };
  };
  transportValidity: AecWaveformTransportValidity;
}

interface TimedMetric {
  phase?: unknown;
  value?: Record<string, unknown>;
}

interface AecMetricsFile {
  stackchan?: TimedMetric[];
  voicePe?: TimedMetric[];
}

export interface RetainedAecEvidenceScore {
  device: Device;
  deviceSignal: {
    assessment: AecWaveformAssessment;
    lane: "device-clean-trace";
    validitySource: "signal-only-zero-fault-baseline";
  };
  inputFiles: Record<string, { bytes: number; sha256: string }>;
  passed: boolean;
  pcmTransport: {
    assessment: AecWaveformAssessment;
    lane: "userspace-pcm-uplink";
    validitySource: "manifest.transportValidity";
  };
  rawMicrophone: {
    assessment: AecWaveformAssessment;
    lane: "device-raw-microphone-trace";
    validitySource: "signal-only-zero-fault-baseline";
  };
  schemaVersion: 1;
  transportValidity: AecWaveformTransportValidity;
}

/**
 * Re-scores a retained physical AEC run without contacting the device, Mac
 * audio stack, network, or provider.
 *
 * The two output lanes answer deliberately different questions. The bounded
 * device trace is the DSP oracle: it is captured at the audio owner before a
 * socket can lose or delay it. The `/pcm` recording is the production media
 * oracle: it proves what userspace actually received. Keeping both avoids a
 * seductive but false single score where a network fault can condemn correct
 * AEC, or perfect transport can launder bad AEC. All bytes used by either
 * score are hashed into the result so a later rerun identifies its exact
 * inputs rather than merely referring to a mutable directory.
 */
export async function scoreRetainedAecEvidence(
  runDirectory: string,
): Promise<RetainedAecEvidenceScore> {
  const inputFiles: RetainedAecEvidenceScore["inputFiles"] = {};
  const readTracked = async (relativePath: string) => {
    const bytes = await readFile(join(runDirectory, relativePath));
    inputFiles[relativePath] = {
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    return bytes;
  };
  const readJson = async <Value>(relativePath: string) =>
    JSON.parse((await readTracked(relativePath)).toString("utf8")) as Value;

  const manifest = validateManifest(await readJson<unknown>("manifest.json"));
  const metadata = {} as Record<Phase, TraceMetadata>;
  for (const phase of phases) {
    const value = validateTraceMetadata(
      phase,
      await readJson<unknown>(`aec-traces/${phase}/metadata.json`),
    );
    if (value.capturedSamples !== value.captureSamples) {
      throw new Error(
        `${phase} device trace is incomplete: captured ${value.capturedSamples} of ` +
          `${value.captureSamples} samples.`,
      );
    }
    metadata[phase] = value;
  }
  const sampleRates = new Set(phases.map((phase) => metadata[phase].sampleRateHz));
  if (sampleRates.size !== 1) {
    throw new Error("Retained AEC trace phases do not share one sample rate.");
  }
  const sampleRateHz = metadata.ambient.sampleRateHz;
  const metrics = await readJson<AecMetricsFile>("aec-metrics.json");
  const nearWave = decodeMonoPcm16Wave(await readTracked("mac-near-source.wav"));
  if (nearWave.sampleRateHz !== sampleRateHz) {
    throw new Error(
      `Retained near source is ${nearWave.sampleRateHz} Hz but device traces are ${sampleRateHz} Hz.`,
    );
  }
  const nearSource = sliceNearSource(nearWave.pcm, sampleRateHz, manifest);

  const playbackObserved = (phase: Phase) =>
    phase !== "ambient" && phasePlaybackObserved(manifest.device, phase, metrics);
  const loadLane = async (
    lane: "clean.pcm16le" | "pcm-uplink.pcm16le" | "raw-microphone.pcm16le",
  ) => {
    const signals = {} as Record<Phase, Int16Array>;
    for (const phase of phases) {
      signals[phase] = decodePcm16Le(await readTracked(`aec-traces/${phase}/${lane}`));
    }
    return signals;
  };
  const sources = {} as Record<Exclude<Phase, "ambient">, Int16Array>;
  for (const phase of phases) {
    if (phase === "ambient") continue;
    sources[phase] = decodePcm16Le(
      await readTracked(`aec-traces/${phase}/fixture-downlink.pcm16le`),
    );
  }
  /*
   * Retain and hash the intentionally empty ambient downlink as affirmative
   * proof that silence was commanded, even though the waveform assessor does
   * not consume a source for that phase.
   */
  await readTracked("aec-traces/ambient/fixture-downlink.pcm16le");

  const [deviceClean, pcmUplink, rawMicrophone] = await Promise.all([
    loadLane("clean.pcm16le"),
    loadLane("pcm-uplink.pcm16le"),
    loadLane("raw-microphone.pcm16le"),
  ]);
  const deviceSignalAssessment = assessAecWaveformRun(
    buildAssessmentInput({
      clean: deviceClean,
      nearSource,
      playbackObserved,
      sampleRateHz,
      sources,
      validity: signalOnlyValidity(),
    }),
  );
  const pcmTransportAssessment = assessAecWaveformRun(
    buildAssessmentInput({
      clean: pcmUplink,
      nearSource,
      playbackObserved,
      sampleRateHz,
      sources,
      validity: manifest.transportValidity,
    }),
  );
  /*
   * Raw microphone is diagnostic, never an acceptance substitute: it should
   * fail far-end suppression, but its near-repeat and double-talk numbers show
   * whether room/source variability or the selected XMOS stages introduced a
   * preservation change. Keeping the identical oracle shape makes that A/B
   * mechanical while `passed` below still depends only on clean and `/pcm`.
   */
  const rawMicrophoneAssessment = assessAecWaveformRun(
    buildAssessmentInput({
      clean: rawMicrophone,
      nearSource,
      playbackObserved,
      sampleRateHz,
      sources,
      validity: signalOnlyValidity(),
    }),
  );

  return {
    device: manifest.device,
    deviceSignal: {
      assessment: deviceSignalAssessment,
      lane: "device-clean-trace",
      validitySource: "signal-only-zero-fault-baseline",
    },
    inputFiles,
    passed: deviceSignalAssessment.passed && pcmTransportAssessment.passed,
    pcmTransport: {
      assessment: pcmTransportAssessment,
      lane: "userspace-pcm-uplink",
      validitySource: "manifest.transportValidity",
    },
    rawMicrophone: {
      assessment: rawMicrophoneAssessment,
      lane: "device-raw-microphone-trace",
      validitySource: "signal-only-zero-fault-baseline",
    },
    schemaVersion: 1,
    transportValidity: manifest.transportValidity,
  };
}

function buildAssessmentInput(options: {
  clean: Record<Phase, Int16Array>;
  nearSource: Int16Array;
  playbackObserved: (phase: Phase) => boolean;
  sampleRateHz: number;
  sources: Record<Exclude<Phase, "ambient">, Int16Array>;
  validity: AecWaveformTransportValidity;
}): AecWaveformRunInput {
  return {
    ambient: options.clean.ambient,
    doubleTalk: {
      clean: options.clean["double-talk"],
      farSource: options.sources["double-talk"],
      nearOnlyClean: options.clean["near-only"],
      nearSource: options.nearSource,
      playbackObserved: options.playbackObserved("double-talk"),
    },
    farEndOnly: [
      {
        clean: options.clean["far-tone"],
        kind: "tone",
        playbackObserved: options.playbackObserved("far-tone"),
        source: options.sources["far-tone"],
      },
      {
        clean: options.clean["far-dual-carrier-prbs31"],
        kind: "dual-carrier-prbs31",
        playbackObserved: options.playbackObserved("far-dual-carrier-prbs31"),
        source: options.sources["far-dual-carrier-prbs31"],
      },
      {
        clean: options.clean["far-speech-shaped"],
        kind: "speech-shaped",
        playbackObserved: options.playbackObserved("far-speech-shaped"),
        source: options.sources["far-speech-shaped"],
      },
    ],
    nearEndOnly: {
      clean: options.clean["near-only"],
      pathReferenceObserved: options.playbackObserved("near-only"),
      source: options.nearSource,
    },
    nearEndRepeat: {
      clean: options.clean["near-repeat"],
      pathReferenceObserved: options.playbackObserved("near-repeat"),
    },
    sampleRateHz: options.sampleRateHz,
    validity: options.validity,
  };
}

function phasePlaybackObserved(device: Device, phase: Phase, metrics: AecMetricsFile) {
  const samples = device === "stackchan" ? metrics.stackchan : metrics.voicePe;
  const matching = (samples ?? []).filter((sample) => sample.phase === phase);
  if (device === "stackchan") {
    return stackChanMatchedReferenceObserved(
      matching.flatMap((sample) => {
        const value = sample.value;
        const sampledSamples = numberField(value, "sampledSamples");
        const lifetimePlaybackContentSamples = numberField(value, "lifetimePlaybackContentSamples");
        const referenceMeanAbsolute = numberField(value, "referenceMeanAbsolute");
        return sampledSamples !== undefined &&
          sampledSamples > 0 &&
          lifetimePlaybackContentSamples !== undefined &&
          referenceMeanAbsolute !== undefined
          ? [{ lifetimePlaybackContentSamples, referenceMeanAbsolute }]
          : [];
      }),
    );
  }
  return matching.some((sample) => numberField(sample.value, "playbackContentSamples")! >= 8_000);
}

function sliceNearSource(pcm: Uint8Array, sampleRateHz: number, manifest: Manifest) {
  const offsetSamples = manifest.stimuli?.nearSourceWindow?.offsetSamples ?? sampleRateHz;
  const durationSamples = manifest.stimuli?.nearSourceWindow?.durationSamples ?? sampleRateHz * 3;
  if (
    !Number.isSafeInteger(offsetSamples) ||
    offsetSamples < 0 ||
    !Number.isSafeInteger(durationSamples) ||
    durationSamples < sampleRateHz
  ) {
    throw new Error("Retained near-source assessment window is invalid.");
  }
  const start = offsetSamples * 2;
  const end = start + durationSamples * 2;
  if (end > pcm.byteLength) {
    throw new Error(
      `Retained near-source WAVE has ${pcm.byteLength / 2} samples; assessment needs ${end / 2}.`,
    );
  }
  return decodePcm16Le(pcm.subarray(start, end));
}

function decodePcm16Le(bytes: Uint8Array) {
  if (bytes.byteLength % 2 !== 0) {
    throw new Error("Retained PCM16LE evidence has an odd byte count.");
  }
  const samples = new Int16Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true);
  }
  return samples;
}

interface TraceMetadata {
  captureSamples: number;
  capturedSamples: number;
  sampleRateHz: number;
}

function validateTraceMetadata(phase: Phase, value: unknown): TraceMetadata {
  if (!isRecord(value)) throw new Error(`${phase} device trace metadata is not an object.`);
  const captureSamples = numberField(value, "captureSamples");
  const capturedSamples = numberField(value, "capturedSamples");
  const sampleRateHz = numberField(value, "sampleRateHz");
  if (
    captureSamples === undefined ||
    capturedSamples === undefined ||
    sampleRateHz === undefined ||
    !Number.isSafeInteger(captureSamples) ||
    !Number.isSafeInteger(capturedSamples) ||
    !Number.isSafeInteger(sampleRateHz) ||
    captureSamples <= 0 ||
    capturedSamples < 0 ||
    sampleRateHz <= 0
  ) {
    throw new Error(`${phase} device trace metadata has invalid sample accounting.`);
  }
  return { captureSamples, capturedSamples, sampleRateHz };
}

function validateManifest(value: unknown): Manifest {
  if (!isRecord(value)) throw new Error("Retained AEC manifest is not an object.");
  if (value.device !== "stackchan" && value.device !== "home-assistant-voice-preview-edition") {
    throw new Error("Retained AEC manifest has an unsupported device.");
  }
  if (!Number.isSafeInteger(value.schemaVersion)) {
    throw new Error("Retained AEC manifest has no schema version.");
  }
  if (!isTransportValidity(value.transportValidity)) {
    throw new Error("Retained AEC manifest has invalid transport validity.");
  }
  return value as unknown as Manifest;
}

function isTransportValidity(value: unknown): value is AecWaveformTransportValidity {
  if (!isRecord(value)) return false;
  const numeric = [
    "captureFailures",
    "captureFrameDrops",
    "clockDiscontinuities",
    "playbackDroppedFrames",
    "playbackIntegrityFailures",
    "playbackResets",
    "playbackUnderrunIncidents",
    "uplinkFrameDrops",
    "uplinkRestarts",
    "websocketReconnects",
  ];
  return (
    numeric.every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0) &&
    typeof value.networkValid === "boolean" &&
    typeof value.recorderComplete === "boolean"
  );
}

function signalOnlyValidity(): AecWaveformTransportValidity {
  return {
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
  };
}

function numberField(value: Record<string, unknown> | undefined, key: string) {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
