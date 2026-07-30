import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaybackEnduranceJsonlEvidenceWriter } from "./playback-endurance-evidence-writer.ts";
import {
  createM5StickS3PlaybackEnduranceTarget,
  requireM5StickS3PlaybackEnduranceRuntime,
  runM5StickS3PlaybackEnduranceAcceptance,
  type M5StickS3PlaybackEnduranceArtifactAnalyzer,
  type M5StickS3PlaybackEnduranceRuntime,
} from "./m5sticks3-playback-endurance-target.ts";

/**
 * Complete host-side M5StickS3 acceptance command.
 *
 * The runtime guard intentionally runs before creating the evidence directory.
 * Until the public capability exposes every required operation, the real CLI
 * should report that exact API gap and must not leave empty JSONL files that
 * look like an interrupted (or worse, successful) physical run.
 */
export async function runM5StickS3PlaybackEnduranceMode(options: {
  analyzeAcousticArtifact?: M5StickS3PlaybackEnduranceArtifactAnalyzer;
  createRunId?: () => string;
  monotonicNow?: () => number;
  outputRoot?: string;
  runtime: Partial<M5StickS3PlaybackEnduranceRuntime>;
}) {
  const runtime = requireM5StickS3PlaybackEnduranceRuntime(options.runtime);
  const outputRoot = options.outputRoot ?? tmpdir();
  await mkdir(outputRoot, { recursive: true });
  const outputDirectory = await mkdtemp(join(outputRoot, "iterate-kit-m5sticks3-endurance-"));
  const writer = PlaybackEnduranceJsonlEvidenceWriter.open(outputDirectory);
  try {
    const target = createM5StickS3PlaybackEnduranceTarget({
      analyzeAcousticArtifact: options.analyzeAcousticArtifact,
      createRunId: options.createRunId ?? randomUUID,
      /*
       * The persisted schema currently defines integer milliseconds. Browser
       * performance.now() is fractional, so normalize at the one host clock
       * boundary rather than letting a physical-only validation failure lurk
       * behind integer-valued test doubles.
       */
      monotonicNow: options.monotonicNow ?? (() => Math.floor(performance.now())),
      rawMetricSink: writer,
      runtime,
    });
    const result = await runM5StickS3PlaybackEnduranceAcceptance({
      onRunManifest: (manifest) => writer.appendManifest(manifest),
      target,
    });
    return {
      manifestsPath: writer.manifestsPath,
      outputDirectory,
      rawMetricsPath: writer.rawMetricsPath,
      result,
    };
  } finally {
    writer[Symbol.dispose]();
  }
}
