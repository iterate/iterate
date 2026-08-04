import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { connectItxReady } from "iterate/node";
import {
  assessAecWaveformRun,
  type AecWaveformAssessment,
  type AecWaveformStimulusKind,
} from "../src/device/aec-waveform-assessment.ts";
import { killDynamicWorkerGeneration } from "../src/device/dynamic-worker-kill.ts";
import {
  parseKitMetricsCallback,
  type DeviceRuntimeMetrics,
} from "../src/device/device-runtime-log.ts";
import { parseKitControlDiagnostics } from "../src/device/kit-control-diagnostics.ts";
import type {
  KitAecMetrics,
  KitControlDiagnostics,
  KitRawCleanAecMetrics,
  KitSynchronousPlaybackHealthMetrics,
} from "../src/device/kit-device-contract.ts";
import { decodeMonoPcm16Wave } from "../src/device/pcm16-wave-file.ts";
import { quietPhysicalAecAcousticProfile } from "../src/device/physical-aec-acoustic-profile.ts";
import { derivePhysicalAecLifecycleDelta } from "../src/device/physical-aec-lifecycle.ts";
import {
  buildPhysicalNetworkRunArtifact,
  PhysicalNetworkRunMonitor,
  withRemoteDnsAndConnectMeasurement,
  writePhysicalNetworkRunArtifact,
  type PhysicalNetworkMonitorCapture,
  type PhysicalNetworkRunArtifact,
} from "../src/device/physical-network-run.ts";
import {
  discoverDarwinDefaultGateway,
  measureRemoteDnsAndTlsConnect,
  type RemoteDnsAndTlsConnectMeasurement,
  warmPhysicalNetworkReachability,
} from "../src/device/physical-network-reachability.ts";
import {
  assessProductionAecDiagnosticCapture,
  extractProductionAecAnalysisWindow,
  parseProductionAecDiagnosticCapture,
  planProductionAecAnalysisWindow,
  type ProductionAecDiagnosticCapture,
  type ProductionAecDiagnosticCaptureAssessment,
} from "../src/device/production-aec-diagnostic-capture.ts";
import { waitForProductionWorkerMode } from "../src/device/production-worker-mode.ts";
import {
  assessProductionRoutePreflight,
  warmProductionDeviceControlCapability,
} from "../src/device/production-route-preflight.ts";
import { waitForProductionPcmMetrics } from "../src/device/production-pcm-generation.ts";
import { resolveProductionProjectApiKey } from "../src/device/production-project-api-key.ts";
import {
  assessStackChanAecRun,
  parseKitAecMetrics,
  type StackChanAecAssessment,
} from "../src/device/stackchan-aec-assessment.ts";
import {
  assessVoicePeAecRun,
  parseKitRawCleanAecMetrics,
  type VoicePeAecAssessment,
} from "../src/device/voice-pe-aec-assessment.ts";
import { kitVoiceWorkerRef } from "../src/userspace/config-worker/app-ref.ts";
import {
  createDeterministicAecRenderer,
  DETERMINISTIC_AEC_DURATION_MS,
  DETERMINISTIC_AEC_SAMPLE_RATE_HZ,
  deterministicAecResponseRole,
} from "../src/userspace/config-worker/deterministic-aec-fixture.ts";
import { kitDeviceCapabilityPath } from "../src/userspace/config-worker/device-id.ts";
import {
  deviceMetricsCallbackBracket,
  type DeviceMetricsSessionMetrics,
} from "../src/userspace/config-worker/device-metrics.ts";
import { KIT_VOICE_MODE_KEY } from "../src/userspace/install-plan.ts";
import {
  ITERATE_KIT_PCM_FRAME_BYTES,
  type PcmSessionMetrics,
} from "../src/userspace/config-worker/pcm-proxy.ts";

const executeFile = promisify(execFile);
const sampleRateHz = DETERMINISTIC_AEC_SAMPLE_RATE_HZ;
const settledLeadMs = 1_000;
const assessmentIntervalMs = 3_000;
const ambientCapturePlan = planProductionAecAnalysisWindow({
  assessmentDurationMs: assessmentIntervalMs,
  settledLeadMs: 0,
});
const responseCapturePlan = planProductionAecAnalysisWindow({
  assessmentDurationMs: assessmentIntervalMs,
  settledLeadMs,
});
const operationTimeoutMs = 60_000;
const maximumCaptureFrames = 300;
const nearSpeech = Object.freeze({
  rateWordsPerMinute: 180,
  text:
    "Please verify that this nearby voice remains clear while the device speaker is talking. " +
    "This sentence repeats identically in both comparison phases.",
  voice: "Samantha",
});

type DeviceKind = "home-assistant-voice-preview-edition" | "stackchan";
type PhaseName =
  | "ambient"
  | "double-talk"
  | "far-dual-carrier-prbs31"
  | "far-speech-shaped"
  | "far-tone"
  | "near-only"
  | "near-repeat";

interface DeviceDefinition {
  deviceHost: string;
  id: DeviceKind;
  projectId: string;
  projectSlug: string;
  workerHost: string;
}

const deviceDefinitions: Readonly<Record<DeviceKind, DeviceDefinition>> = {
  stackchan: {
    deviceHost: "192.168.1.178",
    id: "stackchan",
    projectId: "prj_0363ecd53eda492e972b07debd56eb46",
    projectSlug: "kit-stackchan-voice-e2e-20260801",
    workerHost: "kit--kit-stackchan-voice-e2e-20260801.iterate.app",
  },
  "home-assistant-voice-preview-edition": {
    deviceHost: "192.168.1.159",
    id: "home-assistant-voice-preview-edition",
    projectId: "prj_4f76ffe131f1495981afd65619f57914",
    projectSlug: "kit-havpe-voice-e2e-20260802",
    workerHost: "kit--kit-havpe-voice-e2e-20260802.iterate.app",
  },
};

interface CliOptions {
  baseUrl: string;
  definition: DeviceDefinition;
  outputDirectory: string;
  projectApiKey?: string;
}

interface ProductionAecPcmMetrics extends PcmSessionMetrics {
  audioMode: string;
  deviceId: string;
  deviceMetrics: DeviceMetricsSessionMetrics;
  diagnosticCapture: unknown;
  providerConnectFailures: number;
  sessionId: string;
}

interface ProductionAecWorker {
  fetch(request: Request): Promise<Response>;
  finishPcmDiagnosticCapture(): Promise<unknown>;
  kill(): Promise<void>;
  pcmMetrics(): Promise<ProductionAecPcmMetrics | null>;
  requestDeterministicResponse(): Promise<boolean>;
  startPcmDiagnosticCapture(maximumFrames: number): Promise<boolean>;
}

