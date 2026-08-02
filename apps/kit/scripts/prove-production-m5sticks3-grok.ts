import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { connectItxReady } from "iterate/node";
import {
  analyzePcm16WindowEnergy,
  assessCausalSpeechEnergy,
  causalSpeechActiveThreshold,
} from "../src/device/causal-speech-energy-analysis.ts";
import {
  devicePlaybackCompleted,
  devicePlaybackResponseCompleted,
  deviceUplinkStreaming,
  parseKitMetricsCallback,
  type DeviceRuntimeMetrics,
} from "../src/device/device-runtime-log.ts";
import {
  completedProviderOutputTranscript,
  completedProviderToolCall,
  parseAvailableProductionGrokProviderEvents,
  parseProductionGrokProviderEvents,
  type CompletedProviderToolCall,
  type ProductionGrokProviderEvent,
} from "../src/device/production-grok-provider-events.ts";
import { writeProductionGrokProviderEventsArtifact } from "../src/device/production-grok-provider-events-artifact.ts";
import {
  parseProductionGrokCliOptions,
  type PttAuthority,
} from "../src/device/production-grok-cli-options.ts";
import type { ProductionDeviceProofProvenance } from "../src/device/production-device-proof.ts";
import { assessPhysicalSpeechTranscription } from "../src/device/physical-speech-transcription.ts";
import { parseKitControlDiagnostics } from "../src/device/kit-control-diagnostics.ts";
import { parseKitPlaybackMetrics } from "../src/device/kit-playback-metrics.ts";
import { MacOsPcm16Capture } from "../src/device/macos-pcm16-capture.ts";
import {
  buildPhysicalNetworkRunArtifact,
  PhysicalNetworkRunMonitor,
  writePhysicalNetworkRunArtifact,
  type PhysicalNetworkMonitorCapture,
} from "../src/device/physical-network-run.ts";
import {
  discoverDarwinDefaultGateway,
  measureRemoteDnsAndTlsConnect,
  type RemoteDnsAndTlsConnectMeasurement,
} from "../src/device/physical-network-reachability.ts";
import { inspectRetainedPcm16Artifact } from "../src/device/retained-pcm16-artifact.ts";
import { assessProductionGrokStartupLatency } from "../src/device/production-grok-startup-latency.ts";
import {
  productionPcmConversationIsIdle,
  productionPcmGenerationProgress,
  waitForProductionPcmConversationIdle,
  waitForProductionPcmMetrics,
} from "../src/device/production-pcm-generation.ts";
import {
  productionGrokTurnRequiresDeviceTool,
  requiredDeviceToolCallsForVoiceProof,
} from "../src/device/production-grok-turn-policy.ts";
import {
  transcribePcm16WithXaiStreamingStt,
  type XaiStreamingSttResult,
} from "../src/device/xai-streaming-stt.ts";
import type {
  KitControlDiagnostics,
  KitPlaybackMetrics,
} from "../src/device/kit-device-contract.ts";
import { kitVoiceWorkerRef } from "../src/userspace/config-worker/app-ref.ts";
import type { DeviceEventSessionMetrics } from "../src/userspace/config-worker/device-events.ts";
import type { DeviceMetricsSessionMetrics } from "../src/userspace/config-worker/device-metrics.ts";
import {
  ITERATE_KIT_PCM_FRAME_BYTES,
  type PcmSessionMetrics,
} from "../src/userspace/config-worker/pcm-proxy.ts";
import {
  KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
  kitDeviceEventStreamPath,
  type ProviderEventStreamMetrics,
} from "../src/userspace/config-worker/provider-event-stream.ts";

const physicalPressTimeoutMs = 5 * 60_000;
const physicalReleaseTimeoutMs = 30_000;
const responseTimeoutMs = 90_000;
const ambientDurationMs = 1_000;
const playbackIncidentFieldNames = [
  "generationFramesFlushed",
  "freshnessFramesDropped",
  "partialPrebufferFramesDropped",
  "underrunFramesFlushed",
  "underrunIncidents",
  "underrunSilenceFramesSubmitted",
  "underrunSilenceFramesCompleted",
  "underrunSilenceFramesRetired",
  "underrunLateFramesDropped",
  "dmaDeadlineMissIncidents",
  "freshnessIncidents",
  "partialPrebufferIncidents",
  "driverQueueOverflowIncidents",
  "driverFailures",
  "driverStopFailures",
  "fatalFramesFlushed",
  "writeBackpressureIncidents",
  "writeBackpressureDestructiveResets",
  "writeBackpressureFramesDropped",
  "invalidFrames",
  "stateErrors",
  "ownerClockRegressions",
] as const satisfies readonly (keyof KitPlaybackMetrics["playback"])[];
const responseAnalysisGuardMs = 400;
const macOsSpeechDrainGuardMs = 1_200;
const provisionalRelativeAmbientMultiplier = 2.5;
const executeFile = promisify(execFile);

interface ProductionPcmMetrics extends PcmSessionMetrics {
  deviceEvents: DeviceEventSessionMetrics;
  deviceMetrics: DeviceMetricsSessionMetrics;
  previousSession?: ProductionPcmMetrics | null;
  providerEvents: ProviderEventStreamMetrics;
  sessionId: string;
  startup?: {
    credentialPrewarmLatencyMs: number | null;
    credentialReadyBeforeConversationMs: number | null;
    deviceUpgradeLatencyMs: number | null;
    firstDevicePcmLatencyMs: number | null;
    firstDevicePcmFromConversationMs: number | null;
    firstProviderPcmLatencyMs: number | null;
    firstProviderPcmFromConversationMs: number | null;
    providerAttachedLatencyMs: number | null;
    providerSessionReadyFromConversationMs: number | null;
    providerSessionReadyLatencyMs: number | null;
    providerWebSocketOpenFromConversationMs: number | null;
  };
}

interface KitVoiceProofWorker {
  pcmMetrics(): Promise<ProductionPcmMetrics | null>;
}

/**
 * Runs the production Grok proof with an explicit PTT authority.
 *
 * Physical remains the default and retains its strict top-button/Button-A
 * provenance gate. `--remote-ptt` is the unattended equivalent: it starts the
 * call and drives both PTT edges through public capabilities which feed the
 * same bounded firmware event dispatcher as the buttons. Both paths still
 * require a real Stick `/pcm` socket, microphone frames, Grok output, exact
 * playback accounting, physical acoustic evidence, and a valid correlated
 * network interval. Remote authority is recorded honestly rather than being
 * presented as proof that a human touched the GPIOs.
 */
