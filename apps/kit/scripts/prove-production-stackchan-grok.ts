import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  parseKitMetricsCallback,
  type DeviceRuntimeMetrics,
} from "../src/device/device-runtime-log.ts";
import { parseKitControlDiagnostics } from "../src/device/kit-control-diagnostics.ts";
import type { KitAecMetrics, KitControlDiagnostics } from "../src/device/kit-device-contract.ts";
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
import { assessPhysicalSpeechTranscription } from "../src/device/physical-speech-transcription.ts";
import {
  completedProviderOutputTranscript,
  parseAvailableProductionGrokProviderEvents,
  parseProductionGrokProviderEvents,
  type ProductionGrokProviderEvent,
} from "../src/device/production-grok-provider-events.ts";
import { writeProductionGrokProviderEventsArtifact } from "../src/device/production-grok-provider-events-artifact.ts";
import { parseProductionGrokCliOptions } from "../src/device/production-grok-cli-options.ts";
import type { ProductionDeviceProofProvenance } from "../src/device/production-device-proof.ts";
import { waitForProductionPcmMetrics } from "../src/device/production-pcm-generation.ts";
import {
  assessStackChanAecRun,
  parseKitAecMetrics,
} from "../src/device/stackchan-aec-assessment.ts";
import { transcribePcm16WithXaiStreamingStt } from "../src/device/xai-streaming-stt.ts";
import { kitVoiceWorkerRef } from "../src/userspace/config-worker/app-ref.ts";
import type { DeviceEventSessionMetrics } from "../src/userspace/config-worker/device-events.ts";
import type { DeviceMetricsSessionMetrics } from "../src/userspace/config-worker/device-metrics.ts";
import {
  ITERATE_KIT_PCM_FRAME_BYTES,
  ITERATE_KIT_PCM_SAMPLE_RATE_HZ,
  type PcmSessionMetrics,
} from "../src/userspace/config-worker/pcm-proxy.ts";
import {
  KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
  kitDeviceEventStreamPath,
  type ProviderEventStreamMetrics,
} from "../src/userspace/config-worker/provider-event-stream.ts";
import { kitDeviceCapabilityPath } from "../src/userspace/config-worker/device-id.ts";

const executeFile = promisify(execFile);
const responseTimeoutMs = 90_000;
const macOutputVolume = 85;
const postPlaybackDrainMs = 1_000;
const promptTailGuardMs = 100;
const ambientDurationMs = 1_000;

export interface ProductionPcmMetrics extends PcmSessionMetrics {
  audioMode: string;
  deviceEvents: DeviceEventSessionMetrics;
  deviceMetrics: DeviceMetricsSessionMetrics;
  deviceId: string;
  deviceEventSubscriptionAttempts: number;
  deviceEventSubscriptionFailures: number;
  providerConnectFailures: number;
  providerEvents: ProviderEventStreamMetrics;
  sessionId: string;
  startup?: Record<string, number | null>;
}

interface KitVoiceProofWorker {
  pcmMetrics(): Promise<ProductionPcmMetrics | null>;
}

interface TimedSample<Value> {
  receivedAtMs: number;
  value: Value;
}

interface ProviderEventStreamReader {
  getEvents(options: {
    afterOffset: number;
    eventTypes: string[];
    limit: number;
  }): Promise<unknown>;
}

/**
 * Proves StackChan without a second observer replacing the dynamic worker.
 *
 * A previous physical probe opened another ITX client merely to inspect
 * `pcmMetrics()`. Dynamic-worker mounting is itself a lifecycle operation, so
 * that innocent-looking observer replaced the incarnation and cleanly FIN'd
 * the exact PCM generation under test. This harness intentionally owns one
 * project connection, one worker handle, one capability root, and one stream
 * handle for its whole lifetime. Every callback, poll, provider-event read,
 * network diagnostic, and cleanup transition goes through those retained
 * handles. The restriction is part of the test contract, not an optimization.
 */