interface TimedAecSample {
  phase: PhaseName | null;
  receivedAtMs: number;
  value: KitAecMetrics | KitRawCleanAecMetrics;
}

interface CapturedPhase {
  afterPlayback: KitSynchronousPlaybackHealthMetrics;
  assessment: ProductionAecDiagnosticCaptureAssessment;
  beforePlayback: KitSynchronousPlaybackHealthMetrics;
  capture: ProductionAecDiagnosticCapture;
  clean: Int16Array;
  name: PhaseName;
  playbackObserved: boolean;
  responseIndex: number | null;
}

/**
 * Runs the same six-phase waveform proof through the deployed userspace path
 * used by Grok, without reflashing or opening serial.
 *
 * One project connection and one retained worker handle own the measured run.
 * A throwaway handle is used only to abort the preceding generation before
 * media starts. Opening another observer during media can remount a dynamic
 * worker and sever the very generation being measured; this shape makes that
 * lifecycle hazard structurally hard to reintroduce. Tone mode changes only
 * the provider seam, while device PCM, deployed pacing, public networking,
 * physical speaker/room/microphone, local AEC, Cap'n Web metrics, and the
 * worker's accepted-uplink capture all remain production paths.
 */
export async function proveProductionAecWaveform(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
) {
  const options = parseCliOptions(args, environment);
  const runDirectory = join(
    options.outputDirectory,
    new Date().toISOString().replaceAll(/[:.]/gu, "-"),
  );
  await mkdir(runDirectory, { recursive: true });
  const devicePath = kitDeviceCapabilityPath(options.definition.id);
  const routerHost = await discoverDarwinDefaultGateway();
  const projectApiKey = await resolveProductionProjectApiKey({
    adminApiSecret: environment.APP_CONFIG_ADMIN_API_SECRET,
    baseUrl: options.baseUrl,
    projectApiKey: options.projectApiKey,
    projectId: options.definition.projectId,
  });

  using project = await connectItxReady(
    {
      auth: {
        projectId: options.definition.projectId,
        secret: projectApiKey,
        type: "project-secret",
      },
      baseUrl: options.baseUrl,
      projectId: options.definition.projectId,
    },
    {
      retryInitialConnection: {
        delayMs: 250,
        onRetry: (retry) =>
          console.warn(
            JSON.stringify({
              code: "production-aec-itx-connect-retry",
              delayMs: retry.delayMs,
              message: retry.error.message,
            }),
          ),
      },
    },
  );
  /*
   * Config-worker method types cannot be generated before the project source
   * is installed. The direct stub always supplies kill/Disposable, and this
   * harness validates every custom result at its boundary instead of trusting
   * the refinement below.
   */
  const createWorker = () =>
    project.workers.get(kitVoiceWorkerRef) as unknown as ProductionAecWorker & Disposable;
  const root = project.capabilityHosts.get("/");
  const invoke = async <Value>(path: readonly string[], invokeArgs: unknown[] = []) => {
    /*
     * `invokeCapability` intentionally returns unknown for a dynamic C peer.
     * Callers below either parse diagnostic/metric payloads or compare the
     * primitive acknowledgement they requested before using the value.
     */
    return (await root.invokeCapability({ args: invokeArgs, path: [...path] })) as Value;
  };
  const readDiagnostics = async (): Promise<KitControlDiagnostics> =>
    parseKitControlDiagnostics(await invoke([...devicePath, "getDiagnostics"]));

  const aecSamples: TimedAecSample[] = [];
  const phases = new Map<PhaseName, CapturedPhase>();
  let currentPhase: PhaseName | null = null;
  let callbackFailure: Error | undefined;
  let baselineWorker: ProductionAecPcmMetrics | undefined;
  let terminalWorker: ProductionAecPcmMetrics | undefined;
  let baselineDiagnostics: KitControlDiagnostics | undefined;
  let terminalDiagnostics: KitControlDiagnostics | undefined;
  let baselineGeneral: DeviceRuntimeMetrics | undefined;
  let terminalGeneral: DeviceRuntimeMetrics | undefined;
  let baselinePlayback: KitSynchronousPlaybackHealthMetrics | undefined;
  let terminalPlayback: KitSynchronousPlaybackHealthMetrics | undefined;
  let networkMonitor: PhysicalNetworkRunMonitor | undefined;
  let networkCapture: PhysicalNetworkMonitorCapture | undefined;
  let networkMeasurement: Promise<RemoteDnsAndTlsConnectMeasurement> | undefined;
  let networkArtifact: PhysicalNetworkRunArtifact | undefined;
  let waveformAssessment: AecWaveformAssessment | undefined;
  let stackChanAssessment: StackChanAecAssessment | undefined;
  let voicePeAssessment: VoicePeAecAssessment | undefined;
  let digitalAssessment: ReturnType<typeof assessProductionAecDigitalRun> | undefined;
  let conversationStarted = false;
  let originalMacOutputVolume: number | undefined;
  let runFailure: Error | undefined;
  let rawCaptureStillActive = false;
  let nearSource = new Int16Array();
  let grokModeRestored = false;
  let worker: (ProductionAecWorker & Disposable) | undefined;

  try {
    const description = await invoke<unknown>([...devicePath, "__describe"]);
    await writeExclusiveJson(join(runDirectory, "capability-description.json"), description);
    await invoke<void>(
      [...devicePath, "subscribeToAecMetrics"],
      [
        (value: unknown) => {
          try {
            const parsed =
              options.definition.id === "stackchan"
                ? parseKitAecMetrics(value)
                : parseKitRawCleanAecMetrics(value);
            aecSamples.push({ phase: currentPhase, receivedAtMs: Date.now(), value: parsed });
            if (aecSamples.length > 720) aecSamples.shift();
          } catch (error) {
            callbackFailure = new Error("The production AEC callback was malformed.", {
              cause: error,
            });
          }
        },
      ],
    );
    await waitForAecSample(aecSamples, () => callbackFailure, 0, "the first AEC metric");

    await invoke<boolean>([...devicePath, "conversation", "hangUp"]);
    await project.kv.set(KIT_VOICE_MODE_KEY, "tone");
    {
      /*
       * kill() self-aborts its stub. Never carry that dead capability into
       * the media interval; the next handle names the fresh generation whose
       * counters and capture allocation this run exclusively owns.
       */
      using previousWorker = createWorker();
      await killDynamicWorkerGeneration(previousWorker);
    }
    worker = createWorker();
    const activeWorker = worker;
    await waitForProductionWorkerMode({
      expectedMode: "tone",
      fetch: async (request) => await activeWorker.fetch(request),
    });
    /*
     * A deterministic physical run is intentionally disruptive, and the exact
     * interval classifier will reject even one bad worker sample. Do not play
     * the fixture when the WAN route is already unhealthy. Requiring the
     * eight consecutive probes is stricter than a normal application readiness
     * check. The attempt budget is intentionally larger than eight because the
     * first ICMP packet may warm DNS/ARP state; equating the two budgets made
     * one setup packet mathematically impossible to recover from. No bad probe
     * is removed from the active interval below, which remains authoritative if
     * the route deteriorates after this precondition.
     */
    const [
      preflightReachability,
      preflightDeviceReachability,
      preflightDnsAndConnect,
      preflightControlCapability,
    ] = await Promise.all([
      warmPhysicalNetworkReachability(options.definition.workerHost, {
        interAttemptDelayMs: 250,
        maximumAttempts: 16,
        maximumHealthyRttMs: 100,
        requiredConsecutiveHealthyReplies: 8,
      }),
      /*
       * Warming only the WAN worker left the first active device probe to pay
       * for local ARP/station wake-up. One otherwise clean six-phase run was
       * then correctly—but uselessly—classified network-invalid from that
       * single setup loss. Exercise the exact device address before the audio
       * interval. The active monitor still rejects every later loss; this only
       * moves neighbour discovery outside the evidence boundary.
       */
      warmPhysicalNetworkReachability(options.definition.deviceHost, {
        interAttemptDelayMs: 250,
        maximumAttempts: 16,
        maximumHealthyRttMs: 100,
        requiredConsecutiveHealthyReplies: 8,
      }),
      measureRemoteDnsAndTlsConnect(options.definition.workerHost),
      warmProductionDeviceControlCapability(readDiagnostics),
    ]);
    const routePreflight = assessProductionRoutePreflight({
      controlCapability: preflightControlCapability,
      createdAt: new Date().toISOString(),
      deviceHost: options.definition.deviceHost,
      deviceReachability: preflightDeviceReachability,
      dnsAndConnect: preflightDnsAndConnect,
      reachability: preflightReachability,
      workerHost: options.definition.workerHost,
    });
    await writeExclusiveJson(join(runDirectory, "network-preflight.json"), routePreflight);
    if (!routePreflight.passed) {
      throw new Error(`Production route preflight failed: ${routePreflight.reasons.join(" ")}`);
    }
    if ((await invoke<boolean>([...devicePath, "conversation", "start"])) !== true) {
      throw new Error(`${options.definition.id} rejected remote conversation.start().`);
    }
    conversationStarted = true;
    baselineWorker = await waitForProductionPcmMetrics({
      description: "the deployed deterministic full-duplex PCM generation",
      predicate: (metrics) =>
        !metrics.closed &&
        metrics.audioMode === "full-duplex-aec" &&
        metrics.conversationActive &&
        metrics.deviceId === options.definition.id &&
        metrics.providerAvailable &&
        metrics.providerConnectFailures === 0 &&
        metrics.deviceMetrics.samplesReceived > 0 &&
        metrics.deviceMetrics.invalidSamples === 0,
      timeoutMs: operationTimeoutMs,
      worker: activeWorker,
    });
    baselineGeneral = readLatestGeneralMetrics(baselineWorker, "media baseline");
    const baselineAecIndex = aecSamples.length;
    baselinePlayback = (
      await waitForAecSample(
        aecSamples,
        () => callbackFailure,
        baselineAecIndex,
        "a post-generation AEC metric",
      )
    ).value;
    baselineDiagnostics = await readDiagnostics();
    networkMonitor = new PhysicalNetworkRunMonitor({
      deviceHost: options.definition.deviceHost,
      diagnostics: readDiagnostics,
      routerHost,
      workerHost: options.definition.workerHost,
    });
    networkMonitor.start();
    networkMeasurement = measureRemoteDnsAndTlsConnect(options.definition.workerHost);
    console.log(
      `production_aec_ready device=${options.definition.id} session=${baselineWorker.sessionId} ` +
        `device_host=${options.definition.deviceHost} worker=${options.definition.workerHost}`,
    );

    const nearWavePath = join(runDirectory, "mac-near-source.wav");
    await executeFile("/usr/bin/say", [
      "-v",
      nearSpeech.voice,
      "-r",
      String(nearSpeech.rateWordsPerMinute),
      "-o",
      nearWavePath,
      "--file-format=WAVE",
      `--data-format=LEI16@${sampleRateHz}`,
      "--channels=1",
      nearSpeech.text,
    ]);
    const decodedNearWave = decodeMonoPcm16Wave(await readFile(nearWavePath));
    if (decodedNearWave.sampleRateHz !== sampleRateHz) {
      throw new Error(
        `macOS say produced ${decodedNearWave.sampleRateHz} Hz instead of ${sampleRateHz} Hz.`,
      );
    }
    const nearPcm = decodePcm16Le(decodedNearWave.pcm);
    nearSource = sliceSamples(
      nearPcm,
      settledLeadMs,
      assessmentIntervalMs,
      "the retained Mac source",
    );
    originalMacOutputVolume = await readMacOutputVolume();
    await setMacOutputVolume(quietPhysicalAecAcousticProfile.macOutputVolumePercent);

    currentPhase = "ambient";
    const ambientBefore = latestAecSample(aecSamples).value;
    const ambientCapture = await captureAcceptedUplink(
      activeWorker,
      ambientCapturePlan.captureDurationMs,
      () => {
        rawCaptureStillActive = true;
      },
      () => {
        rawCaptureStillActive = false;
      },
    );
    const ambientAssessment = await persistCapture(runDirectory, "ambient", ambientCapture);
    requireConservedCapture("ambient", ambientAssessment);
    const ambientAfter = latestAecSample(aecSamples).value;
    phases.set("ambient", {
      afterPlayback: ambientAfter,
      assessment: ambientAssessment,
      beforePlayback: ambientBefore,
      capture: ambientCapture,
      clean: extractProductionAecAnalysisWindow(
        ambientCapture.samples,
        ambientCapturePlan,
        "ambient capture",
      ),
      name: "ambient",
      playbackObserved: false,
      responseIndex: null,
    });
    currentPhase = null;

    const responsePhases = [
      { name: "far-tone", responseIndex: 0 },
      { name: "far-dual-carrier-prbs31", responseIndex: 1 },
      { name: "far-speech-shaped", responseIndex: 2 },
      { name: "near-only", nearWavePath, responseIndex: 3 },
      { name: "near-repeat", nearWavePath, responseIndex: 4 },
      { name: "double-talk", nearWavePath, responseIndex: 5 },
    ] as const;
    for (const phase of responsePhases) {
      currentPhase = phase.name;
      const captured = await runResponsePhase({
        aecSamples,
        callbackFailure: () => callbackFailure,
        expectedSessionId: baselineWorker.sessionId,
        markCaptureFinished: () => {
          rawCaptureStillActive = false;
        },
        markCaptureStarted: () => {
          rawCaptureStillActive = true;
        },
        name: phase.name,
        nearWavePath: "nearWavePath" in phase ? phase.nearWavePath : undefined,
        responseIndex: phase.responseIndex,
        worker: activeWorker,
      });
      const captureAssessment = await persistCapture(runDirectory, phase.name, captured.capture);
      requireConservedCapture(phase.name, captureAssessment);
      phases.set(phase.name, {
        ...captured,
        assessment: captureAssessment,
        clean: extractProductionAecAnalysisWindow(
          captured.capture.samples,
          responseCapturePlan,
          `${phase.name} capture`,
        ),
      });
      currentPhase = null;
      console.log(
        `production_aec_phase=${phase.name} frames=${captured.capture.frames} ` +
          `duration_ms=${captured.capture.durationMs}`,
      );
    }

    const terminalAecIndex = aecSamples.length;
    terminalWorker = await waitForProductionPcmMetrics({
      description: "terminal deterministic AEC worker metrics",
      expectedSessionId: baselineWorker.sessionId,
      predicate: (metrics) =>
        metrics.diagnosticResponseRequests === responsePhases.length &&
        metrics.providerResponsesCompleted === responsePhases.length &&
        !metrics.providerResponseActive &&
        metrics.downlinkQueuedBytes === 0 &&
        metrics.diagnosticCapture === null,
      timeoutMs: operationTimeoutMs,
      worker: activeWorker,
    });
    terminalPlayback = (
      await waitForAecSample(
        aecSamples,
        () => callbackFailure,
        terminalAecIndex,
        "the terminal AEC metric",
      )
    ).value;
    terminalGeneral = readLatestGeneralMetrics(terminalWorker, "terminal");
    terminalDiagnostics = await readDiagnostics();
    networkCapture = await networkMonitor.capture();
    networkMonitor = undefined;
    const measuredDns = await networkMeasurement;
    const attributedNetworkCapture = withRemoteDnsAndConnectMeasurement(
      networkCapture,
      measuredDns,
    );
    const pcmEvidence = productionPcmEvidence(baselineWorker, terminalWorker);
    const preliminaryNetwork = buildPhysicalNetworkRunArtifact({
      ...attributedNetworkCapture,
      audio: { failure: null, passed: true },
      pcmEvidence,
    });
    digitalAssessment = assessProductionAecDigitalRun({
      baselineDiagnostics,
      baselineWorker,
      terminalDiagnostics,
      terminalWorker,
    });
    const lifecycle = derivePhysicalAecLifecycleDelta({
      afterGeneral: terminalGeneral,
      afterPlayback: terminalPlayback,
      beforeGeneral: baselineGeneral,
      beforePlayback: baselinePlayback,
    });
    const successfulDiagnostics = attributedNetworkCapture.diagnostics.flatMap((sample) =>
      sample.outcome === "success" ? [sample.diagnostics] : [],
    );
    const firstIntervalDiagnostics = successfulDiagnostics[0];
    const lastIntervalDiagnostics = successfulDiagnostics.at(-1);
    const websocketReconnects =
      firstIntervalDiagnostics && lastIntervalDiagnostics
        ? monotonicDelta(
            firstIntervalDiagnostics.network.pcmWebsocketConnections,
            lastIntervalDiagnostics.network.pcmWebsocketConnections,
          )
        : 1;
    const allCaptureAssessments = [...phases.values()].map((phase) => phase.assessment);
    waveformAssessment = assessAecWaveformRun({
      ambient: requirePhase(phases, "ambient").clean,
      doubleTalk: {
        clean: requirePhase(phases, "double-talk").clean,
        farSource: responseSource(5),
        nearOnlyClean: requirePhase(phases, "near-only").clean,
        nearSource,
        playbackObserved: requirePhase(phases, "double-talk").playbackObserved,
      },
      farEndOnly: [
        farPhase(phases, "far-tone", "tone", 0),
        farPhase(phases, "far-dual-carrier-prbs31", "dual-carrier-prbs31", 1),
        farPhase(phases, "far-speech-shaped", "speech-shaped", 2),
      ],
      nearEndOnly: {
        clean: requirePhase(phases, "near-only").clean,
        pathReferenceObserved: requirePhase(phases, "near-only").playbackObserved,
        source: nearSource,
      },
      nearEndRepeat: {
        clean: requirePhase(phases, "near-repeat").clean,
        pathReferenceObserved: requirePhase(phases, "near-repeat").playbackObserved,
      },
      sampleRateHz,
      validity: {
        captureFailures: lifecycle.captureFailures,
        captureFrameDrops: lifecycle.captureFrameDrops,
        clockDiscontinuities: 0,
        networkValid: preliminaryNetwork.network.verdict === "valid",
        playbackDroppedFrames: lifecycle.playbackDroppedFrames,
        playbackIntegrityFailures: lifecycle.playbackIntegrityFailures,
        playbackResets: lifecycle.playbackResets,
        playbackUnderrunIncidents: 0,
        recorderComplete: allCaptureAssessments.every((assessment) => assessment.passed),
        uplinkFrameDrops: lifecycle.uplinkFrameDrops,
        uplinkRestarts: lifecycle.uplinkRestarts,
        websocketReconnects,
      },
    });
    if (options.definition.id === "stackchan") {
      /*
       * The waveform capture proves what reached the provider, while schema-11
       * device counters prove that result was not bought with clipping, missed
       * DSP deadlines, capture loss, reset, or underrun. The baseline index is
       * after conversation startup, so the intentional startup reset is not
       * misclassified as an in-call transport failure.
       */
      const stackChanSamples = aecSamples
        .slice(baselineAecIndex)
        .flatMap((sample) => ("engineProfile" in sample.value ? [sample.value] : []));
      stackChanAssessment = assessStackChanAecRun(stackChanSamples);
    } else {
      /*
       * HAVPE's XMOS exposes simultaneous original/processed microphone taps,
       * not StackChan's explicit electrical reference. Keep every in-call
       * sample in the lifecycle assessment so a clean-looking acoustic window
       * cannot hide capture loss or playback faults. The phase lists only tell
       * the assessor which settled windows contain deliberate speaker energy
       * and which contain the repeated live Mac voice; they do not trim the
       * interval whose cumulative counters must remain fault-free.
       */
      const voicePeSamples = aecSamples
        .slice(baselineAecIndex)
        .flatMap((sample) =>
          "topology" in sample.value ? [{ phase: sample.phase, value: sample.value }] : [],
        );
      voicePeAssessment = assessVoicePeAecRun(
        voicePeSamples.map((sample) => sample.value),
        {
          /*
           * HAVPE's original-microphone tap is intentionally low gain. A
           * dedicated pre-stimulus phase lets the oracle require near speech
           * to clear this run's physical floor instead of baking a board gain
           * into an otherwise portable proof.
           */
          ambientSequences: voicePeSamples
            .filter((sample) => sample.phase === "ambient")
            .map((sample) => sample.value.sequence),
          farEndSequences: voicePeSamples
            .filter(
              (sample) =>
                sample.phase === "far-tone" ||
                sample.phase === "far-dual-carrier-prbs31" ||
                sample.phase === "far-speech-shaped",
            )
            .map((sample) => sample.value.sequence),
          nearEndSequences: voicePeSamples
            .filter((sample) => sample.phase === "near-only" || sample.phase === "near-repeat")
            .map((sample) => sample.value.sequence),
        },
      );
    }
    const audioReasons = [
      ...waveformAssessment.reasons,
      ...digitalAssessment.reasons.map((reason) => `Digital: ${reason}`),
      ...(stackChanAssessment?.reasons.map((reason) => `StackChan health: ${reason}`) ?? []),
      ...(voicePeAssessment?.reasons.map((reason) => `HAVPE health: ${reason}`) ?? []),
    ];
    const audioPassed =
      waveformAssessment.passed &&
      digitalAssessment.passed &&
      (options.definition.id === "stackchan"
        ? stackChanAssessment?.passed === true
        : voicePeAssessment?.passed === true);
    networkArtifact = buildPhysicalNetworkRunArtifact({
      ...attributedNetworkCapture,
      audio: {
        failure: audioPassed ? null : audioReasons.join(" "),
        passed: audioPassed,
      },
      pcmEvidence,
    });
    await writePhysicalNetworkRunArtifact(join(runDirectory, "network.json"), networkArtifact);
    if (!audioPassed || networkArtifact.classification !== "valid") {
      throw new Error(
        `Production AEC acceptance failed (${networkArtifact.classification}): ` +
          audioReasons.join(" "),
      );
    }
  } catch (error) {
    runFailure = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (rawCaptureStillActive && worker) {
      try {
        await worker.finishPcmDiagnosticCapture();
      } catch (error) {
        runFailure = combineFailure(runFailure, error, "Diagnostic capture cleanup failed.");
      }
      rawCaptureStillActive = false;
    }
    if (networkMonitor) {
      try {
        networkCapture = await networkMonitor.capture();
        networkMonitor = undefined;
      } catch (error) {
        runFailure = combineFailure(runFailure, error, "Network monitor cleanup failed.");
      }
    }
    if (baselineWorker && worker) {
      try {
        terminalWorker = (await worker.pcmMetrics()) ?? terminalWorker;
      } catch {
        // Device diagnostics and the retained baseline still identify the loss.
      }
    }
    try {
      terminalDiagnostics ??= await readDiagnostics();
    } catch {
      // Interval sampling already records control-lane loss without inventing a value.
    }
    if (conversationStarted) {
      try {
        await invoke<boolean>([...devicePath, "conversation", "hangUp"]);
      } catch (error) {
        runFailure = combineFailure(runFailure, error, "Remote conversation cleanup failed.");
      }
    }
    try {
      /*
       * This fixture is never a product default. Restore Grok even if the
       * project happened to be left in tone mode by an earlier interrupted
       * proof, then kill the disposable incarnation so the next call cannot
       * inherit the deterministic provider.
       */
      await project.kv.set(KIT_VOICE_MODE_KEY, "grok");
      using restorationWorker = createWorker();
      await waitForProductionWorkerMode({
        expectedMode: "grok",
        fetch: async (request) => await restorationWorker.fetch(request),
      });
      await killDynamicWorkerGeneration(restorationWorker);
      grokModeRestored = true;
    } catch (error) {
      runFailure = combineFailure(runFailure, error, "Could not restore Grok mode.");
    }
    if (originalMacOutputVolume !== undefined) {
      try {
        await setMacOutputVolume(originalMacOutputVolume);
      } catch (error) {
        runFailure = combineFailure(runFailure, error, "Could not restore Mac output volume.");
      }
    }
    try {
      worker?.[Symbol.dispose]();
      worker = undefined;
    } catch (error) {
      runFailure = combineFailure(runFailure, error, "Could not release the worker RPC handle.");
    }
  }

  if (!networkArtifact && networkCapture && baselineWorker && terminalWorker) {
    let measuredDns: RemoteDnsAndTlsConnectMeasurement | undefined;
    try {
      measuredDns = await networkMeasurement;
    } catch {
      // Missing one-shot evidence remains explicitly not-observed below.
    }
    const attributed = withRemoteDnsAndConnectMeasurement(networkCapture, measuredDns);
    networkArtifact = buildPhysicalNetworkRunArtifact({
      ...attributed,
      audio: { failure: runFailure?.message ?? "The AEC run was incomplete.", passed: false },
      pcmEvidence: productionPcmEvidence(baselineWorker, terminalWorker),
    });
    await writePhysicalNetworkRunArtifact(join(runDirectory, "network.json"), networkArtifact);
  }

  /*
   * The manifest is a claim about the resulting production state, not merely
   * whether the main try block happened to throw. Fail closed if a future edit
   * skips one acceptance layer or if deterministic mode could not be removed:
   * a clean waveform must never leave the next real conversation on the test
   * provider, and absent evidence is not success.
   */
  if (
    !runFailure &&
    (!waveformAssessment?.passed ||
      !digitalAssessment?.passed ||
      (options.definition.id === "stackchan"
        ? !stackChanAssessment?.passed
        : !voicePeAssessment?.passed) ||
      networkArtifact?.classification !== "valid" ||
      !grokModeRestored)
  ) {
    runFailure = new Error(
      "The production AEC run ended without a complete valid acoustic, digital, network, and cleanup verdict.",
    );
  }

  await Promise.all([
    writeExclusiveJson(join(runDirectory, "aec-metrics.json"), aecSamples),
    writeExclusiveJson(
      join(runDirectory, "stackchan-aec-health.json"),
      stackChanAssessment ?? null,
    ),
    writeExclusiveJson(join(runDirectory, "voice-pe-aec-health.json"), voicePeAssessment ?? null),
    writeExclusiveJson(join(runDirectory, "phase-summary.json"), phaseSummary(phases)),
    writeExclusiveJson(join(runDirectory, runFailure ? "failure.json" : "manifest.json"), {
      aec: waveformAssessment ?? null,
      stackChanHealth: stackChanAssessment ?? null,
      voicePeHealth: voicePeAssessment ?? null,
      createdAt: new Date().toISOString(),
      device: options.definition,
      digital: digitalAssessment ?? null,
      error: runFailure ? serializeError(runFailure) : null,
      network: networkArtifact
        ? {
            classification: networkArtifact.classification,
            reasons: networkArtifact.network.reasons,
            verdict: networkArtifact.network.verdict,
          }
        : null,
      passed: !runFailure,
      projectModeRestored: grokModeRestored,
      schemaVersion: 1,
      stimuli: {
        macOutputVolumePercent: quietPhysicalAecAcousticProfile.macOutputVolumePercent,
        nearSourceSha256:
          nearSource.length > 0 ? createHash("sha256").update(nearSource).digest("hex") : null,
        nearSpeech,
        providerDurationMs: DETERMINISTIC_AEC_DURATION_MS,
      },
      worker: {
        baseline: baselineWorker ?? null,
        deviceMetricsCallbackBracket: deviceMetricsCallbackBracket(
          baselineWorker?.deviceMetrics,
          terminalWorker?.deviceMetrics,
        ),
        terminal: terminalWorker ?? null,
      },
    }),
  ]);

  if (runFailure) {
    throw new Error(`${runFailure.message} Evidence: ${runDirectory}`, { cause: runFailure });
  }
  console.log(
    `production_aec_complete device=${options.definition.id} network=${networkArtifact!.classification} ` +
      `evidence=${runDirectory}`,
  );
  return { evidence: runDirectory, network: networkArtifact!.classification, passed: true };
}

