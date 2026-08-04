export type AecReleaseDevice = "home-assistant-voice-preview-edition" | "stackchan";
export type AecReleaseDriveLevel = "maximum-non-clipping" | "nominal" | "quiet";
export type AecReleaseNearLevel = "loud" | "nominal" | "quiet";
export type AecReleaseFarStimulus =
  | "chirp"
  | "impulse-train"
  | "multi-tone"
  | "speech-long"
  | "speech-shaped"
  | "tone";
export type AecReleaseLifecycleAction =
  | "aec-restart-reconvergence"
  | "conversation-stop-start"
  | "long-duration-changing-playback"
  | "playback-underrun-recovery"
  | "provider-generation-change";
export type AecReleaseArtifactPlane =
  | "clean"
  | "electrical-reference"
  | "linear"
  | "playout"
  | "raw";

interface AmbientPhase {
  durationMs: number;
  id: string;
  scenario: "ambient";
}

interface FarEndPhase {
  driveLevel: AecReleaseDriveLevel;
  durationMs: number;
  id: string;
  scenario: "far-end-only";
  stimulus: AecReleaseFarStimulus;
}

interface NearEndPhase {
  durationMs: number;
  id: string;
  nearLevel: AecReleaseNearLevel;
  scenario: "near-end-only";
  stimulus: "deterministic-speech";
}

interface DoubleTalkPhase {
  driveLevel: AecReleaseDriveLevel;
  durationMs: number;
  id: string;
  nearLevel: AecReleaseNearLevel;
  scenario: "double-talk";
  stimulus: "independent-deterministic-speech";
}

interface LifecyclePhase {
  driveLevel: "nominal";
  durationMs: number;
  id: string;
  lifecycleAction: AecReleaseLifecycleAction;
  scenario: "lifecycle";
}

export type AecReleaseMatrixPhase =
  | AmbientPhase
  | DoubleTalkPhase
  | FarEndPhase
  | LifecyclePhase
  | NearEndPhase;

const devices: readonly AecReleaseDevice[] = Object.freeze([
  "home-assistant-voice-preview-edition",
  "stackchan",
]);
const driveLevels: readonly AecReleaseDriveLevel[] = Object.freeze([
  "quiet",
  "nominal",
  "maximum-non-clipping",
]);
const farStimuli: readonly AecReleaseFarStimulus[] = Object.freeze([
  "tone",
  "multi-tone",
  "chirp",
  "impulse-train",
  "speech-shaped",
  "speech-long",
]);

const phases: readonly AecReleaseMatrixPhase[] = Object.freeze([
  {
    durationMs: 10_000,
    id: "ambient-silence",
    scenario: "ambient",
  },
  ...driveLevels.flatMap((driveLevel) =>
    farStimuli.map(
      (stimulus): FarEndPhase => ({
        driveLevel,
        /*
         * Long speech is the nonstationary stability source; the shorter
         * deterministic signals leave enough settled material to measure both
         * convergence and the stationary residual independently per level.
         */
        durationMs: stimulus === "speech-long" ? 120_000 : 8_000,
        id: `${driveLevel}-far-${stimulus}`,
        scenario: "far-end-only",
        stimulus,
      }),
    ),
  ),
  /*
   * These two equal-source runs surround the changing-spectrum work above.
   * Their comparison exposes slow filter drift and false “improvement” caused
   * by an easier second fixture rather than a stable echo path.
   */
  {
    driveLevel: "nominal",
    durationMs: 20_000,
    id: "nominal-far-speech-repeat-a",
    scenario: "far-end-only",
    stimulus: "speech-long",
  },
  {
    driveLevel: "nominal",
    durationMs: 20_000,
    id: "nominal-far-speech-repeat-b",
    scenario: "far-end-only",
    stimulus: "speech-long",
  },
  ...(["quiet", "nominal", "loud"] as const).map(
    (nearLevel): NearEndPhase => ({
      durationMs: 20_000,
      id: `${nearLevel}-near-deterministic-speech`,
      nearLevel,
      scenario: "near-end-only",
      stimulus: "deterministic-speech",
    }),
  ),
  /*
   * The three corners are more discriminating than repeating only equal-level
   * double-talk: far-loud/near-quiet challenges preservation, equal nominal
   * measures ordinary dialogue, and far-quiet/near-loud catches false
   * suppression and gain pumping when nearby speech clearly dominates.
   */
  {
    driveLevel: "maximum-non-clipping",
    durationMs: 20_000,
    id: "double-talk-far-loud-near-quiet",
    nearLevel: "quiet",
    scenario: "double-talk",
    stimulus: "independent-deterministic-speech",
  },
  {
    driveLevel: "nominal",
    durationMs: 20_000,
    id: "double-talk-far-nominal-near-nominal",
    nearLevel: "nominal",
    scenario: "double-talk",
    stimulus: "independent-deterministic-speech",
  },
  {
    driveLevel: "quiet",
    durationMs: 20_000,
    id: "double-talk-far-quiet-near-loud",
    nearLevel: "loud",
    scenario: "double-talk",
    stimulus: "independent-deterministic-speech",
  },
  ...(
    [
      ["conversation-stop-start", 30_000],
      ["provider-generation-change", 30_000],
      ["playback-underrun-recovery", 30_000],
      ["aec-restart-reconvergence", 30_000],
      ["long-duration-changing-playback", 600_000],
    ] as const
  ).map(
    ([lifecycleAction, durationMs]): LifecyclePhase => ({
      driveLevel: "nominal",
      durationMs,
      id: `lifecycle-${lifecycleAction}`,
      lifecycleAction,
      scenario: "lifecycle",
    }),
  ),
]);