export async function proveProductionStackChanGrok(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  deviceProvenance?: ProductionDeviceProofProvenance,
) {
  const options = parseProductionGrokCliOptions(args, environment);
  const isStackChan = options.deviceId === "stackchan";
  const isHomeAssistantVoicePreviewEdition =
    options.deviceId === "home-assistant-voice-preview-edition";
  if (!isStackChan && !isHomeAssistantVoicePreviewEdition) {
    throw new Error(
      "The full-duplex voice-satellite proof requires StackChan or Home Assistant Voice Preview Edition.",
    );
  }
  if (options.pttAuthority !== "remote") {
    throw new Error("The unattended full-duplex voice-satellite proof requires --remote-ptt.");
  }

  const deviceName = isStackChan ? "StackChan" : "Home Assistant Voice Preview Edition";
  const logPrefix = isStackChan ? "stackchan" : "havpe";
  const requiresLegacyAecView = isStackChan;
  const devicePath = kitDeviceCapabilityPath(options.deviceId);
  const providerEventStreamPath = kitDeviceEventStreamPath(options.deviceId);
  const routerHost = await discoverDarwinDefaultGateway();
  const runName = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const runRoot = join(options.outputDirectory, runName);
  await mkdir(runRoot, { recursive: true });

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
        onRetry: (retry) =>
          console.warn(
            JSON.stringify({
              code: "stackchan-production-itx-connect-retry",
              delayMs: retry.delayMs,
              message: retry.error.message,
            }),
          ),
      },
    },
  );
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

  const aecSamples: Array<TimedSample<KitAecMetrics>> = [];
  let callbackFailure: Error | undefined;
  /*
   * StackChan deliberately budgets two latest-state metric callbacks. The
   * userspace worker must own one general-metrics slot because streaming those
   * metrics through the mounted capability is part of this proof. The harness
   * owns only the second, AEC-specific slot. An earlier version subscribed to
   * both views here, exhausted the device budget, and made the worker retry
   * subscribeToMetrics seven times while audio itself remained healthy.
   */
  if (requiresLegacyAecView) {
    await invoke<void>(
      [...devicePath, "subscribeToAecMetrics"],
      [
        (value: unknown) => {
          try {
            aecSamples.push({ receivedAtMs: Date.now(), value: parseKitAecMetrics(value) });
            if (aecSamples.length > 720) aecSamples.shift();
          } catch (error) {
            callbackFailure = new Error(`${deviceName} AEC callback was malformed.`, {
              cause: error,
            });
          }
        },
      ],
    );
  }

  let capture: MacOsPcm16Capture | undefined;
  let completedCapture: Awaited<ReturnType<MacOsPcm16Capture["stop"]>> | undefined;
  let networkMonitor: PhysicalNetworkRunMonitor | undefined;
  let networkCapture: PhysicalNetworkMonitorCapture | undefined;
  let networkMeasurement: Promise<RemoteDnsAndTlsConnectMeasurement> | undefined;
  let baselineWorker: ProductionPcmMetrics | undefined;
  let mediaBaselineWorker: ProductionPcmMetrics | undefined;
  let terminalWorker: ProductionPcmMetrics | undefined;
  let preflightDiagnostics: KitControlDiagnostics | undefined;
  let baselineDiagnostics: KitControlDiagnostics | undefined;
  let terminalDiagnostics: KitControlDiagnostics | undefined;
  let ambientStart: Awaited<ReturnType<MacOsPcm16Capture["inspectProgress"]>> | undefined;
  let ambientEnd: Awaited<ReturnType<MacOsPcm16Capture["inspectProgress"]>> | undefined;
  let responseStart: Awaited<ReturnType<MacOsPcm16Capture["inspectProgress"]>> | undefined;
  let responseEnd: Awaited<ReturnType<MacOsPcm16Capture["inspectProgress"]>> | undefined;
  let providerEvents: ProductionGrokProviderEvent[] = [];
  let firstResponseTranscript: string | undefined;
  let runFailure: Error | undefined;
  const evidenceAssemblyErrors: Array<{ error: Record<string, unknown>; stage: string }> = [];
  const turnEvidence: Array<Record<string, unknown>> = [];
  let conversationStarted = false;
  let conversationEnded = false;
  let baselineAecIndex = 0;

  try {
    if (requiresLegacyAecView) {
      await waitForCallbackSamples(
        () => callbackFailure,
        () => aecSamples.length >= 1,
        "an initial AEC capability sample",
      );
    }
    const hangUpAcknowledged =
      (await invoke<boolean>([...devicePath, "conversation", "hangUp"])) === true;
    if (!hangUpAcknowledged) throw new Error(`${deviceName} rejected the preflight hang-up.`);
    /*
     * StackChan's conversation intent owns its full-duplex socket; unlike the
     * Stick's warm PTT lane, hang-up deliberately leaves no active `/pcm`
     * generation. Waiting for a warm-idle worker here is therefore a harness
     * bug. Retain the preflight hardware boundary, then create and follow one
     * new generation after conversation.start().
     */
    preflightDiagnostics = await readDiagnostics();
    baselineAecIndex = Math.max(0, aecSamples.length - 1);

    await executeFile("/usr/bin/osascript", ["-e", `set volume output volume ${macOutputVolume}`]);
    capture = await MacOsPcm16Capture.start({
      identityFfmpegExecutable: options.ffmpegExecutable,
      input: options.acousticInput,
      outputDirectory: runRoot,
      recorderExecutable: options.soxExecutable,
    });
    ambientStart = await capture.inspectProgress();
    await delay(ambientDurationMs);
    ambientEnd = await capture.inspectProgress();

    conversationStarted =
      (await invoke<boolean>([...devicePath, "conversation", "start"])) === true;
    if (!conversationStarted) throw new Error(`${deviceName} rejected conversation.start().`);
    console.log(`${logPrefix}_conversation=started authority=remote`);

    baselineWorker = await waitForWorker(
      worker,
      (metrics) =>
        !metrics.closed &&
        metrics.deviceId === options.deviceId &&
        metrics.conversationActive &&
        metrics.audioMode === "full-duplex-aec" &&
        metrics.turnDetection === "server-vad",
      `the newly connected ${deviceName} full-duplex PCM generation`,
      20_000,
    );
    baselineDiagnostics = await readDiagnostics();
    networkMonitor = new PhysicalNetworkRunMonitor({
      deviceHost: options.deviceHost,
      diagnostics: readDiagnostics,
      routerHost,
      workerHost: options.workerHost,
    });
    networkMonitor.start();
    networkMeasurement = measureRemoteDnsAndTlsConnect(options.workerHost);

    const mediaReady = await waitForWorker(
      worker,
      (metrics) =>
        isStackChanReadyAndSilent(metrics, options.deviceId) &&
        metrics.deviceEventSubscriptionAttempts === 1 &&
        metrics.deviceEventSubscriptionFailures === 0 &&
        metrics.deviceMetrics.samplesReceived > 0 &&
        metrics.deviceMetrics.invalidSamples === 0 &&
        metrics.providerEvents.appendFailures === 0 &&
        metrics.providerEvents.droppedEvents === 0 &&
        metrics.providerEvents.pendingEvents === 0,
      `a provider-ready, observably silent ${deviceName} generation`,
      30_000,
      baselineWorker.sessionId,
    );
    console.log(
      `${logPrefix}_media_ready=silent session_id=${mediaReady.sessionId} ` +
        `startup=${JSON.stringify(mediaReady.startup ?? null)}`,
    );
    mediaBaselineWorker = mediaReady;
    let providerSequenceBaseline = await latestProviderSequence(
      providerEventStream,
      providerEventStart.streamMaxOffset,
      mediaReady.sessionId,
      options.deviceId,
    );

    for (let turn = 1; turn <= options.turns; turn += 1) {
      const turnBaseline = terminalWorker ?? mediaReady;
      /*
       * "StackChan" is a product identifier, not a useful acoustic oracle:
       * independent STT repeatedly rendered the same audible compound as
       * Stack Change/StackChamp. Use ordinary words and a slightly longer
       * answer so exact transcript comparison measures the physical path
       * instead of one recognizer's brand-name vocabulary.
       */
      const phrase = `Reply exactly production audio turn ${turn} is clear and audible`;
      const promptPath = join(runRoot, `near-end-turn-${turn}.aiff`);
      await playMacSpeech(options.sayExecutable, promptPath, phrase);
      await delay(promptTailGuardMs);
      const turnResponseStart = await capture.inspectProgress();
      responseStart ??= turnResponseStart;
      const terminal = await waitForWorker(
        worker,
        (metrics) =>
          metrics.providerSpeechStarts > turnBaseline.providerSpeechStarts &&
          metrics.providerSpeechStops > turnBaseline.providerSpeechStops &&
          metrics.playbackInterruptionsCompleted > turnBaseline.playbackInterruptionsCompleted &&
          metrics.providerResponsesCompleted > turnBaseline.providerResponsesCompleted &&
          metrics.downlinkFrames > turnBaseline.downlinkFrames &&
          metrics.devicePcmSamples > turnBaseline.devicePcmSamples &&
          metrics.providerEvents.pendingEvents === 0 &&
          metrics.downlinkQueuedBytes === 0 &&
          !metrics.providerResponseActive &&
          !metrics.playbackInterruptionPending &&
          !metrics.closed,
        `server VAD and audible response for StackChan turn ${turn}`,
        responseTimeoutMs,
        mediaReady.sessionId,
      );
      await delay(postPlaybackDrainMs);
      const turnResponseEnd = await capture.inspectProgress();
      responseEnd ??= turnResponseEnd;
      const currentEvents = await readProviderEvents(
        providerEventStream,
        providerEventStart.streamMaxOffset,
        mediaReady.sessionId,
        options.deviceId,
      );
      const turnEvents = currentEvents.filter((event) => event.sequence > providerSequenceBaseline);
      const transcript = completedProviderOutputTranscript(turnEvents);
      if (!turnEvents.some((event) => event.providerType === "input_audio_buffer.speech_started")) {
        throw new Error(`Turn ${turn} retained no Grok server-VAD speech_started event.`);
      }
      if (!turnEvents.some((event) => event.providerType === "input_audio_buffer.speech_stopped")) {
        throw new Error(`Turn ${turn} retained no Grok server-VAD speech_stopped event.`);
      }
      if (!turnEvents.some((event) => event.providerType === "response.done")) {
        throw new Error(`Turn ${turn} retained no completed Grok response.`);
      }
      if (turnEvents.some((event) => event.providerType === "error")) {
        throw new Error(`Turn ${turn} retained a Grok error event.`);
      }
      firstResponseTranscript ??= transcript;
      providerEvents = currentEvents;
      providerSequenceBaseline = currentEvents.at(-1)?.sequence ?? providerSequenceBaseline;
      turnEvidence.push({
        kind: "normal-server-vad-turn",
        outputTranscript: transcript,
        providerEventCount: turnEvents.length,
        turn,
        workerBaseline: turnBaseline,
        workerTerminal: terminal,
      });
      terminalWorker = terminal;
      console.log(
        `${logPrefix}_turn=${turn} vad=observed response=complete transcript=${transcript}`,
      );
    }

    /*
     * A normal VAD turn does not prove full duplex: the room could simply wait
     * for the speaker to finish. Request a deliberately long response, observe
     * provider PCM entering the physical downlink, then inject another near-end
     * utterance while that exact response is active. The bridge must cancel
     * the old provider generation and synchronously acknowledge StackChan's
     * hardware playback purge before admitting the replacement reply.
     */
    const interruptionBaseline = terminalWorker ?? mediaReady;
    const longPromptPath = join(runRoot, "near-end-barge-in-setup.aiff");
    await playMacSpeech(
      options.sayExecutable,
      longPromptPath,
      "Tell a long story about a blue robot for one minute without asking me a question",
    );
    const activeResponse = await waitForWorker(
      worker,
      (metrics) =>
        metrics.providerSpeechStarts > interruptionBaseline.providerSpeechStarts &&
        metrics.providerSpeechStops > interruptionBaseline.providerSpeechStops &&
        metrics.providerResponseActive &&
        metrics.downlinkFrames > interruptionBaseline.downlinkFrames &&
        !metrics.closed,
      "the long Grok response to become physically active before barge-in",
      responseTimeoutMs,
      mediaReady.sessionId,
    );
    const interruptPromptPath = join(runRoot, "near-end-barge-in.aiff");
    await playMacSpeech(
      options.sayExecutable,
      interruptPromptPath,
      "Stop and reply exactly interruption test complete",
    );
    const interruptedTerminal = await waitForWorker(
      worker,
      (metrics) =>
        isCompletedStackChanInterruption(interruptionBaseline, activeResponse, metrics) &&
        metrics.providerEvents.pendingEvents === 0,
      "a purged long response and completed post-interruption reply",
      responseTimeoutMs,
      mediaReady.sessionId,
    );
    await delay(postPlaybackDrainMs);
    terminalWorker = interruptedTerminal;
    providerEvents = await readProviderEvents(
      providerEventStream,
      providerEventStart.streamMaxOffset,
      mediaReady.sessionId,
      options.deviceId,
    );
    const interruptionEvents = providerEvents.filter(
      (event) => event.sequence > providerSequenceBaseline,
    );
    const interruptionTranscript = completedProviderOutputTranscript(interruptionEvents);
    const responseDoneEvents = interruptionEvents.filter(
      (event) => event.providerType === "response.done",
    );
    if (responseDoneEvents.length < 2) {
      throw new Error("The raw Grok stream retained fewer than two terminal barge-in responses.");
    }
    if (interruptionEvents.some((event) => event.providerType === "error")) {
      throw new Error("The raw Grok stream retained an error during barge-in.");
    }
    if (!interruptionTranscriptRetainsAcceptancePhrase(interruptionTranscript)) {
      throw new Error(
        `The replacement response did not retain the requested interruption phrase: ` +
          `${interruptionTranscript}`,
      );
    }
    turnEvidence.push({
      kind: "full-duplex-barge-in",
      oldResponseCancellationObserved: interruptionEvents.some(providerResponseWasCancelled),
      outputTranscript: interruptionTranscript,
      providerEventCount: interruptionEvents.length,
      workerActiveResponse: activeResponse,
      workerBaseline: interruptionBaseline,
      workerTerminal: interruptedTerminal,
    });
    console.log(`${logPrefix}_barge_in=complete transcript=${interruptionTranscript}`);

    terminalDiagnostics = await readDiagnostics();
    networkCapture = await networkMonitor.capture();
    networkMonitor = undefined;
  } catch (error) {
    runFailure = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (networkMonitor) {
      try {
        networkCapture = await networkMonitor.capture();
      } catch (error) {
        runFailure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    try {
      /*
       * A failed later phase still has a valid earlier turn snapshot. Using
       * nullish assignment here preserved that stale snapshot and concealed
       * the exact provider state at the timeout. Always prefer the newest
       * available snapshot; retain the prior one only if the worker itself is
       * unavailable during teardown.
       */
      terminalWorker = (await worker.pcmMetrics()) ?? terminalWorker;
    } catch {
      // The primary failure plus diagnostics/network evidence remain authoritative.
    }
    try {
      terminalDiagnostics ??= await readDiagnostics();
    } catch {
      // A failed control lane is already represented by interval sampling.
    }
    if (conversationStarted && !conversationEnded) {
      try {
        conversationEnded =
          (await invoke<boolean>([...devicePath, "conversation", "hangUp"])) === true;
      } catch (error) {
          runFailure ??= new Error(`Could not remotely hang up ${deviceName} after the proof.`, {
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

  if (baselineWorker) {
    try {
      /*
       * A successful first turn makes the in-memory array non-empty, but it
       * does not make it terminal. Always refresh after teardown so a later
       * barge-in failure retains the provider edges that actually caused it.
       * The selector protects against an eventually consistent read returning
       * a shorter prefix than the already observed snapshot.
       */
      providerEvents = selectMostCompleteProviderEventSnapshot(
        providerEvents,
        parseAvailableProductionGrokProviderEvents(
          await providerEventStream.getEvents({
            afterOffset: providerEventStart.streamMaxOffset,
            eventTypes: [KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE],
            limit: 500,
          }),
          baselineWorker.sessionId,
          options.deviceId,
        ),
      );
    } catch (error) {
      const evidenceError = error instanceof Error ? error : new Error(String(error));
      evidenceAssemblyErrors.push({
        error: serializeError(evidenceError),
        stage: "recover-provider-events",
      });
      runFailure ??= new Error("Could not recover provider events after the physical failure.", {
        cause: evidenceError,
      });
    }
  }

  const relevantAecSamples = aecSamples.slice(baselineAecIndex).map((sample) => sample.value);
  const aecAssessment = requiresLegacyAecView
    ? assessStackChanAecRun(relevantAecSamples)
    : {
        passed: false,
        reasons: [
          "HAVPE exposes measured raw and post-AEC XMOS taps locally, but its truthful two-tap Cap'n Web schema is not mounted yet.",
        ],
        status: "not-assessed" as const,
      };
  const digitalAssessment =
    baselineWorker &&
    mediaBaselineWorker &&
    terminalWorker &&
    baselineDiagnostics &&
    terminalDiagnostics
      ? assessDigitalStackChanRun({
          baselineDiagnostics,
          mediaBaselineWorker,
          sessionOpenedWorker: baselineWorker,
          terminalDiagnostics,
          terminalWorker,
        })
      : {
          passed: false,
          reasons: ["The run did not retain complete digital boundary evidence."],
        };
  if (requiresLegacyAecView && !aecAssessment.passed) {
    runFailure ??= new Error(aecAssessment.reasons.join("; "));
  }
  if (!digitalAssessment.passed) runFailure ??= new Error(digitalAssessment.reasons.join("; "));

  let physicalSpeechAssessment: ReturnType<typeof assessPhysicalSpeechTranscription> | undefined;
  let acousticEvidence: Record<string, unknown> | undefined;
  if (
    completedCapture &&
    ambientStart &&
    ambientEnd &&
    responseStart &&
    responseEnd &&
    firstResponseTranscript
  ) {
    try {
      const baselineEnergy = await analyzePcm16WindowEnergy({
        artifactPath: completedCapture.artifactPath,
        endSample: ambientEnd.capturedSampleCount,
        sampleRateHz: completedCapture.sampleRateHz,
        startSample: ambientStart.capturedSampleCount,
      });
      const responseEnergy = await analyzePcm16WindowEnergy({
        activeThresholdRms: causalSpeechActiveThreshold(baselineEnergy),
        artifactPath: completedCapture.artifactPath,
        endSample: responseEnd.capturedSampleCount,
        sampleRateHz: completedCapture.sampleRateHz,
        startSample: responseStart.capturedSampleCount,
      });
      const pcm = await readFile(completedCapture.artifactPath);
      const startByte = responseStart.capturedSampleCount * Int16Array.BYTES_PER_ELEMENT;
      const endByte = responseEnd.capturedSampleCount * Int16Array.BYTES_PER_ELEMENT;
      const microphoneStt = await transcribePcm16WithXaiStreamingStt({
        apiKey: options.xaiApiKey,
        pcm: pcm.subarray(startByte, endByte),
        sampleRateHz: completedCapture.sampleRateHz,
      });
      physicalSpeechAssessment = assessPhysicalSpeechTranscription({
        baselineMaximumRms: baselineEnergy.maximumRms,
        microphoneTranscript: microphoneStt.text,
        providerTranscript: firstResponseTranscript,
        responseClippedSampleCount: responseEnergy.clippedSampleCount,
        responseMaximumRms: responseEnergy.maximumRms,
        responseRelativeActiveWindowCount: responseEnergy.activeWindowCount ?? 0,
      });
      acousticEvidence = {
        baselineEnergy,
        causalEnergy: assessCausalSpeechEnergy(baselineEnergy, responseEnergy),
        microphoneStt,
        physicalSpeechAssessment,
        responseEnergy,
      };
      if (!physicalSpeechAssessment.passed) {
        runFailure ??= new Error(physicalSpeechAssessment.reasons.join("; "));
      }
    } catch (error) {
      const evidenceError = error instanceof Error ? error : new Error(String(error));
      evidenceAssemblyErrors.push({
        error: serializeError(evidenceError),
        stage: "assemble-acoustic-evidence",
      });
      runFailure ??= evidenceError;
      acousticEvidence = { error: serializeError(evidenceError) };
    }
  } else {
    runFailure ??= new Error("The run did not retain one complete physical response interval.");
  }

  let providerEventsArtifact:
    | Awaited<ReturnType<typeof writeProductionGrokProviderEventsArtifact>>
    | undefined;
  if (providerEvents.length > 0) {
    try {
      providerEventsArtifact = await writeProductionGrokProviderEventsArtifact({
        artifactPath: join(runRoot, "provider-events.jsonl"),
        deviceId: options.deviceId,
        events: providerEvents,
        sensitiveValues: [options.projectApiKey, options.xaiApiKey],
      });
    } catch (error) {
      const evidenceError = error instanceof Error ? error : new Error(String(error));
      evidenceAssemblyErrors.push({
        error: serializeError(evidenceError),
        stage: "write-provider-events",
      });
      runFailure ??= new Error("Could not persist the raw Grok event stream.", {
        cause: evidenceError,
      });
    }
  }
  let dnsAndConnect: RemoteDnsAndTlsConnectMeasurement | undefined;
  if (networkMeasurement) {
    try {
      dnsAndConnect = await networkMeasurement;
    } catch (error) {
      const evidenceError = error instanceof Error ? error : new Error(String(error));
      evidenceAssemblyErrors.push({
        error: serializeError(evidenceError),
        stage: "measure-remote-dns-and-connect",
      });
      runFailure ??= new Error("Could not finish remote DNS/connect attribution.", {
        cause: evidenceError,
      });
    }
  }
  const attributedNetworkCapture = networkCapture
    ? withRemoteDnsAndConnectMeasurement(networkCapture, dnsAndConnect)
    : undefined;
  const audioPassed =
    runFailure === undefined &&
    (!requiresLegacyAecView || aecAssessment.passed) &&
    digitalAssessment.passed &&
    physicalSpeechAssessment?.passed === true;
  const networkArtifact =
    attributedNetworkCapture && baselineWorker && terminalWorker
      ? buildPhysicalNetworkRunArtifact({
          ...attributedNetworkCapture,
          audio: { failure: runFailure?.message ?? null, passed: audioPassed },
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
        })
      : undefined;
  if (networkArtifact) {
    await writePhysicalNetworkRunArtifact(join(runRoot, "network.json"), networkArtifact);
  }
  const passed = audioPassed && networkArtifact?.classification === "valid";
  if (audioPassed && networkArtifact?.classification !== "valid") {
    runFailure ??= new Error(
      `The audio interval was not network-valid: ${networkArtifact?.classification ?? "missing"}.`,
    );
  }
  const manifestPath = join(runRoot, passed ? "manifest.json" : "failure.json");
  await writeExclusiveJson(manifestPath, {
    acoustic: acousticEvidence ?? null,
    aec: {
      assessment: aecAssessment,
      requiredForThisRun: requiresLegacyAecView,
      samples: aecSamples,
    },
    device: {
      diagnostics: {
        preflight: preflightDiagnostics ?? null,
        baseline: baselineDiagnostics ?? null,
        terminal: terminalDiagnostics ?? null,
      },
      generalMetrics: {
        owner: "userspace-worker",
        mediaBaseline: mediaBaselineWorker?.deviceMetrics ?? null,
        terminal: terminalWorker?.deviceMetrics ?? null,
      },
    },
    digital: digitalAssessment,
    error: runFailure ? serializeError(runFailure) : null,
    evidenceAssemblyErrors,
    lifecycle: { conversationEnded, conversationStarted },
    network: networkArtifact
      ? {
          classification: networkArtifact.classification,
          reasons: networkArtifact.network.reasons,
        }
      : null,
    passed,
    provenance: deviceProvenance ?? null,
    providerEventsArtifact: providerEventsArtifact ?? null,
    schemaVersion: 1,
    turnEvidence,
    worker: {
      sessionOpened: baselineWorker ?? null,
      mediaBaseline: mediaBaselineWorker ?? null,
      terminal: terminalWorker ?? null,
    },
  });

  if (!passed) {
    throw new Error(
      `${runFailure?.message ?? `${deviceName} production proof failed.`} Evidence: ${manifestPath}`,
    );
  }
  return {
    aec: aecAssessment,
    manifestPath,
    networkClassification: networkArtifact.classification,
    passed,
    providerEventsArtifact,
    sessionId: terminalWorker!.sessionId,
  };
}

async function playMacSpeech(sayExecutable: string, artifactPath: string, phrase: string) {
  await executeFile(sayExecutable, ["-o", artifactPath, phrase]);
  await executeFile("/usr/bin/afplay", [artifactPath]);
}

async function waitForCallbackSamples(
  callbackError: () => Error | undefined,
  predicate: () => boolean,
  description: string,
) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const error = callbackError();
    if (error) throw error;
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForWorker(
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

async function readProviderEvents(
  stream: ProviderEventStreamReader,
  afterOffset: number,
  sessionId: string,
  deviceId: string,
) {
  return parseProductionGrokProviderEvents(
    await stream.getEvents({
      afterOffset,
      eventTypes: [KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE],
      limit: 500,
    }),
    sessionId,
    deviceId,
  );
}

async function latestProviderSequence(
  stream: ProviderEventStreamReader,
  afterOffset: number,
  sessionId: string,
  deviceId: string,
) {
  const events = await readProviderEvents(stream, afterOffset, sessionId, deviceId);
  return events.at(-1)?.sequence ?? 0;
}

export function selectMostCompleteProviderEventSnapshot(
  current: ProductionGrokProviderEvent[],
  recovered: ProductionGrokProviderEvent[],
): ProductionGrokProviderEvent[] {
  const currentSequence = current.at(-1)?.sequence ?? 0;
  const recoveredSequence = recovered.at(-1)?.sequence ?? 0;
  return recoveredSequence >= currentSequence ? recovered : current;
}

function providerResponseWasCancelled(event: ProductionGrokProviderEvent) {
  if (event.providerType !== "response.done") return false;
  try {
    const value: unknown = JSON.parse(event.raw);
    if (!isRecord(value) || !isRecord(value.response)) return false;
    return value.response.status === "cancelled";
  } catch {
    return false;
  }
}

/**
 * Identifies the only safe baseline for StackChan's first physical utterance.
 *
 * A ready provider is not sufficient: an old worker configured an automatic
 * greeting, and taking a baseline while that response was queued made the
 * harness confuse assistant speech with the user's first turn. Conversely,
 * waiting for that greeting after the product switched to silent call-open
 * caused a healthy device to time out while it continuously uploaded audio.
 * This predicate therefore joins readiness and silence into one invariant.
 * It deliberately checks counters as well as the instantaneous queue so a
 * greeting that already drained cannot masquerade as an untouched session.
 */
export function isStackChanReadyAndSilent(metrics: ProductionPcmMetrics, expectedDeviceId: string) {
  return (
    !metrics.closed &&
    metrics.deviceId === expectedDeviceId &&
    metrics.conversationActive &&
    metrics.audioMode === "full-duplex-aec" &&
    metrics.turnDetection === "server-vad" &&
    metrics.providerAvailable &&
    metrics.providerSessionReadyAtMs !== null &&
    metrics.initialGreetingRequests === 0 &&
    metrics.providerResponseCreateMessagesSent === 0 &&
    metrics.providerResponsesCompleted === 0 &&
    metrics.providerResponsesCancelled === 0 &&
    metrics.providerResponsesFailed === 0 &&
    metrics.downlinkFrames === 0 &&
    metrics.downlinkQueuedBytes === 0 &&
    !metrics.providerResponseActive &&
    !metrics.playbackInterruptionPending
  );
}

/**
 * Returns loss that cannot be explained by a requested semantic interruption.
 *
 * Both counters are monotonic byte ledgers and the interruption ledger is a
 * strict subset of the total. Returning a negative number intentionally lets
 * the caller reject impossible accounting rather than normalising it away.
 */
export function unexplainedStackChanDownlinkDroppedBytes(
  baseline: ProductionPcmMetrics,
  terminal: ProductionPcmMetrics,
) {
  const totalDropped = terminal.downlinkDroppedBytes - baseline.downlinkDroppedBytes;
  const interruptionDropped = terminal.downlinkInterruptedBytes - baseline.downlinkInterruptedBytes;
  return totalDropped - interruptionDropped;
}

/**
 * Proves the outcome of barge-in without assuming provider generation speed.
 *
 * xAI can finish generating a long response while its PCM is still queued for
 * realtime playback. Near-end speech must purge that obsolete audio in both
 * cases, but `response.cancel` is meaningful only while generation remains
 * active. Therefore the old response may end cancelled or completed; the
 * invariant is two terminal old/replacement outcomes, at least one newly
 * completed response, a completed physical purge, and zero unclassified loss.
 */
export function isCompletedStackChanInterruption(
  baseline: ProductionPcmMetrics,
  activeResponse: ProductionPcmMetrics,
  terminal: ProductionPcmMetrics,
) {
  const completedResponses =
    terminal.providerResponsesCompleted - baseline.providerResponsesCompleted;
  const cancelledResponses =
    terminal.providerResponsesCancelled - baseline.providerResponsesCancelled;
  return (
    terminal.sessionId === baseline.sessionId &&
    terminal.sessionId === activeResponse.sessionId &&
    !terminal.closed &&
    terminal.conversationActive &&
    terminal.providerSpeechStarts > activeResponse.providerSpeechStarts &&
    terminal.providerSpeechStops > activeResponse.providerSpeechStops &&
    terminal.playbackInterruptionsRequested > activeResponse.playbackInterruptionsRequested &&
    terminal.playbackInterruptionsCompleted > activeResponse.playbackInterruptionsCompleted &&
    terminal.playbackInterruptionFailures === baseline.playbackInterruptionFailures &&
    !terminal.playbackInterruptionPending &&
    terminal.downlinkInterruptedBytes > activeResponse.downlinkInterruptedBytes &&
    unexplainedStackChanDownlinkDroppedBytes(baseline, terminal) === 0 &&
    terminal.downlinkFrames > activeResponse.downlinkFrames &&
    terminal.downlinkQueuedBytes === 0 &&
    terminal.providerResponsesFailed === baseline.providerResponsesFailed &&
    !terminal.providerResponseActive &&
    completedResponses >= 1 &&
    completedResponses + cancelledResponses >= 2
  );
}

/**
 * Recognizes the deliberately narrow spoken interruption oracle.
 *
 * Grok's transcript is evidence of an acoustic utterance rather than a source
 * code identifier. Repeated physical runs rendered the product name as
 * "Stack Chan", "Stack channel", and "Stack Shannon". A brand-free phrase
 * removes that provider-dependent ambiguity while remaining distinctive
 * enough to prove that the replacement response, rather than the old queued
 * response, reached the speaker.
 */
export function interruptionTranscriptRetainsAcceptancePhrase(transcript: string) {
  const normalized = transcript
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim();
  return normalized.includes("interruption test complete");
}

export function assessDigitalStackChanRun(input: {
  baselineDiagnostics: KitControlDiagnostics;
  mediaBaselineWorker: ProductionPcmMetrics;
  sessionOpenedWorker: ProductionPcmMetrics;
  terminalDiagnostics: KitControlDiagnostics;
  terminalWorker: ProductionPcmMetrics;
}) {
  const reasons: string[] = [];
  const baseline = latestRuntimeMetrics(input.mediaBaselineWorker, "media baseline", reasons);
  const terminal = latestRuntimeMetrics(input.terminalWorker, "terminal", reasons);
  if (input.terminalWorker.sessionId !== input.sessionOpenedWorker.sessionId) {
    reasons.push("The deployed PCM generation changed during the physical run.");
  }
  if (input.terminalWorker.closed) reasons.push("The deployed PCM generation closed.");
  if (input.terminalWorker.turnDetection !== "server-vad") {
    reasons.push(
      `The userspace worker reported ${input.terminalWorker.turnDetection} turn detection.`,
    );
  }
  if (input.terminalWorker.deviceEventSubscriptionAttempts !== 1) {
    reasons.push(
      `The userspace device subscription needed ` +
        `${input.terminalWorker.deviceEventSubscriptionAttempts} attempts instead of one.`,
    );
  }
  if (input.terminalWorker.deviceEventSubscriptionFailures !== 0) {
    reasons.push(
      `The userspace device subscription failed ` +
        `${input.terminalWorker.deviceEventSubscriptionFailures} times.`,
    );
  }
  if (input.terminalWorker.deviceMetrics.invalidSamples !== 0) {
    reasons.push(
      `Userspace rejected ${input.terminalWorker.deviceMetrics.invalidSamples} device metric samples.`,
    );
  }
  if (
    input.terminalWorker.deviceMetrics.samplesReceived <=
    input.mediaBaselineWorker.deviceMetrics.samplesReceived
  ) {
    reasons.push("The userspace worker did not stream a new device metrics sample during the run.");
  }
  if (input.terminalWorker.uplinkFrames <= input.mediaBaselineWorker.uplinkFrames) {
    reasons.push("No clean StackChan microphone frames reached userspace.");
  }
  if (input.terminalWorker.downlinkFrames <= input.mediaBaselineWorker.downlinkFrames) {
    reasons.push("No Grok PCM frames reached StackChan.");
  }
  for (const field of [
    "uplinkDroppedBytes",
    "uplinkUnavailableFrames",
    "providerSendFailures",
    "providerResponsesFailed",
    "playbackInterruptionFailures",
  ] as const) {
    /*
     * The full-duplex microphone necessarily opens before the provider's TLS
     * handshake completes. Those explicitly unavailable ambient frames are a
     * separately bounded startup outcome below; after Grok has acknowledged
     * the session and the silent generation is media-ready, any further loss
     * is a product defect.
     */
    const value = input.terminalWorker[field] - input.mediaBaselineWorker[field];
    if (value !== 0) reasons.push(`Worker ${field} changed by ${value}.`);
  }
  const unexplainedDownlinkDroppedBytes = unexplainedStackChanDownlinkDroppedBytes(
    input.mediaBaselineWorker,
    input.terminalWorker,
  );
  if (
    !Number.isSafeInteger(unexplainedDownlinkDroppedBytes) ||
    unexplainedDownlinkDroppedBytes < 0
  ) {
    reasons.push(
      `Worker downlink interruption accounting was inconsistent by ` +
        `${unexplainedDownlinkDroppedBytes} bytes.`,
    );
  } else if (unexplainedDownlinkDroppedBytes !== 0) {
    reasons.push(
      `Worker unexplained downlink dropped bytes changed by ${unexplainedDownlinkDroppedBytes}.`,
    );
  }
  if (input.terminalWorker.providerEvents.appendFailures !== 0) {
    reasons.push("The provider-event stream had append failures.");
  }
  if (input.terminalWorker.providerEvents.droppedEvents !== 0) {
    reasons.push("The provider-event stream dropped events.");
  }
  if (input.terminalWorker.providerEvents.pendingEvents !== 0) {
    reasons.push("The provider-event stream was not drained at the evidence boundary.");
  }
  if (baseline !== undefined && terminal !== undefined) {
    for (const field of [
      "audio_failures",
      "uplink_dropped",
      "uplink_failures",
      "uplink_restart_incidents",
      "downlink_dropped",
      "downlink_failures",
      "protocol_failures",
    ]) {
      const value = numeric(terminal, field) - numeric(baseline, field);
      if (value !== 0) reasons.push(`${field} changed by ${value}.`);
    }
  }
  if (
    input.terminalDiagnostics.control.websocketConnections !==
    input.baselineDiagnostics.control.websocketConnections
  ) {
    reasons.push("The Cap'n Web control socket reconnected during the run.");
  }
  if (
    input.terminalDiagnostics.network.pcmWebsocketConnections !==
    input.baselineDiagnostics.network.pcmWebsocketConnections
  ) {
    reasons.push("The PCM socket reconnected during the run.");
  }
  if (
    input.terminalDiagnostics.network.pcmWebsocketDisconnects !==
    input.baselineDiagnostics.network.pcmWebsocketDisconnects
  ) {
    reasons.push("The PCM socket disconnected during the run.");
  }
  /*
   * These worker counters start at zero with the newly observed session id.
   * Convert the provider-ready interval into its maximum possible number of
   * 20 ms firmware frames instead of imposing an unrelated magic frame count.
   * A two-frame scheduling allowance covers the frame already being captured
   * at each edge; every byte must still be exactly and explicitly discarded.
   */
  const startupUnavailableFrames = input.mediaBaselineWorker.uplinkUnavailableFrames;
  const startupDroppedBytes = input.mediaBaselineWorker.uplinkDroppedBytes;
  const providerReadyDurationMs =
    input.mediaBaselineWorker.providerSessionReadyAtMs !== null &&
    input.mediaBaselineWorker.conversationStartedAtMs !== null
      ? input.mediaBaselineWorker.providerSessionReadyAtMs -
        input.mediaBaselineWorker.conversationStartedAtMs
      : null;
  const pcmFrameDurationMs =
    (ITERATE_KIT_PCM_FRAME_BYTES / Int16Array.BYTES_PER_ELEMENT / ITERATE_KIT_PCM_SAMPLE_RATE_HZ) *
    1_000;
  const maximumUnavailableFrames =
    providerReadyDurationMs === null
      ? null
      : Math.ceil(providerReadyDurationMs / pcmFrameDurationMs) + 2;
  const startupBounded =
    providerReadyDurationMs !== null &&
    providerReadyDurationMs >= 0 &&
    providerReadyDurationMs <= 3_000 &&
    maximumUnavailableFrames !== null &&
    startupUnavailableFrames >= 0 &&
    startupUnavailableFrames <= maximumUnavailableFrames &&
    startupDroppedBytes === startupUnavailableFrames * ITERATE_KIT_PCM_FRAME_BYTES;
  if (!startupBounded) {
    reasons.push(
      `Pre-provider startup discarded ${startupUnavailableFrames} frames/${startupDroppedBytes} ` +
        "bytes outside the bounded ambient-only startup policy.",
    );
  }
  return {
    passed: reasons.length === 0,
    reasons,
    progress: {
      devicePcmPeakSample: input.terminalWorker.devicePcmPeakSample,
      devicePcmRmsSample: input.terminalWorker.devicePcmRmsSample,
      downlinkFrames:
        input.terminalWorker.downlinkFrames - input.mediaBaselineWorker.downlinkFrames,
      uplinkFrames: input.terminalWorker.uplinkFrames - input.mediaBaselineWorker.uplinkFrames,
    },
    startup: {
      boundedAmbientDiscard: startupBounded,
      droppedBytes: startupDroppedBytes,
      maximumUnavailableFrames,
      providerReadyDurationMs,
      unavailableFrames: startupUnavailableFrames,
    },
  };
}

function latestRuntimeMetrics(
  metrics: ProductionPcmMetrics,
  boundary: string,
  reasons: string[],
): DeviceRuntimeMetrics | undefined {
  const latest = metrics.deviceMetrics.latestSample?.metrics;
  if (latest === undefined) {
    reasons.push(`The userspace worker retained no StackChan metrics sample at the ${boundary}.`);
    return;
  }
  const parsed = parseKitMetricsCallback(latest);
  if (parsed.kind !== "metrics") {
    reasons.push(
      parsed.kind === "failure"
        ? `The ${boundary} StackChan metrics sample was invalid: ${parsed.reason}`
        : `The ${boundary} StackChan metrics callback returned a device event.`,
    );
    return;
  }
  return parsed.values;
}

function numeric(metrics: DeviceRuntimeMetrics, name: string) {
  const value = metrics[name];
  return typeof value === "number" ? value : Number.NaN;
}

function withRemoteDnsAndConnectMeasurement(
  capture: PhysicalNetworkMonitorCapture,
  measurement?: RemoteDnsAndTlsConnectMeasurement,
): PhysicalNetworkMonitorCapture {
  return {
    ...capture,
    dnsAndConnect: {
      coverage: { ...capture.audioInterval },
      kind: "measured",
      ...(measurement ?? {
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
      }),
    },
  };
}

async function writeExclusiveJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeError(error: Error): Record<string, unknown> {
  return {
    cause: error.cause instanceof Error ? serializeError(error.cause) : error.cause,
    message: error.message,
    name: error.name,
    stack: error.stack,
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], "file:"))
) {
  try {
    const result = await proveProductionStackChanGrok(process.argv.slice(2), process.env);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, () => process.exit(0));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () =>
      process.exit(1),
    );
  }
}