async function runResponsePhase(options: {
  aecSamples: TimedAecSample[];
  callbackFailure: () => Error | undefined;
  expectedSessionId: string;
  markCaptureFinished: () => void;
  markCaptureStarted: () => void;
  name: Exclude<PhaseName, "ambient">;
  nearWavePath?: string;
  responseIndex: number;
  worker: ProductionAecWorker;
}): Promise<Omit<CapturedPhase, "assessment" | "clean">> {
  const beforePlayback = latestAecSample(options.aecSamples).value;
  const baseline = await requireWorkerMetrics(options.worker, options.expectedSessionId);
  if (!(await options.worker.requestDeterministicResponse())) {
    throw new Error(`The worker rejected deterministic response ${options.responseIndex}.`);
  }
  await waitForProductionPcmMetrics({
    description: `the first ${options.name} downlink frame`,
    expectedSessionId: options.expectedSessionId,
    predicate: (metrics) =>
      metrics.diagnosticResponseRequests === baseline.diagnosticResponseRequests + 1 &&
      metrics.downlinkFrames > baseline.downlinkFrames,
    timeoutMs: operationTimeoutMs,
    worker: options.worker,
  });
  const capture = await captureAcceptedUplink(
    options.worker,
    responseCapturePlan.captureDurationMs,
    options.markCaptureStarted,
    options.markCaptureFinished,
    options.nearWavePath,
  );
  await waitForProductionPcmMetrics({
    description: `the physically drained ${options.name} response`,
    expectedSessionId: options.expectedSessionId,
    predicate: (metrics) =>
      metrics.providerResponsesCompleted === baseline.providerResponsesCompleted + 1 &&
      !metrics.providerResponseActive &&
      metrics.downlinkQueuedBytes === 0 &&
      metrics.diagnosticCapture === null,
    timeoutMs: operationTimeoutMs,
    worker: options.worker,
  });
  /*
   * Metrics are periodic. A sample received while frames were merely queued
   * cannot prove the speaker consumed them. Take the boundary only after the
   * worker reports the response fully drained, then require a newer callback
   * whose lifetime counter necessarily observes that completed interval.
   */
  const postDrainAecIndex = options.aecSamples.length;
  const afterPlayback = (
    await waitForAecSample(
      options.aecSamples,
      options.callbackFailure,
      postDrainAecIndex,
      `a post-drain ${options.name} playback metric`,
    )
  ).value;
  const playbackContentSamples = monotonicDelta(
    beforePlayback.lifetimePlaybackContentSamples,
    afterPlayback.lifetimePlaybackContentSamples,
  );
  return {
    afterPlayback,
    beforePlayback,
    capture,
    name: options.name,
    playbackObserved: playbackContentSamples >= 8_000,
    responseIndex: options.responseIndex,
  };
}