/**
 * The release protocol is shared data rather than branches in two scripts.
 *
 * A hardware profile maps the relative drive/near levels to calibrated values
 * and records the non-clipping boundary. It must not mutate this matrix. That
 * is how “same test on both devices” remains auditable even though their codec,
 * enclosure, microphone, and room transfer functions differ.
 */
export const aecReleaseMatrix = Object.freeze({ devices, driveLevels, phases });

export function aecReleaseMatrixPhaseIds(): readonly string[] {
  return phases.map((phase) => phase.id);
}

export interface AecReleasePhaseEvidence {
  artifactPlanes: readonly AecReleaseArtifactPlane[];
  dspPassed: boolean;
  frameConservationPassed: boolean;
  lifetimeMetricsRetained: boolean;
  perWindowMetricsRetained: boolean;
  phaseId: string;
}

export interface AecReleaseVerdict {
  accepted: boolean;
  dsp: { passed: boolean; reasons: string[] };
  network: { passed: boolean; reasons: string[] };
}

/**
 * Composes completeness, DSP, provider, transport, and network evidence without
 * collapsing their attribution. Network failure blocks acceptance but is never
 * inserted into `dsp.reasons`; a later clean rerun can therefore be compared
 * with the same measured DSP result rather than relabeling it.
 */
export function assessAecReleaseMatrixCompletion(options: {
  device: AecReleaseDevice;
  evidence: readonly AecReleasePhaseEvidence[];
  network: { passed: boolean; reasons: readonly string[] };
}): AecReleaseVerdict {
  const reasons: string[] = [];
  const expectedIds = aecReleaseMatrixPhaseIds();
  const expectedIdSet = new Set(expectedIds);
  const evidenceById = new Map<string, AecReleasePhaseEvidence>();
  for (const item of options.evidence) {
    if (!expectedIdSet.has(item.phaseId)) {
      reasons.push(`Unmodelled AEC phase ${item.phaseId}.`);
      continue;
    }
    if (evidenceById.has(item.phaseId)) {
      reasons.push(`Duplicate AEC phase ${item.phaseId}.`);
      continue;
    }
    evidenceById.set(item.phaseId, item);
  }

  for (const phaseId of expectedIds) {
    const evidence = evidenceById.get(phaseId);
    if (!evidence) {
      reasons.push(`Missing AEC phase ${phaseId}.`);
      continue;
    }
    const requiredPlanes: readonly AecReleaseArtifactPlane[] =
      options.device === "stackchan" ? ["raw", "electrical-reference", "clean"] : ["raw", "clean"];
    for (const plane of requiredPlanes) {
      if (!evidence.artifactPlanes.includes(plane)) {
        reasons.push(`AEC phase ${phaseId} did not retain its ${plane} PCM plane.`);
      }
    }
    if (!evidence.perWindowMetricsRetained) {
      reasons.push(`AEC phase ${phaseId} did not retain per-window metrics.`);
    }
    if (!evidence.lifetimeMetricsRetained) {
      reasons.push(`AEC phase ${phaseId} did not retain lifetime metrics.`);
    }
    if (!evidence.frameConservationPassed) {
      reasons.push(`AEC phase ${phaseId} failed frame conservation.`);
    }
    if (!evidence.dspPassed) reasons.push(`AEC phase ${phaseId} failed its DSP oracle.`);
  }

  const dsp = { passed: reasons.length === 0, reasons };
  const network = {
    passed: options.network.passed,
    reasons: [...options.network.reasons],
  };
  return { accepted: dsp.passed && network.passed, dsp, network };
}
