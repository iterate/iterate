import { z } from "zod";
import type { KitAvatarMetrics } from "./kit-device-contract.ts";

const nonnegativeSafeInteger = z.number().int().nonnegative().safe();
const KitAvatarMetricsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  producedAtMs: nonnegativeSafeInteger,
  ready: z.boolean(),
  playoutObservations: nonnegativeSafeInteger,
  malformedObservations: nonnegativeSafeInteger,
  mailboxOverwrites: nonnegativeSafeInteger,
  mailboxFailures: nonnegativeSafeInteger,
  analyzerFrames: nonnegativeSafeInteger,
  analyzerSequenceGaps: nonnegativeSafeInteger,
  mouthOpenRenderedFrames: nonnegativeSafeInteger,
  snapshotRaces: nonnegativeSafeInteger,
  renderedFrames: nonnegativeSafeInteger,
  renderFailures: nonnegativeSafeInteger,
  displayTransfers: nonnegativeSafeInteger,
  displayTransferFailures: nonnegativeSafeInteger,
  displayTransferTimeouts: nonnegativeSafeInteger,
  maximumHandoffDelayUs: nonnegativeSafeInteger,
  maximumAnalyzerUs: nonnegativeSafeInteger,
  maximumRenderUs: nonnegativeSafeInteger,
  maximumDisplayTransferUs: nonnegativeSafeInteger,
  analyzerStackMinimumFreeBytes: nonnegativeSafeInteger,
  physicalPlayoutSampleClock: nonnegativeSafeInteger,
  currentAvatarIndex: nonnegativeSafeInteger,
  framebufferBytes: nonnegativeSafeInteger,
});

export function parseKitAvatarMetrics(value: unknown): KitAvatarMetrics {
  return KitAvatarMetricsSchema.parse(value);
}

export interface StackChanAvatarAssessment {
  passed: boolean;
  reasons: string[];
  samples: {
    received: number;
    firstProducedAtMs: number | null;
    lastProducedAtMs: number | null;
  };
  progress: {
    playoutObservations: number;
    analyzerFrames: number;
    mouthOpenRenderedFrames: number;
    renderedFrames: number;
    displayTransfers: number;
    physicalPlayoutSamples: number;
  };
  loadShedding: {
    mailboxOverwrites: number;
    analyzerSequenceGaps: number;
  };
  failures: {
    malformedObservations: number;
    mailboxFailures: number;
    snapshotRaces: number;
    renderFailures: number;
    displayTransferFailures: number;
    displayTransferTimeouts: number;
  };
  resources: {
    framebufferBytes: number | null;
    analyzerStackMinimumFreeBytes: number | null;
  };
  timing: {
    maximumHandoffDelayUs: number;
    maximumAnalyzerUs: number;
    maximumRenderUs: number;
    maximumDisplayTransferUs: number;
  };
}

const expectedFramebufferBytes = 160 * 120 * Uint16Array.BYTES_PER_ELEMENT;
const minimumAnalyzerStackFreeBytes = 1_024;
const maximumHandoffDelayUs = 100_000;
const maximumVisualWorkUs = 66_000;
const maximumDisplayTransferUs = 50_000;

/**
 * Converts latest-state counters into proof that the face followed physical
 * speaker playout rather than an earlier boot's pixels retained in LCD GRAM.
 *
 * The visual sidecar is intentionally lossy: mailbox overwrites and sequence
 * gaps are allowed because drawing stale expressions would be worse than
 * skipping them. Every actual failure remains a hard gate. The speaker clock,
 * analyzer, completed LCD transfers, and completed mouth-open transfers must
 * all advance over the same acceptance interval, so neither a static face nor
 * an analyzer disconnected from the panel can pass.
 */