async function captureAcceptedUplink(
  worker: ProductionAecWorker,
  durationMs: number,
  markStarted: () => void,
  markFinished: () => void,
  nearWavePath?: string,
) {
  if (!(await worker.startPcmDiagnosticCapture(maximumCaptureFrames))) {
    throw new Error("The worker rejected the bounded PCM diagnostic capture.");
  }
  markStarted();
  const nearPlayback = nearWavePath ? playFile(nearWavePath) : undefined;
  await delay(durationMs);
  const value = await worker.finishPcmDiagnosticCapture();
  markFinished();
  if (nearPlayback) await withTimeout(nearPlayback, operationTimeoutMs, "Mac near-end playback");
  if (value === null) throw new Error("The worker lost the active PCM diagnostic capture.");
  return parseProductionAecDiagnosticCapture(value);
}

async function persistCapture(
  runDirectory: string,
  phase: PhaseName,
  capture: ProductionAecDiagnosticCapture,
) {
  const assessment = assessProductionAecDiagnosticCapture(capture);
  await Promise.all([
    writeFile(join(runDirectory, `${phase}.accepted-uplink.pcm`), capture.pcm, { flag: "wx" }),
    writeExclusiveJson(join(runDirectory, `${phase}.capture.json`), {
      assessment,
      capture: {
        acceptedFrameSpanMs: capture.acceptedFrameSpanMs,
        capturedAudioDurationMs: capture.capturedAudioDurationMs,
        durationMs: capture.durationMs,
        finishedAtMs: capture.finishedAtMs,
        firstAcceptedAtMs: capture.firstAcceptedAtMs,
        firstAcceptedUplinkFrame: capture.firstAcceptedUplinkFrame,
        frameBytes: capture.frameBytes,
        frames: capture.frames,
        lastAcceptedAtMs: capture.lastAcceptedAtMs,
        lastAcceptedUplinkFrame: capture.lastAcceptedUplinkFrame,
        maximumFrames: capture.maximumFrames,
        maximumInterFrameGapMs: capture.maximumInterFrameGapMs,
        pcmSha256: createHash("sha256").update(capture.pcm).digest("hex"),
        schemaVersion: capture.schemaVersion,
        startedAtMs: capture.startedAtMs,
        truncatedFrames: capture.truncatedFrames,
      },
    }),
  ]);
  return assessment;
}

