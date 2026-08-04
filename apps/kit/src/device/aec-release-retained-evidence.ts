import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { assessAecReleaseSignalWindow } from "./aec-release-signal-oracle.ts";
import {
  assessAecReleaseMatrixCompletion,
  aecReleaseMatrix,
  type AecReleaseArtifactPlane,
  type AecReleasePhaseEvidence,
} from "./aec-release-matrix.ts";
import { aecReleaseTraceOffsets, aecReleaseTraceWindowName } from "./aec-release-trace-plan.ts";
import { decodeMonoPcm16Wave } from "./pcm16-wave-file.ts";

const manifestSchema = z.looseObject({
  device: z.enum(["home-assistant-voice-preview-edition", "stackchan"]),
  exactMac: z.string().min(1),
  networkVerdict: z.enum(["indeterminate", "network-invalid", "valid"]),
  qualification: z.literal("acquisition-complete-unscored"),
  schemaVersion: z.literal(2),
});
const traceMetadataSchema = z.looseObject({
  captureSamples: z.number().int().positive(),
  capturedSamples: z.number().int().nonnegative(),
  firstFrameSequence: z.number().int().nonnegative(),
  frameSamples: z.number().int().positive(),
  lastFrameSequence: z.number().int().nonnegative(),
  sampleRateHz: z.number().int().positive(),
});
const traceArtifactSchema = z.looseObject({
  captureCompletedAtMonotonicMs: z.number().finite().nonnegative(),
  captureStartedAtMonotonicMs: z.number().finite().nonnegative(),
  metadata: traceMetadataSchema,
  planes: z.record(z.string(), z.looseObject({ bytes: z.number().int().nonnegative() })),
  scheduledOffsetMs: z.number().int().nonnegative(),
});
const tracesSchema = z.record(z.string(), z.record(z.string(), traceArtifactSchema));
const fileArtifactSchema = z.looseObject({
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const phaseArtifactsSchema = z.record(
  z.string(),
  z.looseObject({ downlink: fileArtifactSchema, uplink: fileArtifactSchema }),
);
const timedMetricSchema = z.looseObject({
  phase: z.string().nullable(),
  receivedAtMonotonicMs: z.number().finite().nonnegative(),
  value: z.record(z.string(), z.union([z.number(), z.string()])),
});
const timedMetricsSchema = z.array(timedMetricSchema);
const aecMetricsSchema = z.looseObject({
  stackchan: timedMetricsSchema,
  voicePe: timedMetricsSchema,
});
const socketClosesSchema = z.array(z.looseObject({ expectedByHarness: z.boolean() }));
const networkSchema = z.looseObject({
  network: z.looseObject({
    reasons: z.array(z.looseObject({ code: z.string(), message: z.string() })),
    verdict: z.enum(["indeterminate", "network-invalid", "valid"]),
  }),
});
const traceWindowNames = ["onset", "settled", "tail"] as const;
type TraceWindowName = (typeof traceWindowNames)[number];

export interface RetainedAecReleaseEvidenceScore {
  completion: ReturnType<typeof assessAecReleaseMatrixCompletion>;
  device: z.infer<typeof manifestSchema>["device"];
  exactMac: string;
  inputFiles: Record<string, { bytes: number; sha256: string }>;
  phases: Array<{
    artifactPlanes: AecReleaseArtifactPlane[];
    frameConservationPassed: boolean;
    id: string;
    reasons: string[];
    windows: Array<{
      assessment: ReturnType<typeof assessAecReleaseSignalWindow>;
      name: TraceWindowName;
    }>;
  }>;
  schemaVersion: 1;
}

/**
 * Replays the release verdict from immutable files without a device/provider.
 *
 * All file paths are reconstructed from canonical phase IDs and window names;
 * absolute paths retained for operator convenience are never trusted as read
 * targets. Network validity remains a separate input to completion, while the
 * DSP window oracle reads only simultaneous device-owned raw/clean traces.
 */
export async function scoreRetainedAecReleaseEvidence(
  runDirectory: string,
): Promise<RetainedAecReleaseEvidenceScore> {
  const inputFiles: RetainedAecReleaseEvidenceScore["inputFiles"] = {};
  const readTracked = async (relativePath: string) => {
    const bytes = await readFile(join(runDirectory, relativePath));
    inputFiles[relativePath] = {
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    return bytes;
  };
  const readJson = async <Value>(relativePath: string, schema: z.ZodType<Value>) => {
    const value: unknown = JSON.parse((await readTracked(relativePath)).toString("utf8"));
    return schema.parse(value);
  };

  const manifest = await readJson("manifest.json", manifestSchema);
  const [traces, phaseArtifacts, generalMetrics, aecMetrics, socketCloses, network] =
    await Promise.all([
      readJson("release-traces.json", tracesSchema),
      readJson("release-phase-artifacts.json", phaseArtifactsSchema),
      readJson("general-metrics.json", timedMetricsSchema),
      readJson("aec-metrics.json", aecMetricsSchema),
      readJson("pcm-socket-closes.json", socketClosesSchema),
      readJson("physical-network-validity.json", networkSchema),
    ]);
  if (manifest.networkVerdict !== network.network.verdict) {
    throw new Error("AEC release manifest and retained network verdict disagree.");
  }
  const expectedIds = new Set(aecReleaseMatrix.phases.map((phase) => phase.id));
  for (const phase of aecReleaseMatrix.phases) {
    if (!traces[phase.id] || !phaseArtifacts[phase.id]) {
      throw new Error(`AEC release evidence is missing canonical phase ${phase.id}.`);
    }
  }
  for (const phaseId of [...Object.keys(traces), ...Object.keys(phaseArtifacts)]) {
    if (!expectedIds.has(phaseId)) {
      throw new Error(`AEC release evidence contains unmodelled phase ${phaseId}.`);
    }
  }

  const nearWave = decodeMonoPcm16Wave(await readTracked("mac-near-source.wav"));
  const ambientTrace = traces["ambient-silence"]!;
  const ambientWindows = orderedWindows(ambientTrace);
  if (ambientWindows.length === 0) throw new Error("AEC ambient phase retained no trace windows.");
  const ambientClean = await readPcm(
    readTracked,
    `aec-traces/ambient-silence/${ambientWindows[0]}/clean.pcm16le`,
  );
  const ambientRms = signalRms(ambientClean);
  const phaseResults: RetainedAecReleaseEvidenceScore["phases"] = [];
  const completionEvidence: AecReleasePhaseEvidence[] = [];
  const unexpectedSocketClose = socketCloses.some((close) => !close.expectedByHarness);

  for (const phase of aecReleaseMatrix.phases) {
    const traceWindows = traces[phase.id]!;
    const windowNames = orderedWindows(traceWindows);
    if (windowNames.length === 0) {
      throw new Error(`AEC release phase ${phase.id} retained no trace windows.`);
    }
    const artifactPlanes = retainedArtifactPlanes(manifest.device, traceWindows, windowNames);
    const reasons: string[] = [];
    const windows = [];
    let frameConservationPassed = true;
    const phaseGeneralMetrics = generalMetrics.filter((sample) => sample.phase === phase.id);
    const phaseAecMetrics = (
      manifest.device === "stackchan" ? aecMetrics.stackchan : aecMetrics.voicePe
    ).filter((sample) => sample.phase === phase.id);
    const firstTrace = traceWindows[windowNames[0]]!;
    const traceDurationMs =
      (firstTrace.metadata.captureSamples * 1_000) / firstTrace.metadata.sampleRateHz;
    const expectedOffsets = aecReleaseTraceOffsets(phase.durationMs, traceDurationMs, phase.id);
    const expectedWindows = expectedOffsets.map((_, index) =>
      aecReleaseTraceWindowName(index, expectedOffsets.length),
    );
    if (
      expectedWindows.length !== windowNames.length ||
      expectedWindows.some((name, index) => name !== windowNames[index])
    ) {
      throw new Error(`AEC release phase ${phase.id} did not retain its canonical trace schedule.`);
    }
    for (const windowName of windowNames) {
      const retained = traceWindows[windowName]!;
      const metadata = retained.metadata;
      const scheduleIndex = expectedWindows.indexOf(windowName);
      if (
        retained.scheduledOffsetMs !== expectedOffsets[scheduleIndex] ||
        retained.captureCompletedAtMonotonicMs <= retained.captureStartedAtMonotonicMs
      ) {
        throw new Error(`AEC release phase ${phase.id} ${windowName} timing evidence is invalid.`);
      }
      const expectedFrames = metadata.captureSamples / metadata.frameSamples;
      const observedFrames = metadata.lastFrameSequence - metadata.firstFrameSequence + 1;
      const frameConserved =
        metadata.capturedSamples === metadata.captureSamples &&
        Number.isSafeInteger(expectedFrames) &&
        observedFrames === expectedFrames;
      if (!frameConserved) {
        frameConservationPassed = false;
        reasons.push(`${windowName} trace did not conserve contiguous audio frames.`);
      }
      const [raw, clean] = await Promise.all([
        readPcm(readTracked, `aec-traces/${phase.id}/${windowName}/raw-microphone.pcm16le`),
        readPcm(readTracked, `aec-traces/${phase.id}/${windowName}/clean.pcm16le`),
      ]);
      const scenario =
        phase.scenario === "ambient"
          ? "ambient"
          : phase.scenario === "near-end-only"
            ? "near"
            : phase.scenario === "double-talk"
              ? "double-talk"
              : "far";
      let nearControl: Int16Array | undefined;
      if (phase.scenario === "near-end-only") {
        nearControl = nearSourceWindow(nearWave.pcm, phase.durationMs, windowName, clean.length);
      } else if (phase.scenario === "double-talk") {
        nearControl = await readPcm(
          readTracked,
          `aec-traces/${phase.nearLevel}-near-deterministic-speech/${windowName}/clean.pcm16le`,
        );
      }
      const assessment = assessAecReleaseSignalWindow({
        ambientRms,
        clean,
        ...(nearControl ? { nearControl } : {}),
        raw,
        sampleRateHz: metadata.sampleRateHz,
        scenario,
      });
      reasons.push(...assessment.reasons.map((reason) => `${windowName}: ${reason}`));
      if (!releaseTraceHasMetricCoverage(retained, phaseGeneralMetrics)) {
        reasons.push(`${windowName}: no simultaneous general metrics sample was retained.`);
      }
      if (!releaseTraceHasMetricCoverage(retained, phaseAecMetrics)) {
        reasons.push(`${windowName}: no simultaneous AEC metrics sample was retained.`);
      }
      windows.push({ assessment, name: windowName });
    }
    if (phaseGeneralMetrics.length === 0)
      reasons.push("No per-phase general metrics were retained.");
    if (phaseAecMetrics.length === 0) reasons.push("No per-phase AEC metrics were retained.");
    const lifetimeMetricsRetained =
      releaseHasLifetimeMetricPair(phaseGeneralMetrics) &&
      releaseHasLifetimeMetricPair(phaseAecMetrics);
    if (!lifetimeMetricsRetained) {
      reasons.push("Phase did not retain a monotonic pair of lifetime counter samples.");
    }
    const perWindowMetricsRetained = windowNames.every((windowName) => {
      const retained = traceWindows[windowName]!;
      return (
        releaseTraceHasMetricCoverage(retained, phaseGeneralMetrics) &&
        releaseTraceHasMetricCoverage(retained, phaseAecMetrics)
      );
    });
    if (unexpectedSocketClose) reasons.push("The run retained an unexpected PCM socket close.");

    const artifacts = phaseArtifacts[phase.id]!;
    const downlink = await readTracked(`release-phases/${phase.id}/fixture-downlink.pcm16le`);
    const uplink = await readTracked(`release-phases/${phase.id}/pcm-uplink.pcm16le`);
    assertArtifactHash(phase.id, "downlink", downlink, artifacts.downlink);
    assertArtifactHash(phase.id, "uplink", uplink, artifacts.uplink);
    if (uplink.byteLength === 0 || uplink.byteLength % 640 !== 0) {
      frameConservationPassed = false;
      reasons.push("The retained phase uplink did not contain whole non-empty 20 ms frames.");
    }
    if (
      phase.scenario !== "ambient" &&
      (downlink.byteLength === 0 || downlink.byteLength % 640 !== 0)
    ) {
      frameConservationPassed = false;
      reasons.push("The retained far phase downlink did not contain whole non-empty 20 ms frames.");
    }

    const dspPassed = windows.every((window) => window.assessment.passed) && reasons.length === 0;
    completionEvidence.push({
      artifactPlanes,
      dspPassed,
      frameConservationPassed,
      lifetimeMetricsRetained,
      perWindowMetricsRetained,
      phaseId: phase.id,
    });
    phaseResults.push({ artifactPlanes, frameConservationPassed, id: phase.id, reasons, windows });
  }

  const completion = assessAecReleaseMatrixCompletion({
    device: manifest.device,
    evidence: completionEvidence,
    network: {
      passed: network.network.verdict === "valid",
      reasons: network.network.reasons.map((reason) => `${reason.code}: ${reason.message}`),
    },
  });
  return {
    completion,
    device: manifest.device,
    exactMac: manifest.exactMac,
    inputFiles,
    phases: phaseResults,
    schemaVersion: 1,
  };
}

function orderedWindows(trace: Record<string, z.infer<typeof traceArtifactSchema>>) {
  const keys = Object.keys(trace);
  for (const key of keys) {
    if (!traceWindowNames.includes(key as TraceWindowName)) {
      throw new Error(`AEC release trace has unsupported window ${key}.`);
    }
  }
  return traceWindowNames.filter((name) => trace[name] !== undefined);
}

export function releaseTraceHasMetricCoverage(
  trace: z.infer<typeof traceArtifactSchema>,
  samples: readonly z.infer<typeof timedMetricSchema>[],
) {
  return samples.some(
    (sample) =>
      sample.receivedAtMonotonicMs >= trace.captureStartedAtMonotonicMs &&
      sample.receivedAtMonotonicMs <= trace.captureCompletedAtMonotonicMs,
  );
}

export function releaseHasLifetimeMetricPair(
  samples: readonly z.infer<typeof timedMetricSchema>[],
) {
  if (samples.length < 2) return false;
  const first = samples[0]!.value;
  const last = samples.at(-1)!.value;
  const counterNames = Object.keys(first).filter(
    (name) =>
      name.startsWith("lifetime") ||
      /^(audio_(sent|dropped|failures)|uplink_(sent|dropped|failures|restart_incidents)|downlink_(accepted|dropped|failures)|protocol_failures)$/u.test(
        name,
      ),
  );
  return (
    counterNames.length > 0 &&
    counterNames.every((name) => {
      const before = first[name];
      const after = last[name];
      return (
        typeof before === "number" &&
        typeof after === "number" &&
        Number.isSafeInteger(before) &&
        Number.isSafeInteger(after) &&
        before >= 0 &&
        after >= before
      );
    })
  );
}

function retainedArtifactPlanes(
  device: z.infer<typeof manifestSchema>["device"],
  traces: Record<string, z.infer<typeof traceArtifactSchema>>,
  windows: readonly TraceWindowName[],
): AecReleaseArtifactPlane[] {
  const everyWindowHas = (plane: string) =>
    windows.every((window) => traces[window]!.planes[plane]);
  const planes: AecReleaseArtifactPlane[] = [];
  if (everyWindowHas("near")) planes.push("raw");
  if (everyWindowHas("clean")) planes.push("clean");
  if (everyWindowHas("playout")) planes.push("playout");
  if (device === "stackchan" && everyWindowHas("reference")) planes.push("electrical-reference");
  if (everyWindowHas("linear")) planes.push("linear");
  return planes;
}

async function readPcm(
  readTracked: (relativePath: string) => Promise<Uint8Array>,
  relativePath: string,
) {
  const bytes = await readTracked(relativePath);
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
    throw new Error(`AEC PCM artifact ${relativePath} is empty or has an odd byte count.`);
  }
  const samples = new Int16Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true);
  }
  return samples;
}