export function assessStackChanAvatarRun(
  samples: readonly KitAvatarMetrics[],
): StackChanAvatarAssessment {
  const first = samples[0];
  const last = samples.at(-1);
  const reasons: string[] = [];
  const regressedCounters = new Set<keyof KitAvatarMetrics>();

  if (samples.length < 2) {
    reasons.push("Fewer than two avatar metric boundaries were retained.");
  }

  const counterDelta = (field: keyof KitAvatarMetrics) => {
    if (!first || !last) return 0;
    const beginning = first[field];
    const ending = last[field];
    if (typeof beginning !== "number" || typeof ending !== "number") return 0;
    if (ending < beginning) {
      regressedCounters.add(field);
      return 0;
    }
    return ending - beginning;
  };

  const progress = {
    playoutObservations: counterDelta("playoutObservations"),
    analyzerFrames: counterDelta("analyzerFrames"),
    mouthOpenRenderedFrames: counterDelta("mouthOpenRenderedFrames"),
    renderedFrames: counterDelta("renderedFrames"),
    displayTransfers: counterDelta("displayTransfers"),
    physicalPlayoutSamples: counterDelta("physicalPlayoutSampleClock"),
  };
  const loadShedding = {
    mailboxOverwrites: counterDelta("mailboxOverwrites"),
    analyzerSequenceGaps: counterDelta("analyzerSequenceGaps"),
  };
  const failures = {
    malformedObservations: last?.malformedObservations ?? 0,
    mailboxFailures: last?.mailboxFailures ?? 0,
    snapshotRaces: last?.snapshotRaces ?? 0,
    renderFailures: last?.renderFailures ?? 0,
    displayTransferFailures: last?.displayTransferFailures ?? 0,
    displayTransferTimeouts: last?.displayTransferTimeouts ?? 0,
  };
  const stackHeadrooms = samples.map((sample) => sample.analyzerStackMinimumFreeBytes);
  const resources = {
    framebufferBytes: last?.framebufferBytes ?? null,
    analyzerStackMinimumFreeBytes: stackHeadrooms.length > 0 ? Math.min(...stackHeadrooms) : null,
  };
  const timing = {
    maximumHandoffDelayUs: Math.max(0, ...samples.map((sample) => sample.maximumHandoffDelayUs)),
    maximumAnalyzerUs: Math.max(0, ...samples.map((sample) => sample.maximumAnalyzerUs)),
    maximumRenderUs: Math.max(0, ...samples.map((sample) => sample.maximumRenderUs)),
    maximumDisplayTransferUs: Math.max(
      0,
      ...samples.map((sample) => sample.maximumDisplayTransferUs),
    ),
  };

  if (samples.some((sample) => !sample.ready)) {
    reasons.push("The avatar owner was not ready at every retained boundary.");
  }
  if (samples.some((sample) => sample.framebufferBytes !== expectedFramebufferBytes)) {
    reasons.push(
      `The avatar framebuffer was not the expected ${expectedFramebufferBytes}-byte RGB565 surface.`,
    );
  }
  if (progress.playoutObservations === 0) {
    reasons.push("The avatar observed no speaker-completed PCM frames.");
  }
  if (progress.analyzerFrames === 0) {
    reasons.push("The avatar analyzer processed no new speaker PCM frames.");
  }
  if (progress.mouthOpenRenderedFrames === 0) {
    reasons.push("No completed mouth-open LCD frame was observed during audible playback.");
  }
  if (progress.renderedFrames === 0 || progress.displayTransfers === 0) {
    reasons.push("The avatar completed no new render-to-LCD transfer.");
  }
  if (progress.physicalPlayoutSamples === 0) {
    reasons.push("The physical speaker playout clock did not advance during the avatar proof.");
  }
  if (failures.malformedObservations > 0) {
    const frame = failures.malformedObservations === 1 ? "frame" : "frames";
    reasons.push(`Avatar playout observer rejected ${failures.malformedObservations} ${frame}.`);
  }
  if (failures.mailboxFailures > 0) {
    reasons.push(`Avatar mailbox failed ${failures.mailboxFailures} time(s).`);
  }
  if (failures.snapshotRaces > 0) {
    reasons.push(`Avatar state snapshots raced ${failures.snapshotRaces} time(s).`);
  }
  if (failures.renderFailures > 0) {
    reasons.push(`Avatar rendering failed ${failures.renderFailures} time(s).`);
  }
  if (failures.displayTransferFailures > 0) {
    reasons.push(`LCD transfers failed ${failures.displayTransferFailures} time(s).`);
  }
  if (failures.displayTransferTimeouts > 0) {
    const time = failures.displayTransferTimeouts === 1 ? "time" : "times";
    reasons.push(`LCD transfers timed out ${failures.displayTransferTimeouts} ${time}.`);
  }
  if (
    resources.analyzerStackMinimumFreeBytes === null ||
    resources.analyzerStackMinimumFreeBytes < minimumAnalyzerStackFreeBytes
  ) {
    reasons.push(
      `Avatar analyzer stack headroom was ${resources.analyzerStackMinimumFreeBytes ?? "unmeasured"} ` +
        `bytes; expected at least ${minimumAnalyzerStackFreeBytes}.`,
    );
  }
  if (timing.maximumHandoffDelayUs > maximumHandoffDelayUs) {
    reasons.push(
      `Avatar handoff delay reached ${timing.maximumHandoffDelayUs} us; ` +
        `expected at most ${maximumHandoffDelayUs} us.`,
    );
  }
  if (timing.maximumAnalyzerUs > maximumVisualWorkUs) {
    reasons.push(
      `Avatar analysis reached ${timing.maximumAnalyzerUs} us; ` +
        `expected below the ${maximumVisualWorkUs}-us render cadence.`,
    );
  }
  if (timing.maximumRenderUs > maximumVisualWorkUs) {
    reasons.push(
      `Avatar rendering reached ${timing.maximumRenderUs} us; ` +
        `expected below the ${maximumVisualWorkUs}-us render cadence.`,
    );
  }
  if (timing.maximumDisplayTransferUs > maximumDisplayTransferUs) {
    reasons.push(
      `LCD transfer time reached ${timing.maximumDisplayTransferUs} us; ` +
        `expected at most ${maximumDisplayTransferUs} us.`,
    );
  }
  for (const field of regressedCounters) {
    reasons.push(`Avatar counter ${field} regressed during one firmware generation.`);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    samples: {
      received: samples.length,
      firstProducedAtMs: first?.producedAtMs ?? null,
      lastProducedAtMs: last?.producedAtMs ?? null,
    },
    progress,
    loadShedding,
    failures,
    resources,
    timing,
  };
}