/**
 * Stops only when bytes/ordinals are no longer an interpretable waveform.
 *
 * Cadence remains an acceptance requirement, but it is evaluated after every
 * phase so one late control boundary cannot suppress the double-talk evidence
 * and interval-aligned network samples needed to attribute the fault. This is
 * evidence completion, not a relaxed final gate: `recorderComplete` below
 * still requires every combined capture assessment to pass.
 */
function requireConservedCapture(
  phase: PhaseName,
  assessment: ProductionAecDiagnosticCaptureAssessment,
) {
  if (!assessment.frameConservationPassed) {
    throw new Error(`Non-conserved ${phase} uplink capture: ${assessment.reasons.join(" ")}`);
  }
}

function responseSource(responseIndex: number) {
  const renderer = createDeterministicAecRenderer(responseIndex);
  const pcm = renderer.render((DETERMINISTIC_AEC_DURATION_MS * sampleRateHz) / 1_000);
  return sliceSamples(
    decodePcm16Le(pcm),
    settledLeadMs,
    assessmentIntervalMs,
    deterministicAecResponseRole(responseIndex),
  );
}

function farPhase(
  phases: ReadonlyMap<PhaseName, CapturedPhase>,
  name: Extract<PhaseName, `far-${string}`>,
  kind: AecWaveformStimulusKind,
  responseIndex: number,
) {
  const phase = requirePhase(phases, name);
  return {
    clean: phase.clean,
    kind,
    playbackObserved: phase.playbackObserved,
    source: responseSource(responseIndex),
  };
}