function nearSourceWindow(
  pcm: Uint8Array,
  phaseDurationMs: number,
  window: TraceWindowName,
  sampleCount: number,
) {
  const traceDurationMs = (sampleCount * 1_000) / 16_000;
  const offsetMs =
    window === "onset"
      ? 0
      : window === "tail"
        ? phaseDurationMs - traceDurationMs
        : Math.floor((phaseDurationMs - traceDurationMs) / 2);
  const byteOffset = (offsetMs * 16_000 * 2) / 1_000;
  const byteLength = sampleCount * 2;
  if (!Number.isSafeInteger(byteOffset) || byteOffset + byteLength > pcm.byteLength) {
    throw new Error("AEC near-source trace window exceeds the retained deterministic WAVE.");
  }
  const bytes = pcm.subarray(byteOffset, byteOffset + byteLength);
  const result = new Int16Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < result.length; index += 1)
    result[index] = view.getInt16(index * 2, true);
  return result;
}

function signalRms(samples: Int16Array) {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function assertArtifactHash(
  phaseId: string,
  lane: string,
  bytes: Uint8Array,
  artifact: z.infer<typeof fileArtifactSchema>,
) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== artifact.bytes || hash !== artifact.sha256) {
    throw new Error(`AEC release phase ${phaseId} ${lane} artifact does not match its manifest.`);
  }
}