export async function proveProductionM5StickS3Grok(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  deviceProvenance?: ProductionDeviceProofProvenance,
) {
  const options = parseProductionGrokCliOptions(args, environment);
  const devicePath = ["kit", options.deviceId] as const;
  const providerEventStreamPath = kitDeviceEventStreamPath(options.deviceId);
  const routerHost = await discoverDarwinDefaultGateway();
  const runName = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const runRoot = join(options.outputDirectory, runName);
  await mkdir(options.outputDirectory, { recursive: true });
  await mkdir(runRoot, { recursive: false });

  using project = await connectItxReady(
    {
      auth: {
        projectId: options.projectId,
        secret: options.projectApiKey,
        type: "project-secret",
      },
      baseUrl: options.baseUrl,
      projectId: options.projectId,
    },
    {
      retryInitialConnection: {
        delayMs: 250,
        onRetry: (retry) => {
          console.warn(
            JSON.stringify({
              code: "production-grok-itx-connect-retry",
              delayMs: retry.delayMs,
              message: retry.error.message,
            }),
          );
        },
      },
    },
  );
  /*
   * connectItxReady's pipelined proxy intentionally types unknown dynamic
   * methods as a generic promise-shaped capability. This installed ref is
   * source-controlled beside the proof, so narrow only that handle to its one
   * public proof method; runtime result validation still happens in the wait
   * predicates below.
   */
  using worker = project.workers.get(kitVoiceWorkerRef) as unknown as KitVoiceProofWorker &
    Disposable;
  const root = project.capabilityHosts.get("/");
  const invoke = async <Value>(path: readonly string[], invokeArgs: unknown[] = []) =>
    (await root.invokeCapability({ args: invokeArgs, path: [...path] })) as Value;
  const readDiagnostics = async (): Promise<KitControlDiagnostics> =>
    parseKitControlDiagnostics(await invoke([...devicePath, "getDiagnostics"]));
  const providerEventStream = project.streams.get(providerEventStreamPath);
  const providerEventStart = await providerEventStream.getEventPage({
    afterOffset: Number.MAX_SAFE_INTEGER,
    eventTypes: [KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE],
    limit: 1,
  });
  let baselineDiagnostics = await readDiagnostics();
  const playbackSamples: KitPlaybackMetrics[] = [];
  const playbackIncidentSamples: KitPlaybackMetrics[] = [];
  let playbackCallbackError: Error | undefined;
  await invoke<void>(
    [...devicePath, "subscribeToPlaybackMetrics"],
    [
      (value: unknown) => {
        try {
          const parsed = parseKitPlaybackMetrics(value);
          const previous = playbackSamples.at(-1);
          /*
           * The one-hertz callback is already bounded on the ESP. On the host
           * we retain only transitions in destructive counters, not every
           * ordinary sample. `producedAtMs` shares the device monotonic clock
           * with network diagnostics, so a failed run can attribute each
           * underrun/reset to its exact Wi-Fi/RTT interval without turning
           * diagnostics into another unbounded streaming queue.
           */
          if (
            previous &&
            playbackIncidentFieldNames.some(
              (name) => parsed.playback[name] !== previous.playback[name],
            )
          ) {
            playbackIncidentSamples.push(parsed);
            if (playbackIncidentSamples.length > 64) playbackIncidentSamples.shift();
          }
          playbackSamples.push(parsed);
          if (playbackSamples.length > 16) playbackSamples.shift();
        } catch (error) {
          playbackCallbackError = new Error("The device sent malformed playback metrics.", {
            cause: error,
          });
        }
      },
    ],
  );
  /*
   * General metrics intentionally compress all destructive speaker outcomes
   * into `playback.flushed`. That is the correct release gate but a poor fault
   * locator. Capture the independent detailed view before media starts so a
   * failed physical run can say whether the loss was a stale frame, an
   * underrun substitution, a generation reset, or an EOS ownership defect.
   * The callback is latest-state only; this bounded host array never adds a
   * queue or history allocation to the device.
   */
  let baselinePlayback = await waitForStablePlayback(playbackSamples, () => playbackCallbackError);

  let capture: MacOsPcm16Capture | undefined;
  let completedCapture: Awaited<ReturnType<MacOsPcm16Capture["stop"]>> | undefined;
  let networkMonitor: PhysicalNetworkRunMonitor | undefined;
  let networkCapture: PhysicalNetworkMonitorCapture | undefined;
  let networkMeasurement: Promise<RemoteDnsAndTlsConnectMeasurement> | undefined;
  let ambientStart: Awaited<ReturnType<MacOsPcm16Capture["inspectProgress"]>> | undefined;
  let ambientEnd: Awaited<ReturnType<MacOsPcm16Capture["inspectProgress"]>> | undefined;
  let responseMarker: Awaited<ReturnType<MacOsPcm16Capture["inspectProgress"]>> | undefined;
  let responseEndMarker: Awaited<ReturnType<MacOsPcm16Capture["inspectProgress"]>> | undefined;
  let firstHeldWorker: ProductionPcmMetrics | undefined;
  let continuingHeldWorker: ProductionPcmMetrics | undefined;
  let baselineWorker: ProductionPcmMetrics | undefined;
  let preflightWorker: ProductionPcmMetrics | undefined;
  let preflightDevice: DeviceRuntimeMetrics | undefined;
  let baselineDevice: DeviceRuntimeMetrics | undefined;
  let idleAfterHangUpWorker: ProductionPcmMetrics | undefined;
  let firstHeldDevice: DeviceRuntimeMetrics | undefined;
  let continuingHeldDevice: DeviceRuntimeMetrics | undefined;
  let terminalWorker: ProductionPcmMetrics | undefined;
  let terminalDevice: DeviceRuntimeMetrics | undefined;
  let terminalDiagnostics: KitControlDiagnostics = baselineDiagnostics;
  let terminalPlayback: KitPlaybackMetrics | undefined;
  let providerEventEvidence: ProductionGrokProviderEvent[] | undefined;
  let providerToolCallEvidence: CompletedProviderToolCall | undefined;
  let acousticProviderOutputTranscript: string | undefined;
  const turnEvidence: Array<Record<string, unknown>> = [];
  let failureWorkerSnapshot: ProductionPcmMetrics | null | undefined;
  let failureDiagnosticsSnapshot: KitControlDiagnostics | undefined;
  let failureProviderEventEvidence: ProductionGrokProviderEvent[] | undefined;
  const failureSnapshotErrors: string[] = [];
  let runFailure: Error | undefined;
  let directRedAcknowledged = false;
  let remoteConversationStarted = false;
  let remoteConversationEnded = false;
  let remotePttStarted = false;
  let remotePttStopped = false;

  try {
    capture = await MacOsPcm16Capture.start({
      identityFfmpegExecutable: options.ffmpegExecutable,
      input: options.acousticInput,
      outputDirectory: runRoot,
      recorderExecutable: options.soxExecutable,
    });
    ambientStart = await capture.inspectProgress();
    await delay(ambientDurationMs);
    ambientEnd = await capture.inspectProgress();

    if (options.pttAuthority === "remote") {
      /*
       * Establish one stable, warm device lane first. `conversation.hangUp`
       * retires only the disposable Grok provider; waiting for `/pcm` to close
       * was the obsolete cold-connect lifecycle and allowed a coincident
       * worker install to add roughly four seconds of TLS/WebSocket work to
       * the following call. The diagnostics baselines are deliberately
       * refreshed after this transition so preflight cleanup cannot be
       * misclassified as media loss during the measured conversation.
       */
      const preflightEnded =
        (await invoke<boolean>([...devicePath, "conversation", "hangUp"])) === true;
      if (!preflightEnded) {
        throw new Error("The device rejected the preflight conversation hang-up transition.");
      }
      preflightWorker = await waitForProductionPcmConversationIdle({
        description: "one stable warm device PCM lane before call start",
        minimumStableMs: 1_000,
        timeoutMs: 15_000,
        worker,
      });
      preflightWorker = await waitForWorkerMetrics(
        worker,
        (metrics) => {
          const device = latestWorkerDeviceMetrics(metrics);
          return (
            productionPcmConversationIsIdle(metrics) &&
            device !== undefined &&
            queuesAreEmpty(device)
          );
        },
        "a current drained device sample on the stable warm PCM lane",
        10_000,
        preflightWorker.sessionId,
      );
      preflightDevice = requireLatestWorkerDeviceMetrics(preflightWorker);
      baselineDiagnostics = await readDiagnostics();
      baselinePlayback = await waitForStablePlayback(playbackSamples, () => playbackCallbackError);
      console.log(`pcm_lane=warm_idle session_id=${preflightWorker.sessionId}`);
      remoteConversationStarted =
        (await invoke<boolean>([...devicePath, "conversation", "start"])) === true;
      if (!remoteConversationStarted) {
        throw new Error("The device rejected the remote conversation start transition.");
      }
      console.log("remote_conversation=started");
    } else {
      console.log(
        'physical_conversation=ARMED action="Press the top Button B once to start the call."',
      );
    }

    const connectedWorker = await waitForWorkerMetrics(
      worker,
      (metrics) => {
        const device = latestWorkerDeviceMetrics(metrics);
        const greetingFrames =
          preflightWorker === undefined
            ? undefined
            : metrics.downlinkFrames - preflightWorker.downlinkFrames;
        return (
          !metrics.closed &&
          !metrics.interrupted &&
          metrics.providerAvailable &&
          metrics.providerSessionReadyAtMs !== null &&
          metrics.initialGreetingRequests === 1 &&
          metrics.providerResponsesCompleted >= 1 &&
          !metrics.providerResponseActive &&
          metrics.downlinkQueuedBytes === 0 &&
          metrics.deviceMetrics.samplesReceived > 0 &&
          device !== undefined &&
          (preflightDevice === undefined ||
            (greetingFrames !== undefined &&
              devicePlaybackResponseCompleted(preflightDevice, device, greetingFrames))) &&
          queuesAreEmpty(device)
        );
      },
      "a connected Grok PCM bridge with userspace device metrics",
      options.pttAuthority === "remote" ? 30_000 : physicalPressTimeoutMs,
      preflightWorker?.sessionId,
    );
    baselineWorker = connectedWorker;
    const connectedDevice = requireLatestWorkerDeviceMetrics(connectedWorker);
    baselineDevice = connectedDevice;
    baselinePlayback = await waitForStablePlayback(playbackSamples, () => playbackCallbackError);
    console.log(
      `pcm_conversation=connected session_id=${connectedWorker.sessionId} ` +
        `device_metric_samples=${connectedWorker.deviceMetrics.samplesReceived} ` +
        `startup=${JSON.stringify(connectedWorker.startup ?? null)}`,
    );

    /*
     * Red is the known pre-tool state. Grok must later select green through
     * the worker-owned `env.ITX` authority; observing the function-call counter
     * and literal device acknowledgement proves this is not merely a spoken
     * claim from the model.
     */
    directRedAcknowledged =
      (await invoke<boolean>([...devicePath, "changeColour"], ["red"])) === true;
    if (!directRedAcknowledged) {
      throw new Error("The mounted device did not acknowledge the red baseline colour.");
    }
    console.log("device_colour=red source=proof-precondition");

    /*
     * Network attribution begins only after the deployed `/pcm` generation is
     * known open and immediately before media admission. Starting this during
     * preflight would classify the deliberately idle socket as a fault;
     * stopping it after `conversation.hangUp` would classify our deliberate
     * teardown as a disconnect. Neither says anything about whether the audio
     * interval was healthy, so both lifecycle boundaries stay outside it.
     */
    networkMonitor = new PhysicalNetworkRunMonitor({
      deviceHost: options.deviceHost,
      diagnostics: readDiagnostics,
      routerHost,
      workerHost: options.workerHost,
    });
    networkMonitor.start();
    networkMeasurement = measureRemoteDnsAndTlsConnect(options.workerHost);
    const configuredPhrase = environment.ITERATE_KIT_VOICE_PHRASE?.trim();

    for (let turn = 1; turn <= options.turns; turn += 1) {
      /*
       * Each turn gets its own baseline while the PCM session id remains
       * fixed. Aggregate accounting can hide an early loss behind a later
       * surplus; a per-turn boundary makes the first divergence terminal and
       * proves that repeated Button-A cycles do not accumulate stale audio.
       */
      const turnBaselineWorker = terminalWorker ?? connectedWorker;
      const turnBaselineDevice = requireLatestWorkerDeviceMetrics(turnBaselineWorker);
      const turnBaselineDiagnostics = turn === 1 ? baselineDiagnostics : await readDiagnostics();
      const turnBaselinePlayback = terminalPlayback ?? baselinePlayback;
      const providerSequenceBaseline = providerEventEvidence?.at(-1)?.sequence ?? 0;
      const requiresDeviceTool = productionGrokTurnRequiresDeviceTool(turn, configuredPhrase);
      const expectedColour = requiresDeviceTool ? "green" : undefined;
      remotePttStarted = false;
      remotePttStopped = false;

      if (options.pttAuthority === "remote") {
        remotePttStarted = (await invoke<boolean>([...devicePath, "pushToTalk", "start"])) === true;
        if (!remotePttStarted) {
          throw new Error(`The device rejected remote push-to-talk start for turn ${turn}.`);
        }
        console.log(`remote_ptt=started turn=${turn}`);
      } else {
        console.log(
          `physical_ptt=ARMED turn=${turn} ` +
            'action="Hold Button A now; keep holding until the Mac says release."',
        );
      }

      const pressed = await waitForWorkerMetrics(
        worker,
        (metrics) =>
          (options.pttAuthority === "remote"
            ? metrics.deviceEvents.remoteStarts > turnBaselineWorker.deviceEvents.remoteStarts &&
              metrics.deviceEvents.physicalStarts === turnBaselineWorker.deviceEvents.physicalStarts
            : metrics.deviceEvents.physicalStarts >
                turnBaselineWorker.deviceEvents.physicalStarts &&
              metrics.deviceEvents.remoteStarts === turnBaselineWorker.deviceEvents.remoteStarts) &&
          metrics.interrupted,
        `${options.pttAuthority} push-to-talk start for deployed turn ${turn}`,
        options.pttAuthority === "remote" ? 10_000 : physicalPressTimeoutMs,
        connectedWorker.sessionId,
      );
      console.log(
        `${options.pttAuthority}_ptt=observed turn=${turn} ` +
          `sequence=${pressed.deviceEvents.lastEvent?.sequence}`,
      );

      const turnFirstHeldWorker = await waitForWorkerMetrics(
        worker,
        (metrics) => {
          const device = latestWorkerDeviceMetrics(metrics);
          return (
            metrics.uplinkFrames > turnBaselineWorker.uplinkFrames &&
            device !== undefined &&
            deviceUplinkStreaming(turnBaselineDevice, device)
          );
        },
        `the first microphone frame for deployed turn ${turn}`,
        10_000,
        connectedWorker.sessionId,
      );
      const turnFirstHeldDevice = requireLatestWorkerDeviceMetrics(turnFirstHeldWorker);
      firstHeldWorker ??= turnFirstHeldWorker;
      firstHeldDevice ??= turnFirstHeldDevice;

      const phrase =
        configuredPhrase && options.turns === 1
          ? configuredPhrase
          : requiresDeviceTool
            ? `Turn ${turn}. Use the change colour tool: ${expectedColour}. ` +
              `Say exactly: The screen is ${expectedColour} and the zebra is awake.` +
              (options.pttAuthority === "physical" ? " Release Button A now." : "")
            : `Turn ${turn}. Reply in one short sentence. ` +
              `Say exactly: The physical device completed voice turn ${turn}.` +
              (options.pttAuthority === "physical" ? " Release Button A now." : "");
      console.log(`voice_prompt=started source=macos-say turn=${turn}`);
      /*
       * Render first, then use the blocking CoreAudio file player. Direct
       * `say <text>` has been observed to exit while several seconds of its
       * synthesizer queue remain audible; that tail both extends PTT and
       * contaminates the Mac-microphone boundary used to prove Stick output.
       * `afplay` owns a finite file and returns only after that file is played,
       * making this unattended physical stimulus deterministic and shorter.
       * Retain the source AIFF beside the raw microphone artifact so a failed
       * oracle can distinguish its stimulus from the device response.
       */
      const promptArtifactPath = join(runRoot, `voice-prompt-turn-${turn}.aiff`);
      await executeFile(options.sayExecutable, ["-o", promptArtifactPath, phrase]);
      await executeFile("/usr/bin/afplay", [promptArtifactPath]);
      /*
       * Leave one bounded hardware/file-buffer guard after the blocking player
       * before marking the capture and releasing PTT. This costs no provider
       * response latency because manual PTT has not committed yet.
       */
      await delay(macOsSpeechDrainGuardMs);
      const turnResponseMarker = await capture.inspectProgress();
      responseMarker ??= turnResponseMarker;
      console.log(`voice_prompt=complete ptt_authority=${options.pttAuthority} turn=${turn}`);

      const turnContinuingHeldWorker = await waitForWorkerMetrics(
        worker,
        (metrics) => {
          const device = latestWorkerDeviceMetrics(metrics);
          return (
            metrics.uplinkFrames > turnFirstHeldWorker.uplinkFrames &&
            device !== undefined &&
            deviceUplinkStreaming(turnFirstHeldDevice, device)
          );
        },
        `continued microphone delivery throughout deployed turn ${turn}`,
        10_000,
        connectedWorker.sessionId,
      );
      const turnContinuingHeldDevice = requireLatestWorkerDeviceMetrics(turnContinuingHeldWorker);
      continuingHeldWorker = turnContinuingHeldWorker;
      continuingHeldDevice = turnContinuingHeldDevice;
      if (options.pttAuthority === "remote") {
        remotePttStopped = (await invoke<boolean>([...devicePath, "pushToTalk", "stop"])) === true;
        if (!remotePttStopped) {
          throw new Error(`The device rejected remote push-to-talk stop for turn ${turn}.`);
        }
        console.log(`remote_ptt=stopped turn=${turn}`);
      }
      await waitForWorkerMetrics(
        worker,
        (metrics) =>
          (options.pttAuthority === "remote"
            ? metrics.deviceEvents.remoteStops > turnBaselineWorker.deviceEvents.remoteStops &&
              metrics.deviceEvents.physicalStops === turnBaselineWorker.deviceEvents.physicalStops
            : metrics.deviceEvents.physicalStops > turnBaselineWorker.deviceEvents.physicalStops &&
              metrics.deviceEvents.remoteStops === turnBaselineWorker.deviceEvents.remoteStops) &&
          !metrics.interrupted,
        `${options.pttAuthority} push-to-talk stop for deployed turn ${turn}`,
        options.pttAuthority === "remote" ? 10_000 : physicalReleaseTimeoutMs,
        connectedWorker.sessionId,
      );
      console.log(`${options.pttAuthority}_ptt=released turn=${turn}`);

      let turnTerminalWorker = await waitForWorkerMetrics(
        worker,
        (metrics) => {
          const device = latestWorkerDeviceMetrics(metrics);
          return (
            device !== undefined &&
            devicePlaybackCompleted(turnBaselineDevice, device) &&
            queuesAreEmpty(device) &&
            metrics.downlinkFrames > turnBaselineWorker.downlinkFrames &&
            (!requiresDeviceTool ||
              metrics.providerFunctionCalls > turnBaselineWorker.providerFunctionCalls) &&
            metrics.providerFunctionCallFailures ===
              turnBaselineWorker.providerFunctionCallFailures &&
            metrics.providerFunctionCallsPending === 0 &&
            metrics.providerResponsesCompleted > turnBaselineWorker.providerResponsesCompleted &&
            !metrics.providerResponseActive &&
            metrics.deviceMetrics.samplesReceived >
              turnBaselineWorker.deviceMetrics.samplesReceived &&
            metrics.deviceMetrics.invalidSamples ===
              turnBaselineWorker.deviceMetrics.invalidSamples &&
            metrics.providerEvents.observedEvents >
              turnBaselineWorker.providerEvents.observedEvents &&
            metrics.providerEvents.appendedEvents === metrics.providerEvents.observedEvents &&
            metrics.providerEvents.appendFailures === 0 &&
            metrics.providerEvents.droppedEvents === 0 &&
            metrics.providerEvents.pendingEvents === 0 &&
            metrics.downlinkPartialBytes === 0 &&
            metrics.downlinkQueuedBytes === 0 &&
            metrics.providerBufferedBytes === 0 &&
            !metrics.closed
          );
        },
        `the Grok response and device playback boundary for turn ${turn}`,
        responseTimeoutMs,
        connectedWorker.sessionId,
      );
      let turnTerminalDevice = requireLatestWorkerDeviceMetrics(turnTerminalWorker);
      const turnTerminalPlayback = await waitForPlaybackObservation(
        playbackSamples,
        turnBaselinePlayback,
        turnTerminalDevice,
        () => playbackCallbackError,
      );
      const providerEvidenceDeadline = performance.now() + 5_000;
      let providerEvidenceFailure: Error | undefined;
      let turnProviderEvents: ProductionGrokProviderEvent[] | undefined;
      let turnProviderTranscript: string | undefined;
      let turnProviderToolCall: CompletedProviderToolCall | undefined;
      while (performance.now() < providerEvidenceDeadline) {
        const candidate = parseProductionGrokProviderEvents(
          await providerEventStream.getEvents({
            afterOffset: providerEventStart.streamMaxOffset,
            eventTypes: [KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE],
            limit: 500,
          }),
          turnTerminalWorker.sessionId,
          options.deviceId,
        );
        const currentTurnEvents = candidate.filter(
          (event) => event.sequence > providerSequenceBaseline,
        );
        try {
          turnProviderTranscript = completedProviderOutputTranscript(currentTurnEvents);
          turnProviderToolCall = requiresDeviceTool
            ? completedProviderToolCall(currentTurnEvents, "changeColour")
            : undefined;
          if (!currentTurnEvents.some((event) => event.providerType === "response.done")) {
            throw new Error(`The provider stream did not retain response.done for turn ${turn}.`);
          }
          if (currentTurnEvents.some((event) => event.providerType === "error")) {
            throw new Error(`The provider stream retained an error event during turn ${turn}.`);
          }
          providerEventEvidence = candidate;
          turnProviderEvents = currentTurnEvents;
          break;
        } catch (error) {
          providerEvidenceFailure = error instanceof Error ? error : new Error(String(error));
          await delay(100);
        }
      }
      if (
        !providerEventEvidence ||
        !turnProviderEvents ||
        !turnProviderTranscript ||
        (requiresDeviceTool && !turnProviderToolCall)
      ) {
        throw (
          providerEvidenceFailure ??
          new Error(`Timed out waiting for Grok provider evidence for turn ${turn}.`)
        );
      }
      const exactProviderEventCount = providerEventEvidence.length;
      turnTerminalWorker = await waitForWorkerMetrics(
        worker,
        (metrics) =>
          metrics.providerEvents.appendedEvents === exactProviderEventCount &&
          metrics.providerEvents.observedEvents === exactProviderEventCount &&
          metrics.providerEvents.appendFailures === 0 &&
          metrics.providerEvents.droppedEvents === 0 &&
          metrics.providerEvents.pendingEvents === 0 &&
          metrics.providerFunctionCallsPending === 0 &&
          !metrics.providerResponseActive &&
          !metrics.closed,
        `the exact provider event journal for turn ${turn}`,
        5_000,
        connectedWorker.sessionId,
      );
      turnTerminalDevice = requireLatestWorkerDeviceMetrics(turnTerminalWorker);
      if (providerEventEvidence.length !== turnTerminalWorker.providerEvents.appendedEvents) {
        throw new Error(
          `The provider stream retained ${providerEventEvidence.length} of ` +
            `${turnTerminalWorker.providerEvents.appendedEvents} appended raw events.`,
        );
      }
      const requiredProviderTypes = [
        "input_audio_buffer.committed",
        "response.output_audio_transcript.done",
        "response.done",
      ];
      if (requiresDeviceTool) {
        requiredProviderTypes.push("response.function_call_arguments.done");
      }
      for (const requiredType of requiredProviderTypes) {
        if (!turnProviderEvents.some((event) => event.providerType === requiredType)) {
          throw new Error(`Turn ${turn} did not retain ${requiredType}.`);
        }
      }
      if (
        requiresDeviceTool &&
        (!turnProviderToolCall ||
          !isRecord(turnProviderToolCall.arguments) ||
          turnProviderToolCall.arguments.colour !== expectedColour ||
          !isRecord(turnProviderToolCall.output) ||
          turnProviderToolCall.output.colour !== expectedColour ||
          turnProviderToolCall.output.ok !== true)
      ) {
        throw new Error(
          `The raw Grok event stream did not prove a successful ${expectedColour} tool result ` +
            `for turn ${turn}.`,
        );
      }
      const turnTerminalDiagnostics = await readDiagnostics();
      const turnDigitalAssessment = assessDigitalRun({
        baselineDevice: turnBaselineDevice,
        baselineDiagnostics: turnBaselineDiagnostics,
        baselineWorker: turnBaselineWorker,
        continuingHeldDevice: turnContinuingHeldDevice,
        continuingHeldWorker: turnContinuingHeldWorker,
        expectedFunctionCalls: requiresDeviceTool ? 1 : 0,
        firstHeldDevice: turnFirstHeldDevice,
        firstHeldWorker: turnFirstHeldWorker,
        pttAuthority: options.pttAuthority,
        terminalDevice: turnTerminalDevice,
        terminalDiagnostics: turnTerminalDiagnostics,
        terminalWorker: turnTerminalWorker,
      });
      if (!turnDigitalAssessment.passed) {
        throw new Error(`Turn ${turn}: ${turnDigitalAssessment.reasons.join("; ")}`);
      }
      if (turn === 1) {
        providerToolCallEvidence = turnProviderToolCall;
        acousticProviderOutputTranscript = turnProviderTranscript;
        await delay(500);
        responseEndMarker = await capture.inspectProgress();
      }
      turnEvidence.push({
        digital: turnDigitalAssessment,
        expectedColour: expectedColour ?? null,
        playback: {
          baseline: turnBaselinePlayback,
          terminal: turnTerminalPlayback,
        },
        provider: {
          eventCount: turnProviderEvents.length,
          outputTranscript: turnProviderTranscript,
          toolCall: turnProviderToolCall,
        },
        turn,
        worker: {
          baseline: turnBaselineWorker,
          terminal: turnTerminalWorker,
        },
      });
      terminalWorker = turnTerminalWorker;
      terminalDevice = turnTerminalDevice;
      terminalPlayback = turnTerminalPlayback;
      terminalDiagnostics = turnTerminalDiagnostics;
      console.log(
        `production_voice_turn=passed turn=${turn} session_id=${turnTerminalWorker.sessionId} ` +
          `colour=${expectedColour ?? "unchanged"}`,
      );
    }

    await delay(500);
    networkCapture = await networkMonitor.capture();
    networkMonitor = undefined;
  } catch (error) {
    runFailure = error instanceof Error ? error : new Error(String(error));
  } finally {
    /*
     * Snapshot every public attribution seam before cleanup emits new device
     * events or closes the socket. This is intentionally best-effort: failure
     * to read one diagnostic must be retained beside the original fault, not
     * replace it or prevent the remaining evidence from being captured.
     */
    if (runFailure !== undefined) {
      try {
        failureWorkerSnapshot = await worker.pcmMetrics();
      } catch (error) {
        failureSnapshotErrors.push(`pcmMetrics: ${errorMessage(error)}`);
      }
      try {
        failureDiagnosticsSnapshot = await readDiagnostics();
      } catch (error) {
        failureSnapshotErrors.push(`deviceDiagnostics: ${errorMessage(error)}`);
      }
      if (baselineWorker !== undefined) {
        try {
          failureProviderEventEvidence = parseAvailableProductionGrokProviderEvents(
            await providerEventStream.getEvents({
              afterOffset: providerEventStart.streamMaxOffset,
              eventTypes: [KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE],
              limit: 500,
            }),
            baselineWorker.sessionId,
            options.deviceId,
          );
        } catch (error) {
          failureSnapshotErrors.push(`providerEventStream: ${errorMessage(error)}`);
        }
      }
    }
    if (options.pttAuthority === "remote" && remotePttStarted && !remotePttStopped) {
      try {
        remotePttStopped = (await invoke<boolean>([...devicePath, "pushToTalk", "stop"])) === true;
        if (!remotePttStopped) {
          runFailure ??= new Error("Cleanup could not release the remotely held PTT state.");
        }
      } catch (error) {
        runFailure ??= new Error("Cleanup could not invoke the remote PTT stop transition.", {
          cause: error,
        });
      }
    }
    /*
     * On failure, retain whatever exact media interval we observed before the
     * cleanup hang-up mutates the PCM socket counters. A failed run must remain
     * attributable; planned teardown must never manufacture its diagnosis.
     */
    if (networkMonitor) {
      try {
        networkCapture = await networkMonitor.capture();
        networkMonitor = undefined;
      } catch (error) {
        runFailure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    if (
      options.pttAuthority === "remote" &&
      remoteConversationStarted &&
      !remoteConversationEnded
    ) {
      try {
        remoteConversationEnded =
          (await invoke<boolean>([...devicePath, "conversation", "hangUp"])) === true;
        if (!remoteConversationEnded) {
          runFailure ??= new Error("Cleanup could not end the remote conversation.");
        } else if (baselineWorker !== undefined) {
          idleAfterHangUpWorker = await waitForProductionPcmConversationIdle({
            description: "the Grok provider to retire while the device PCM lane remains warm",
            expectedSessionId: baselineWorker.sessionId,
            minimumStableMs: 1_000,
            timeoutMs: 15_000,
            worker,
          });
          console.log(
            `remote_conversation=ended pcm_lane=warm_idle ` +
              `session_id=${idleAfterHangUpWorker.sessionId}`,
          );
        }
      } catch (error) {
        runFailure ??= new Error("Cleanup could not invoke the remote conversation hang-up.", {
          cause: error,
        });
      }
    }
    if (capture) {
      try {
        completedCapture = await capture.stop();
      } catch (error) {
        runFailure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  /*
   * Persist raw provider control frames before any acoustic analysis can fail.
   * On an already-failed run the final pre-cleanup stream snapshot is the most
   * complete view; otherwise the accepted terminal snapshot is authoritative.
   * Either way this is one exact PCM session and one device-owned stream.
   */
  const retainedProviderEvents =
    failureProviderEventEvidence && failureProviderEventEvidence.length > 0
      ? failureProviderEventEvidence
      : providerEventEvidence;
  const providerEventsArtifact =
    retainedProviderEvents && retainedProviderEvents.length > 0
      ? await writeProductionGrokProviderEventsArtifact({
          artifactPath: join(runRoot, "provider-events.jsonl"),
          deviceId: options.deviceId,
          events: retainedProviderEvents,
          sensitiveValues: [options.projectApiKey, options.xaiApiKey],
        })
      : undefined;

  let failureNetworkArtifact: ReturnType<typeof buildPhysicalNetworkRunArtifact> | undefined;
  let failureNetworkArtifactPath: string | undefined;
  if (runFailure !== undefined && networkCapture !== undefined) {
    /*
     * A transport failure is exactly when attribution matters most. The old
     * branch wrote the raw probes but skipped the classifier because acoustic
     * completion fields were absent; that left a human to eyeball RSSI and
     * socket counters and could easily turn a bad interval into folklore.
     *
     * Audio remains failed here regardless of the network verdict. A concrete
     * socket/link incident classifies the run `network-invalid`; healthy
     * network evidence classifies it `audio-invalid`; incomplete observations
     * remain `indeterminate`. None of those outcomes can become a pass.
     */
    try {
      const failedGenerationProgress = baselineWorker
        ? productionPcmGenerationProgress({
            baseline: baselineWorker,
            observations: [
              firstHeldWorker,
              continuingHeldWorker,
              terminalWorker,
              failureWorkerSnapshot,
            ],
          })
        : { downlinkFrames: 0, sessionId: "unobserved", uplinkFrames: 0 };
      const attributedNetworkCapture = withRemoteDnsAndConnectMeasurement(
        networkCapture,
        networkMeasurement ? await networkMeasurement : undefined,
      );
      networkCapture = attributedNetworkCapture;
      failureNetworkArtifact = buildPhysicalNetworkRunArtifact({
        ...attributedNetworkCapture,
        audio: {
          failure: runFailure.message,
          passed: false,
        },
        pcmEvidence: {
          kind: "device-observed",
          progress: {
            deviceToWorkerBytes:
              failedGenerationProgress.uplinkFrames * ITERATE_KIT_PCM_FRAME_BYTES,
            workerToDeviceBytes:
              failedGenerationProgress.downlinkFrames * ITERATE_KIT_PCM_FRAME_BYTES,
          },
        },
      });
      failureNetworkArtifactPath = join(runRoot, "network.json");
      await writePhysicalNetworkRunArtifact(failureNetworkArtifactPath, failureNetworkArtifact);
    } catch (error) {
      failureSnapshotErrors.push(`networkArtifact: ${errorMessage(error)}`);
    }
  }

  if (
    !completedCapture ||
    !networkCapture ||
    !ambientStart ||
    !ambientEnd ||
    !responseMarker ||
    !responseEndMarker ||
    !baselineWorker ||
    !baselineDevice ||
    !terminalWorker ||
    !terminalDevice ||
    !providerEventEvidence
  ) {
    const failurePath = join(runRoot, "failure.json");
    await writeExclusiveJson(failurePath, {
      capture: {
        ambientEnd,
        ambientStart,
        completed: completedCapture,
        responseEndMarker,
        responseMarker,
      },
      deviceDiagnostics: failureDiagnosticsSnapshot,
      deviceRoute: {
        deviceId: options.deviceId,
        eventStreamPath: providerEventStreamPath,
        mountPath: devicePath,
      },
      error: serializeError(runFailure ?? new Error("The physical capture did not complete.")),
      lifecycle: {
        directRedAcknowledged,
        remoteConversationEnded,
        remoteConversationStarted,
        remotePttStarted,
        remotePttStopped,
      },
      network: networkCapture,
      networkArtifact:
        failureNetworkArtifact && failureNetworkArtifactPath
          ? {
              artifactPath: failureNetworkArtifactPath,
              classification: failureNetworkArtifact.classification,
              reasons: failureNetworkArtifact.network.reasons,
            }
          : null,
      provenance: deviceProvenance ?? null,
      providerEventsArtifact,
      providerEvents: failureProviderEventEvidence,
      playback: {
        baseline: baselinePlayback,
        incidentsBeforeCleanup: playbackIncidentSamples,
        latestBeforeCleanup: playbackSamples.at(-1) ?? null,
      },
      schemaVersion: 2,
      snapshotErrors: failureSnapshotErrors,
      worker: {
        baseline: baselineWorker,
        latestBeforeCleanup: failureWorkerSnapshot,
      },
    });
    throw new Error(
      `${runFailure?.message ?? "The physical capture did not complete."} Evidence: ${failurePath}`,
    );
  }

  const responseStartSample = Math.min(
    completedCapture.capturedSampleCount - 1,
    responseMarker.capturedSampleCount +
      Math.round((completedCapture.sampleRateHz * responseAnalysisGuardMs) / 1_000),
  );
  const baselineEnergy = await analyzePcm16WindowEnergy({
    artifactPath: completedCapture.artifactPath,
    endSample: ambientEnd.capturedSampleCount,
    sampleRateHz: completedCapture.sampleRateHz,
    startSample: ambientStart.capturedSampleCount,
  });
  const responseEnergy = await analyzePcm16WindowEnergy({
    activeThresholdRms: causalSpeechActiveThreshold(baselineEnergy),
    artifactPath: completedCapture.artifactPath,
    endSample: responseEndMarker.capturedSampleCount,
    sampleRateHz: completedCapture.sampleRateHz,
    startSample: responseStartSample,
  });
  const fixedThresholdAcousticAssessment = assessCausalSpeechEnergy(baselineEnergy, responseEnergy);
  /*
   * Keep the original absolute 120-RMS oracle unchanged as a stricter
   * follow-up gate. The Stick's measured brownout-safe -18 dB codec ceiling
   * can be intelligible below that host-specific floor, so the landing proof
   * additionally measures windows relative to this run's own ambient ceiling
   * and asks a separate xAI STT socket to recognise only the Mac-mic bytes.
   */
  const relativeActiveThresholdRms = Math.max(
    Number.EPSILON,
    baselineEnergy.maximumRms * provisionalRelativeAmbientMultiplier,
  );
  const relativeResponseEnergy = await analyzePcm16WindowEnergy({
    activeThresholdRms: relativeActiveThresholdRms,
    artifactPath: completedCapture.artifactPath,
    endSample: responseEndMarker.capturedSampleCount,
    sampleRateHz: completedCapture.sampleRateHz,
    startSample: responseStartSample,
  });
  const artifactDirectory = dirname(completedCapture.artifactPath);
  const acousticTranscriptionPath = join(artifactDirectory, "acoustic-transcription.json");
  let acousticTranscription: XaiStreamingSttResult | undefined;
  let acousticTranscriptionError: Record<string, unknown> | null = null;
  let providerOutputTranscript: string | undefined;
  let physicalSpeechAssessment: ReturnType<typeof assessPhysicalSpeechTranscription> | undefined;
  try {
    providerOutputTranscript = acousticProviderOutputTranscript;
    if (!providerOutputTranscript) {
      throw new Error("The first production turn retained no acoustic transcript expectation.");
    }
    const pcm = await readFile(completedCapture.artifactPath);
    const responseStartByte = responseStartSample * Int16Array.BYTES_PER_ELEMENT;
    const responseEndByte = responseEndMarker.capturedSampleCount * Int16Array.BYTES_PER_ELEMENT;
    if (responseEndByte > pcm.byteLength || responseStartByte >= responseEndByte) {
      throw new Error("The causal speech interval was outside the retained microphone artifact.");
    }
    acousticTranscription = await transcribePcm16WithXaiStreamingStt({
      apiKey: options.xaiApiKey,
      pcm: pcm.subarray(responseStartByte, responseEndByte),
      sampleRateHz: completedCapture.sampleRateHz,
    });
    physicalSpeechAssessment = assessPhysicalSpeechTranscription({
      baselineMaximumRms: baselineEnergy.maximumRms,
      microphoneTranscript: acousticTranscription.text,
      providerTranscript: providerOutputTranscript,
      responseClippedSampleCount: relativeResponseEnergy.clippedSampleCount,
      responseMaximumRms: relativeResponseEnergy.maximumRms,
      responseRelativeActiveWindowCount: relativeResponseEnergy.activeWindowCount ?? 0,
    });
    if (!physicalSpeechAssessment.passed) {
      runFailure ??= new Error(physicalSpeechAssessment.reasons.join("; "));
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    acousticTranscriptionError = serializeError(failure);
    runFailure ??= failure;
  }
  await writeExclusiveJson(acousticTranscriptionPath, {
    assessment: physicalSpeechAssessment ?? null,
    fixedThresholdAssessment: fixedThresholdAcousticAssessment,
    microphoneStt: acousticTranscription ?? null,
    providerOutputTranscript: providerOutputTranscript ?? null,
    relativeEnergy: {
      analysis: relativeResponseEnergy,
      ambientMultiplier: provisionalRelativeAmbientMultiplier,
      thresholdRms: relativeActiveThresholdRms,
    },
    schemaVersion: 1,
    transcriptionError: acousticTranscriptionError,
  });
  const digitalAssessment = assessDigitalRun({
    baselineDevice,
    baselineDiagnostics,
    baselineWorker,
    continuingHeldDevice,
    continuingHeldWorker,
    expectedFunctionCalls: requiredDeviceToolCallsForVoiceProof(
      options.turns,
      environment.ITERATE_KIT_VOICE_PHRASE,
    ),
    expectedTurns: options.turns,
    firstHeldDevice,
    firstHeldWorker,
    pttAuthority: options.pttAuthority,
    terminalDevice,
    terminalDiagnostics,
    terminalWorker,
  });
  if (!digitalAssessment.passed) {
    runFailure ??= new Error(digitalAssessment.reasons.join("; "));
  }
  const startupLatencyAssessment = assessProductionGrokStartupLatency(baselineWorker.startup ?? {});
  if (!startupLatencyAssessment.passed) {
    runFailure ??= new Error(startupLatencyAssessment.reasons.join("; "));
  }

  const dnsAndConnect = networkMeasurement
    ? await networkMeasurement
    : {
        connect: {
          durationMs: null,
          error: null,
          maximumHealthyDurationMs: 1_000,
          outcome: "not-observed" as const,
        },
        dns: {
          durationMs: null,
          error: null,
          maximumHealthyDurationMs: 500,
          outcome: "not-observed" as const,
        },
      };
  networkCapture = withRemoteDnsAndConnectMeasurement(networkCapture, dnsAndConnect);
  const audioPassed =
    runFailure === undefined &&
    digitalAssessment.passed &&
    physicalSpeechAssessment?.passed === true;
  const networkArtifact = buildPhysicalNetworkRunArtifact({
    ...networkCapture,
    audio: {
      failure: audioPassed ? null : (runFailure?.message ?? "Grok proof failed."),
      passed: audioPassed,
    },
    pcmEvidence: {
      kind: "device-observed",
      progress: {
        deviceToWorkerBytes:
          Math.max(0, terminalWorker.uplinkFrames - baselineWorker.uplinkFrames) *
          ITERATE_KIT_PCM_FRAME_BYTES,
        workerToDeviceBytes:
          Math.max(0, terminalWorker.downlinkFrames - baselineWorker.downlinkFrames) *
          ITERATE_KIT_PCM_FRAME_BYTES,
      },
    },
  });
  const networkArtifactPath = join(artifactDirectory, "network.json");
  await writePhysicalNetworkRunArtifact(networkArtifactPath, networkArtifact);
  const retainedRecording = await inspectRetainedPcm16Artifact({
    artifactPath: completedCapture.artifactPath,
  });
  const passed = audioPassed && networkArtifact.classification === "valid";
  const manifestPath = join(artifactDirectory, "manifest.json");
  await writeExclusiveJson(manifestPath, {
    acoustic: {
      acceptance: {
        assessment: physicalSpeechAssessment ?? null,
        policy:
          "An independent STT match plus causal relative energy is accepted provisionally at " +
          "the measured brownout-safe codec gain. The unchanged fixed 120-RMS gate remains a " +
          "stricter follow-up and is not used to relax transport, frame, reset, or network gates.",
      },
      baseline: baselineEnergy,
      capture: completedCapture,
      fixedThresholdAssessment: fixedThresholdAcousticAssessment,
      markers: {
        ambientEnd,
        ambientStart,
        responseAnalysisGuardMs,
        responseEndMarker,
        responseMarker,
        responseStartSample,
      },
      relativeResponse: {
        analysis: relativeResponseEnergy,
        ambientMultiplier: provisionalRelativeAmbientMultiplier,
        thresholdRms: relativeActiveThresholdRms,
      },
      response: responseEnergy,
      retainedArtifact: retainedRecording,
      transcription: {
        artifactPath: acousticTranscriptionPath,
        error: acousticTranscriptionError,
        microphone: acousticTranscription ?? null,
        provider: providerOutputTranscript ?? null,
      },
    },
    createdAt: new Date().toISOString(),
    device: {
      host: options.deviceHost,
      id: options.deviceId,
      mountPath: devicePath,
    },
    digital: {
      assessment: digitalAssessment,
      device: {
        baseline: baselineDevice,
        continuingHeld: continuingHeldDevice ?? null,
        firstHeld: firstHeldDevice ?? null,
        terminal: terminalDevice,
      },
      diagnostics: {
        baseline: baselineDiagnostics,
        terminal: terminalDiagnostics,
      },
      playback: {
        baseline: baselinePlayback,
        incidents: playbackIncidentSamples,
        terminal: terminalPlayback ?? playbackSamples.at(-1) ?? null,
      },
      turns: turnEvidence,
      worker: {
        baseline: baselineWorker,
        idleAfterHangUp: idleAfterHangUpWorker ?? null,
        continuingHeld: continuingHeldWorker ?? null,
        firstHeld: firstHeldWorker ?? null,
        terminal: terminalWorker,
      },
    },
    callStartup: {
      assessment: startupLatencyAssessment,
      timing: baselineWorker.startup ?? null,
    },
    model: "grok-voice-think-fast-2.0",
    network: {
      artifactPath: networkArtifactPath,
      classification: networkArtifact.classification,
      reasons: networkArtifact.network.reasons,
    },
    passed,
    project: {
      baseUrl: options.baseUrl,
      id: options.projectId,
      slug: options.projectSlug,
      workerHost: options.workerHost,
    },
    provenance: deviceProvenance ?? null,
    providerEventsArtifact,
    providerEvents: {
      events: providerEventEvidence,
      eventType: KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
      streamPath: providerEventStreamPath,
      toolCall: providerToolCallEvidence,
    },
    pttAuthority: {
      conversationEnded: remoteConversationEnded,
      conversationStarted: remoteConversationStarted,
      directRedAcknowledged,
      remoteCallsMadeByRunner: options.pttAuthority === "remote" ? 4 + options.turns * 2 : 0,
      requiredSource: options.pttAuthority,
    },
    schemaVersion: 3,
  });
  return {
    classification: networkArtifact.classification,
    manifestPath,
    networkArtifactPath,
    passed,
    providerEventsArtifactPath: providerEventsArtifact?.path,
    recordingPath: completedCapture.artifactPath,
  };
}

interface DigitalAssessment {
  deltas: Record<string, number>;
  passed: boolean;
  reasons: string[];
}

function assessDigitalRun(input: {
  baselineDevice: DeviceRuntimeMetrics;
  baselineDiagnostics: KitControlDiagnostics;
  baselineWorker: ProductionPcmMetrics;
  continuingHeldDevice?: DeviceRuntimeMetrics;
  continuingHeldWorker?: ProductionPcmMetrics;
  expectedFunctionCalls?: number;
  expectedTurns?: number;
  firstHeldDevice?: DeviceRuntimeMetrics;
  firstHeldWorker?: ProductionPcmMetrics;
  pttAuthority: PttAuthority;
  terminalDevice: DeviceRuntimeMetrics;
  terminalDiagnostics: KitControlDiagnostics;
  terminalWorker: ProductionPcmMetrics;
}): DigitalAssessment {
  const reasons: string[] = [];
  const deltas: Record<string, number> = {};
  const expectedTurns = input.expectedTurns ?? 1;
  const expectedFunctionCalls = input.expectedFunctionCalls ?? expectedTurns;
  const deviceDelta = (name: string) => {
    const value = numeric(input.terminalDevice, name) - numeric(input.baselineDevice, name);
    deltas[name] = value;
    return value;
  };
  const captureFrames = deviceDelta("audio_sent");
  const deviceUplinkFrames = deviceDelta("uplink_sent");
  const deviceDownlinkFrames = deviceDelta("downlink_accepted");
  const submittedFrames = deviceDelta("playback_submitted");
  const completedFrames = deviceDelta("playback_completed");
  const workerUplinkFrames = input.terminalWorker.uplinkFrames - input.baselineWorker.uplinkFrames;
  const workerDownlinkFrames =
    input.terminalWorker.downlinkFrames - input.baselineWorker.downlinkFrames;
  Object.assign(deltas, {
    device_metric_samples:
      input.terminalWorker.deviceMetrics.samplesReceived -
      input.baselineWorker.deviceMetrics.samplesReceived,
    physical_starts:
      input.terminalWorker.deviceEvents.physicalStarts -
      input.baselineWorker.deviceEvents.physicalStarts,
    physical_stops:
      input.terminalWorker.deviceEvents.physicalStops -
      input.baselineWorker.deviceEvents.physicalStops,
    remote_starts:
      input.terminalWorker.deviceEvents.remoteStarts -
      input.baselineWorker.deviceEvents.remoteStarts,
    remote_stops:
      input.terminalWorker.deviceEvents.remoteStops - input.baselineWorker.deviceEvents.remoteStops,
    worker_downlink_frames: workerDownlinkFrames,
    worker_function_call_failures:
      input.terminalWorker.providerFunctionCallFailures -
      input.baselineWorker.providerFunctionCallFailures,
    worker_function_calls:
      input.terminalWorker.providerFunctionCalls - input.baselineWorker.providerFunctionCalls,
    worker_provider_pcm_peak_sample: input.terminalWorker.providerPcmPeakSample,
    worker_provider_pcm_rms_sample: input.terminalWorker.providerPcmRmsSample,
    worker_provider_pcm_samples:
      input.terminalWorker.providerPcmSamples - input.baselineWorker.providerPcmSamples,
    worker_provider_responses_completed:
      input.terminalWorker.providerResponsesCompleted -
      input.baselineWorker.providerResponsesCompleted,
    worker_uplink_frames: workerUplinkFrames,
  });

  if (!input.firstHeldWorker || !input.continuingHeldWorker) {
    reasons.push("The worker did not retain two held-button uplink observations.");
  } else if (
    input.firstHeldWorker.uplinkFrames <= input.baselineWorker.uplinkFrames ||
    input.continuingHeldWorker.uplinkFrames <= input.firstHeldWorker.uplinkFrames
  ) {
    reasons.push("Worker microphone frames did not continue advancing while Button A was held.");
  }
  if (!input.firstHeldDevice || !input.continuingHeldDevice) {
    reasons.push("The device did not retain two held-button uplink observations.");
  } else if (!deviceUplinkStreaming(input.firstHeldDevice, input.continuingHeldDevice)) {
    reasons.push("Device microphone frames did not continue advancing while Button A was held.");
  }
  const expectedPhysicalDelta = input.pttAuthority === "physical" ? expectedTurns : 0;
  const expectedRemoteDelta = input.pttAuthority === "remote" ? expectedTurns : 0;
  for (const [label, actual, expected] of [
    ["physical starts", deltas.physical_starts, expectedPhysicalDelta],
    ["physical stops", deltas.physical_stops, expectedPhysicalDelta],
    ["remote starts", deltas.remote_starts, expectedRemoteDelta],
    ["remote stops", deltas.remote_stops, expectedRemoteDelta],
  ] as const) {
    if (actual !== expected) reasons.push(`${label} delta was ${actual}; expected ${expected}.`);
  }
  if (captureFrames <= 0) reasons.push("No microphone capture frame crossed the device boundary.");
  if (deltas.device_metric_samples <= 0) {
    reasons.push("The userspace worker did not receive a later device metrics callback.");
  }
  if (
    input.terminalWorker.deviceMetrics.latestSample === null ||
    input.terminalWorker.deviceMetrics.invalidSamples !==
      input.baselineWorker.deviceMetrics.invalidSamples
  ) {
    reasons.push("Userspace did not retain a valid latest-only device metrics sample.");
  }
  if (deltas.worker_function_calls !== expectedFunctionCalls) {
    reasons.push(
      `Grok changeColour call delta was ${deltas.worker_function_calls}; ` +
        `expected ${expectedFunctionCalls}.`,
    );
  }
  if (deltas.worker_provider_responses_completed < expectedTurns) {
    reasons.push("Grok did not complete every spoken response.");
  }
  if (
    input.terminalWorker.providerResponseActive ||
    input.terminalWorker.providerFunctionCallsPending !== 0
  ) {
    reasons.push("The proof ended before the final Grok response boundary became quiescent.");
  }
  if (deltas.worker_provider_pcm_samples <= 0 || deltas.worker_provider_pcm_peak_sample <= 0) {
    reasons.push("The userspace bridge observed no non-silent provider PCM source samples.");
  }
  if (deltas.worker_function_call_failures !== 0) {
    reasons.push(
      `Grok device-tool failure delta was ${deltas.worker_function_call_failures}; expected zero.`,
    );
  }
  if (captureFrames !== deviceUplinkFrames || deviceUplinkFrames !== workerUplinkFrames) {
    reasons.push(
      `Uplink conservation failed: capture=${captureFrames}, device=${deviceUplinkFrames}, ` +
        `worker=${workerUplinkFrames}.`,
    );
  }
  if (deviceDownlinkFrames <= 0) reasons.push("No Grok response frame reached the device.");
  if (
    deviceDownlinkFrames !== submittedFrames ||
    submittedFrames !== completedFrames ||
    completedFrames !== workerDownlinkFrames
  ) {
    reasons.push(
      `Downlink conservation failed: worker=${workerDownlinkFrames}, ` +
        `accepted=${deviceDownlinkFrames}, submitted=${submittedFrames}, ` +
        `completed=${completedFrames}.`,
    );
  }
  for (const name of [
    "audio_dropped",
    "audio_failures",
    "uplink_dropped",
    "uplink_failures",
    "uplink_restart_incidents",
    "downlink_dropped",
    "downlink_failures",
    "playback_flushed",
    "playback_failures",
    "protocol_failures",
  ]) {
    const value = deviceDelta(name);
    if (value !== 0) reasons.push(`${name} delta was ${value}; expected zero.`);
  }
  for (const [name, value] of [
    [
      "worker_uplink_dropped_bytes",
      input.terminalWorker.uplinkDroppedBytes - input.baselineWorker.uplinkDroppedBytes,
    ],
    [
      "worker_downlink_dropped_bytes",
      input.terminalWorker.downlinkDroppedBytes - input.baselineWorker.downlinkDroppedBytes,
    ],
  ] as const) {
    deltas[name] = value;
    if (value !== 0) reasons.push(`${name} delta was ${value}; expected zero.`);
  }
  if (!queuesAreEmpty(input.terminalDevice)) {
    reasons.push("Device audio queues were not empty at the terminal sample.");
  }
  if (
    input.terminalWorker.closed ||
    input.terminalWorker.interrupted ||
    input.terminalWorker.downlinkPartialBytes !== 0 ||
    input.terminalWorker.downlinkQueuedBytes !== 0 ||
    input.terminalWorker.providerBufferedBytes !== 0
  ) {
    reasons.push("Userspace PCM state was not open, drained, and non-interrupted at the terminal.");
  }
  if (numeric(input.terminalDevice, "uptime_ms") <= numeric(input.baselineDevice, "uptime_ms")) {
    reasons.push("Device uptime did not advance monotonically across the physical run.");
  }
  for (const [name, baseline, terminal] of [
    [
      "control websocket disconnects",
      input.baselineDiagnostics.control.websocketDisconnects,
      input.terminalDiagnostics.control.websocketDisconnects,
    ],
    [
      "control websocket errors",
      input.baselineDiagnostics.control.websocketErrors,
      input.terminalDiagnostics.control.websocketErrors,
    ],
    [
      "wifi disconnects",
      input.baselineDiagnostics.control.wifiDisconnects,
      input.terminalDiagnostics.control.wifiDisconnects,
    ],
    [
      "pcm websocket disconnects",
      input.baselineDiagnostics.network.pcmWebsocketDisconnects,
      input.terminalDiagnostics.network.pcmWebsocketDisconnects,
    ],
    [
      "pcm websocket errors",
      input.baselineDiagnostics.network.pcmWebsocketErrors,
      input.terminalDiagnostics.network.pcmWebsocketErrors,
    ],
  ] as const) {
    const value = terminal - baseline;
    deltas[name] = value;
    if (value !== 0) reasons.push(`${name} delta was ${value}; expected zero.`);
  }
  return { deltas, passed: reasons.length === 0, reasons };
}

function queuesAreEmpty(metrics: DeviceRuntimeMetrics) {
  return (
    numeric(metrics, "uplink_current") === 0 &&
    numeric(metrics, "downlink_current") === 0 &&
    numeric(metrics, "playback_current") === 0
  );
}

function numeric(metrics: DeviceRuntimeMetrics, name: string) {
  const value = metrics[name];
  return typeof value === "number" ? value : Number.NaN;
}

async function waitForStablePlayback(
  samples: KitPlaybackMetrics[],
  callbackError: () => Error | undefined,
): Promise<KitPlaybackMetrics> {
  return await waitForPlaybackValue(
    "two stable detailed playback samples before media admission",
    samples,
    callbackError,
    (current, previous) =>
      previous !== undefined && samePlaybackBoundary(previous, current) ? current : undefined,
  );
}

async function waitForPlaybackObservation(
  samples: KitPlaybackMetrics[],
  baseline: KitPlaybackMetrics,
  terminalDevice: DeviceRuntimeMetrics,
  callbackError: () => Error | undefined,
): Promise<KitPlaybackMetrics> {
  const accepted = numeric(terminalDevice, "downlink_accepted");
  const submitted = numeric(terminalDevice, "playback_submitted");
  const completed = numeric(terminalDevice, "playback_completed");
  return await waitForPlaybackValue(
    "detailed playback counters covering the terminal device sample",
    samples,
    callbackError,
    (current) =>
      current.sequence > baseline.sequence &&
      current.downlinkAccepted >= accepted &&
      current.playback.submitted >= submitted &&
      current.playback.completed >= completed
        ? current
        : undefined,
  );
}

async function waitForPlaybackValue<Value>(
  description: string,
  samples: KitPlaybackMetrics[],
  callbackError: () => Error | undefined,
  select: (
    current: KitPlaybackMetrics,
    previous: KitPlaybackMetrics | undefined,
  ) => Value | undefined,
): Promise<Value> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const error = callbackError();
    if (error) throw error;
    const current = samples.at(-1);
    if (current !== undefined) {
      const selected = select(current, samples.at(-2));
      if (selected !== undefined) return selected;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function samePlaybackBoundary(left: KitPlaybackMetrics, right: KitPlaybackMetrics): boolean {
  return (
    left.downlinkAccepted === right.downlinkAccepted &&
    left.playback.submitted === right.playback.submitted &&
    left.playback.completed === right.playback.completed &&
    left.playback.endOfStreamMarkersConsumed === right.playback.endOfStreamMarkersConsumed &&
    left.playback.endOfStreamResponses === right.playback.endOfStreamResponses
  );
}

function latestWorkerDeviceMetrics(
  metrics: ProductionPcmMetrics,
): DeviceRuntimeMetrics | undefined {
  const latest = metrics.deviceMetrics.latestSample?.metrics;
  if (latest === undefined) return undefined;
  const observation = parseKitMetricsCallback(latest);
  return observation.kind === "metrics" ? observation.values : undefined;
}

function requireLatestWorkerDeviceMetrics(metrics: ProductionPcmMetrics): DeviceRuntimeMetrics {
  const device = latestWorkerDeviceMetrics(metrics);
  if (device !== undefined) return device;
  throw new Error(
    metrics.deviceMetrics.lastInvalidReason ??
      "The userspace worker did not retain a complete device metrics sample.",
  );
}

async function waitForWorkerMetrics(
  worker: KitVoiceProofWorker,
  predicate: (metrics: ProductionPcmMetrics) => boolean,
  description: string,
  timeoutMs: number,
  expectedSessionId?: string,
) {
  return await waitForProductionPcmMetrics({
    description,
    expectedSessionId,
    predicate,
    timeoutMs,
    worker,
  });
}

async function writeExclusiveJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeError(error: Error): Record<string, unknown> {
  const details: Record<string, unknown> = {
    message: error.message,
    name: error.name,
    stack: error.stack,
  };
  for (const key of [
    "expectedSessionId",
    "lastObservedMetrics",
    "observedMetrics",
    "observedSessionId",
  ]) {
    if (key in error) details[key] = (error as unknown as Record<string, unknown>)[key];
  }
  if (error.cause !== undefined) {
    details.cause =
      error.cause instanceof Error ? serializeError(error.cause) : String(error.cause);
  }
  return details;
}

function withRemoteDnsAndConnectMeasurement(
  capture: PhysicalNetworkMonitorCapture,
  measurement?: RemoteDnsAndTlsConnectMeasurement,
): PhysicalNetworkMonitorCapture {
  /*
   * The classifier requires DNS/TLS coverage to name a remote-worker interval
   * valid. If setup failed before the bounded probe was started, encode that
   * absence explicitly instead of borrowing a later successful lookup or
   * pretending this production route was direct LAN. The exact media interval
   * remains the coverage authority in both success and failure artifacts.
   */
  const observed = measurement ?? {
    connect: {
      durationMs: null,
      error: null,
      maximumHealthyDurationMs: 1_000,
      outcome: "not-observed" as const,
    },
    dns: {
      durationMs: null,
      error: null,
      maximumHealthyDurationMs: 500,
      outcome: "not-observed" as const,
    },
  };
  return {
    ...capture,
    dnsAndConnect: {
      coverage: { ...capture.audioInterval },
      kind: "measured",
      ...observed,
    },
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], "file:"))
) {
  try {
    const result = await proveProductionM5StickS3Grok(process.argv.slice(2), process.env);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, () => {
      process.exit(result.passed ? 0 : 1);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`, () => process.exit(1));
  }
}