function requirePhase(phases: ReadonlyMap<PhaseName, CapturedPhase>, name: PhaseName) {
  const phase = phases.get(name);
  if (!phase) throw new Error(`The production AEC run did not retain phase ${name}.`);
  return phase;
}

function sliceSamples(samples: Int16Array, startMs: number, durationMs: number, label: string) {
  const start = (startMs * sampleRateHz) / 1_000;
  const length = (durationMs * sampleRateHz) / 1_000;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length)) {
    throw new Error(`${label} does not align to whole PCM samples.`);
  }
  if (samples.length < start + length) {
    throw new Error(`${label} retained ${samples.length} samples; ${start + length} are required.`);
  }
  return samples.slice(start, start + length);
}

function decodePcm16Le(bytes: Uint8Array) {
  if (bytes.byteLength % Int16Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("PCM16LE evidence has an odd byte count.");
  }
  const samples = new Int16Array(bytes.byteLength / Int16Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * Int16Array.BYTES_PER_ELEMENT, true);
  }
  return samples;
}

function latestAecSample(samples: readonly TimedAecSample[]) {
  const sample = samples.at(-1);
  if (!sample) throw new Error("No AEC callback sample is available.");
  return sample;
}

async function waitForAecSample(
  samples: readonly TimedAecSample[],
  callbackFailure: () => Error | undefined,
  minimumIndex: number,
  description: string,
) {
  const deadline = performance.now() + operationTimeoutMs;
  while (performance.now() < deadline) {
    const failure = callbackFailure();
    if (failure) throw failure;
    const sample = samples[minimumIndex];
    if (sample) return sample;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function requireWorkerMetrics(worker: ProductionAecWorker, expectedSessionId: string) {
  const metrics = await worker.pcmMetrics();
  if (!metrics || metrics.closed || metrics.sessionId !== expectedSessionId) {
    throw new Error(`The deployed PCM generation ${expectedSessionId} is no longer active.`);
  }
  return metrics;
}

function readLatestGeneralMetrics(metrics: ProductionAecPcmMetrics, boundary: string) {
  const value = metrics.deviceMetrics.latestSample?.metrics;
  if (value === undefined) {
    throw new Error(`The userspace worker retained no device metrics at the ${boundary}.`);
  }
  const parsed = parseKitMetricsCallback(value);
  if (parsed.kind !== "metrics") {
    throw new Error(
      parsed.kind === "failure"
        ? `The ${boundary} device metrics were malformed: ${parsed.reason}`
        : `The ${boundary} callback returned a device event instead of metrics.`,
    );
  }
  return parsed.values;
}

export function assessProductionAecDigitalRun(options: {
  baselineDiagnostics: KitControlDiagnostics;
  baselineWorker: ProductionAecPcmMetrics;
  terminalDiagnostics: KitControlDiagnostics;
  terminalWorker: ProductionAecPcmMetrics;
}) {
  const reasons: string[] = [];
  if (options.terminalWorker.sessionId !== options.baselineWorker.sessionId) {
    reasons.push("The deployed PCM generation changed during the waveform run.");
  }
  if (options.terminalWorker.closed) reasons.push("The deployed PCM generation closed.");
  const expectedResponses = 6;
  const expectedProviderSamples =
    (expectedResponses * DETERMINISTIC_AEC_DURATION_MS * sampleRateHz) / 1_000;
  const expectedDownlinkFrames =
    (expectedProviderSamples * Int16Array.BYTES_PER_ELEMENT) / ITERATE_KIT_PCM_FRAME_BYTES;
  for (const [label, actual, expected] of [
    [
      "deterministic response requests",
      options.terminalWorker.diagnosticResponseRequests -
        options.baselineWorker.diagnosticResponseRequests,
      expectedResponses,
    ],
    [
      "completed provider responses",
      options.terminalWorker.providerResponsesCompleted -
        options.baselineWorker.providerResponsesCompleted,
      expectedResponses,
    ],
    [
      "provider PCM samples",
      options.terminalWorker.providerPcmSamples - options.baselineWorker.providerPcmSamples,
      expectedProviderSamples,
    ],
    [
      "device downlink frames",
      options.terminalWorker.downlinkFrames - options.baselineWorker.downlinkFrames,
      expectedDownlinkFrames,
    ],
    [
      "device downlink items sent",
      options.terminalWorker.downlinkItemsSent - options.baselineWorker.downlinkItemsSent,
      expectedDownlinkFrames + expectedResponses,
    ],
    [
      "device downlink items acknowledged",
      options.terminalWorker.downlinkItemsAcknowledged -
        options.baselineWorker.downlinkItemsAcknowledged,
      expectedDownlinkFrames + expectedResponses,
    ],
  ] as const) {
    if (actual !== expected) reasons.push(`${label} changed by ${actual}; expected ${expected}.`);
  }
  for (const field of [
    "downlinkDroppedBytes",
    "downlinkPacingOverrunFrames",
    "downlinkPartialBytes",
    "downlinkReceiptTimeouts",
    "providerResponsesFailed",
    "providerSendFailures",
    "uplinkDroppedBytes",
    "uplinkUnavailableFrames",
  ] as const) {
    const delta = options.terminalWorker[field] - options.baselineWorker[field];
    if (delta !== 0) reasons.push(`Worker ${field} changed by ${delta}.`);
  }
  if (options.terminalWorker.downlinkQueuedBytes !== 0) {
    reasons.push(
      `The terminal downlink reservoir retained ${options.terminalWorker.downlinkQueuedBytes} bytes.`,
    );
  }
  if (options.terminalWorker.downlinkItemsInFlight !== 0) {
    reasons.push(
      `The terminal device receipt ledger retained ${options.terminalWorker.downlinkItemsInFlight} in-flight items.`,
    );
  }
  if (options.terminalWorker.diagnosticCapture !== null) {
    reasons.push("The terminal worker still owned a diagnostic capture allocation.");
  }
  if (
    options.terminalDiagnostics.control.websocketConnections !==
    options.baselineDiagnostics.control.websocketConnections
  ) {
    reasons.push("The Cap'n Web control socket reconnected during the waveform run.");
  }
  if (
    options.terminalDiagnostics.network.pcmWebsocketConnections !==
    options.baselineDiagnostics.network.pcmWebsocketConnections
  ) {
    reasons.push("The PCM socket reconnected during the waveform run.");
  }
  if (
    options.terminalDiagnostics.network.pcmWebsocketDisconnects !==
    options.baselineDiagnostics.network.pcmWebsocketDisconnects
  ) {
    reasons.push("The PCM socket disconnected during the waveform run.");
  }
  return { passed: reasons.length === 0, reasons };
}

function productionPcmEvidence(
  baseline: ProductionAecPcmMetrics,
  terminal: ProductionAecPcmMetrics,
) {
  return {
    kind: "device-observed" as const,
    progress: {
      deviceToWorkerBytes:
        Math.max(0, terminal.uplinkFrames - baseline.uplinkFrames) * ITERATE_KIT_PCM_FRAME_BYTES,
      workerToDeviceBytes:
        Math.max(0, terminal.downlinkFrames - baseline.downlinkFrames) *
        ITERATE_KIT_PCM_FRAME_BYTES,
    },
  };
}

function phaseSummary(phases: ReadonlyMap<PhaseName, CapturedPhase>) {
  return [...phases.values()].map((phase) => ({
    assessment: phase.assessment,
    capture: {
      durationMs: phase.capture.durationMs,
      frames: phase.capture.frames,
      truncatedFrames: phase.capture.truncatedFrames,
    },
    name: phase.name,
    playbackObserved: phase.playbackObserved,
    responseIndex: phase.responseIndex,
  }));
}

function monotonicDelta(before: unknown, after: unknown) {
  return typeof before === "number" && typeof after === "number" && after >= before
    ? after - before
    : 1;
}

function playFile(path: string) {
  return new Promise<void>((resolvePlayback, rejectPlayback) => {
    const child = spawn("/usr/bin/afplay", [path], { stdio: "ignore" });
    child.once("error", rejectPlayback);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePlayback();
      else {
        rejectPlayback(
          new Error(
            signal
              ? `afplay terminated by ${signal}.`
              : `afplay exited with status ${String(code)}.`,
          ),
        );
      }
    });
  });
}

function withTimeout<Value>(promise: Promise<Value>, timeoutMs: number, label: string) {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error(`Timed out waiting for ${label}.`);
    }),
  ]);
}

async function readMacOutputVolume() {
  const output = await executeFile("/usr/bin/osascript", [
    "-e",
    "output volume of (get volume settings)",
  ]);
  const volume = Number(output.stdout.trim());
  if (!Number.isSafeInteger(volume) || volume < 0 || volume > 100) {
    throw new Error(`macOS returned invalid output volume ${JSON.stringify(output.stdout)}.`);
  }
  return volume;
}

async function setMacOutputVolume(volume: number) {
  await executeFile("/usr/bin/osascript", ["-e", `set volume output volume ${volume}`]);
}

function combineFailure(current: Error | undefined, next: unknown, message: string) {
  const nextError = next instanceof Error ? next : new Error(String(next));
  return current ? new AggregateError([current, nextError], message) : nextError;
}

function serializeError(error: Error): Record<string, unknown> {
  return error instanceof AggregateError
    ? {
        errors: [...error.errors].map((nested) =>
          serializeError(nested instanceof Error ? nested : new Error(String(nested))),
        ),
        message: error.message,
        name: error.name,
        stack: error.stack,
      }
    : {
        cause: error.cause instanceof Error ? serializeError(error.cause) : error.cause,
        message: error.message,
        name: error.name,
        stack: error.stack,
      };
}

async function writeExclusiveJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function parseCliOptions(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): CliOptions {
  let deviceId = environment.ITERATE_KIT_DEVICE_ID?.trim() || "stackchan";
  let baseUrl = environment.ITERATE_KIT_BASE_URL?.trim() || "https://os.iterate.com";
  let deviceHost: string | undefined;
  let workerHost: string | undefined;
  let projectId: string | undefined;
  let outputDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = () => {
      const selected = args[++index]?.trim();
      if (!selected) throw new Error(`${flag} requires a value.`);
      return selected;
    };
    if (flag === "--device-id") deviceId = value();
    else if (flag === "--base-url") baseUrl = value();
    else if (flag === "--device-host") deviceHost = value();
    else if (flag === "--worker-host") workerHost = value();
    else if (flag === "--project-id") projectId = value();
    else if (flag === "--output-directory") outputDirectory = value();
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (deviceId !== "stackchan" && deviceId !== "home-assistant-voice-preview-edition") {
    throw new Error("--device-id must be stackchan or home-assistant-voice-preview-edition.");
  }
  const defaults = deviceDefinitions[deviceId];
  const definition = {
    ...defaults,
    deviceHost: deviceHost ?? defaults.deviceHost,
    projectId: projectId ?? defaults.projectId,
    workerHost: workerHost ?? defaults.workerHost,
  };
  const projectApiKey = environment.ITERATE_KIT_PROJECT_API_KEY?.trim() || undefined;
  return {
    baseUrl: new URL(baseUrl).origin,
    definition,
    outputDirectory:
      outputDirectory ??
      fileURLToPath(new URL(`../evidence/${deviceId}-production-aec-waveform`, import.meta.url)),
    projectApiKey,
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], "file:"))
) {
  try {
    const result = await proveProductionAecWaveform(process.argv.slice(2), process.env);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, () => process.exit(0));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () =>
      process.exit(1),
    );
  }
}
