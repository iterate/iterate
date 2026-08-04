import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  assessAecWaveformRun,
  type AecWaveformStimulusKind,
} from "../src/device/aec-waveform-assessment.ts";
import {
  decodeAecDiagnosticTraceMetadata,
  retrieveAecDiagnosticTrace,
  startAecDiagnosticTrace,
  type AecDiagnosticTraceCapability,
  type AecDiagnosticTraceMetadata,
} from "../src/device/aec-diagnostic-trace.ts";
import {
  loadAecReleaseFixtureBundle,
  type LoadedAecReleaseFixtureBundle,
} from "../src/device/aec-release-fixture-bundle.ts";
import { composeMeasuredAecReleaseCalibration } from "../src/device/aec-release-calibration-acquisition.ts";
import { validateAecReleaseCalibration } from "../src/device/aec-release-calibration.ts";
import { AecReleaseFixtureReplay } from "../src/device/aec-release-fixture-replay.ts";
import {
  aecReleaseTraceOffsets,
  aecReleaseTraceWindowName,
} from "../src/device/aec-release-trace-plan.ts";
import {
  runAecReleaseMatrixController,
  type AecReleaseMatrixAdapter,
} from "../src/device/aec-release-matrix-controller.ts";
import type { AecReleaseFixturePhase } from "../src/device/aec-release-fixture-plan.ts";
import { stackChanMatchedReferenceObserved } from "../src/device/physical-aec-playback-observation.ts";
import { createDualCarrierPrbs31Challenge } from "../src/device/acoustic-prbs31-challenge.ts";
import {
  parseKitMetricsCallback,
  type DeviceRuntimeMetrics,
} from "../src/device/device-runtime-log.ts";
import type {
  KitAecMetrics,
  KitControlDiagnostics,
  KitRawCleanAecMetrics,
  KitSynchronousPlaybackHealthMetrics,
} from "../src/device/kit-device-contract.ts";
import { parseKitControlDiagnostics } from "../src/device/kit-control-diagnostics.ts";
import { parseAecFixtureCliOptions } from "../src/device/aec-fixture-cli-options.ts";
import { aecFixturePcmPolicy } from "../src/device/aec-fixture-pcm-policy.ts";
import {
  aecFixturePcmEvidence,
  openAecFixtureTransport,
  type AecFixtureTransport,
} from "../src/device/aec-fixture-transport.ts";
import { LocalDevicePeerServer } from "../src/device/local-device-peer-server.ts";
import { LocalDevicePeer } from "../src/device/local-device-peer.ts";
import {
  type LocalFetchWebSocketBridgeMetrics,
  type LocalFetchWebSocketBridgeOpenEvent,
} from "../src/device/local-fetch-websocket-server.ts";
import {
  PcmConversationRecorder,
  type PcmConversationMarker,
  type PcmConversationRecordingSummary,
} from "../src/device/pcm-conversation-recorder.ts";
import {
  buildPhysicalNetworkRunArtifact,
  PhysicalNetworkRunMonitor,
  type PhysicalNetworkMonitorCapture,
  writePhysicalNetworkRunArtifact,
} from "../src/device/physical-network-run.ts";
import { discoverDarwinDefaultGateway } from "../src/device/physical-network-reachability.ts";
import { decodeMonoPcm16Wave } from "../src/device/pcm16-wave-file.ts";
import { quietPhysicalAecAcousticProfile } from "../src/device/physical-aec-acoustic-profile.ts";
import { physicalAecResponseRole } from "../src/device/physical-aec-response-plan.ts";
import {
  assessPhysicalAecStartupTransition,
  derivePhysicalAecLifecycleDelta,
} from "../src/device/physical-aec-lifecycle.ts";
import {
  assessStackChanAecRun,
  parseKitAecMetrics,
} from "../src/device/stackchan-aec-assessment.ts";
import { parseKitRawCleanAecMetrics } from "../src/device/voice-pe-aec-assessment.ts";
import { findFirmwareDevice, type FirmwareDevice } from "../src/firmware/catalog.ts";
import {
  decodeDeviceConfiguration,
  encodeDeviceConfiguration,
  type DeviceConfiguration,
} from "../src/firmware/config-image.ts";
import {
  flashFirmwareWithEsptool,
  readFlashRegionWithEsptool,
  runApplicationWithEsptool,
} from "../src/firmware/esptool-cli.ts";
import {
  readLocalEspIdfApplicationProvenance,
  readLocalEspIdfNamedPartition,
} from "../src/firmware/local-idf-build.ts";
import { waitForEspUsbSerialDevice } from "../src/firmware/usb-serial-inventory.ts";
import { kitDeviceCapabilityPath } from "../src/userspace/config-worker/device-id.ts";
import { DeterministicPcmProvider } from "../src/voice/deterministic-pcm-provider.ts";
import {
  createPrbs31Pcm16LeRenderer,
  createSpeechShapedPcm16LeRenderer,
  createTonePcm16LeRenderer,
  renderPcm16Le,
} from "../src/voice/deterministic-pcm-renderers.ts";
import type { DevicePcmSocketClose } from "../src/voice/device-pcm-proxy.ts";

const executeFile = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const sampleRateHz = 16_000;
const frameBytes = 640;
const providerDurationMs = 6_000;
const settledLeadMs = 1_000;
const assessmentIntervalMs = 3_000;
const phaseGuardMs = 1_000;
const mountTimeoutMs = 40_000;
const operationTimeoutMs = 20_000;
const calibrationProviderDurationMs = 5_000;
const calibrationDriveCandidates = Object.freeze([1_500, 3_000, 6_000, 9_000, 12_000]);
const calibrationNearVolumes = Object.freeze([15, 25, 35]);
const calibrationSafetyCeilingAmplitude = calibrationDriveCandidates.at(-1)!;
const nearSpeech = Object.freeze({
  rateWordsPerMinute: 180,
  text:
    "Please verify that this nearby voice remains clear while the device speaker is talking. " +
    "This sentence repeats identically in both comparison phases.",
  voice: "Samantha",
});
const defaultPythonExecutable =
  "/Users/jonastemplestein/.espressif/python_env/idf5.4_py3.14_env/bin/python";

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
  buildDirectory: string;
  id: DeviceKind;
  mountPath: readonly string[];
  stableUsbSerial: string;
}

interface AecDeviceCapability {
  __describe(): Promise<unknown>;
  conversation: {
    hangUp(): Promise<boolean>;
    start(): Promise<boolean>;
  };
  aecTrace: AecDiagnosticTraceCapability;
  getDiagnostics(): Promise<unknown>;
  subscribeToAecMetrics(callback: (value: unknown) => void): Promise<void>;
  subscribeToMetrics(callback: (value: unknown) => void): Promise<void>;
}

interface TimedMetric<Value> {
  phase: string | null;
  receivedAtMonotonicMs: number;
  value: Value;
}

interface RecordedPhase {
  end: PcmConversationMarker;
  start: PcmConversationMarker;
}

interface RetainedTraceArtifact {
  captureCompletedAtMonotonicMs?: number;
  captureStartedAtMonotonicMs?: number;
  fullScaleSamples: Partial<Record<"clean" | "linear" | "near" | "playout" | "reference", number>>;
  metadata: AecDiagnosticTraceMetadata;
  planes: Record<string, { bytes: number; path: string; sha256: string }>;
  scheduledOffsetMs?: number;
}

const definitions: Readonly<Record<DeviceKind, DeviceDefinition>> = {
  stackchan: {
    buildDirectory: resolve(packageDirectory, "../.build/stackchan"),
    id: "stackchan",
    mountPath: kitDeviceCapabilityPath("stackchan"),
    stableUsbSerial: "68:EE:8F:D8:53:20",
  },
  "home-assistant-voice-preview-edition": {
    buildDirectory: resolve(packageDirectory, "../.build/home-assistant-voice-preview-edition"),
    id: "home-assistant-voice-preview-edition",
    mountPath: kitDeviceCapabilityPath("home-assistant-voice-preview-edition"),
    stableUsbSerial: "D8:3B:DA:46:20:34",
  },
};

interface CliOptions {
  buildDirectory: string;
  captunToken?: string;
  deviceHost?: string;
  definition: DeviceDefinition;
  directLanHost?: string;
  directLanPort?: number;
  calibrationOutput?: string;
  fixtureBundle?: string;
  gateway: string;
  outputDirectory: string;
  port?: string;
  pythonExecutable: string;
  tunnelName?: string;
}

export async function proveLocalAec(args: readonly string[], environment = process.env) {
  const options = parseAecPhysicalCliOptions(args, environment);
  /*
   * Resolve the immutable bundle before discovering or mutating USB. A wrong
   * target MAC, stale calibration, tampered manifest, or escaped symlink is a
   * host-input error; it must not temporarily reconfigure a healthy device.
   */
  const releaseBundle = options.fixtureBundle
    ? await loadAecReleaseFixtureBundle({
        bundleDirectory: options.fixtureBundle,
        expectedDeviceId: options.definition.id,
        expectedMac: options.definition.stableUsbSerial,
      })
    : undefined;
  const firmwareDevice = requireFirmwareDevice(options.definition.id);
  const resolveUsbPort = async () =>
    (
      await waitForEspUsbSerialDevice({
        pythonExecutable: options.pythonExecutable,
        stableUsbSerial: options.definition.stableUsbSerial,
      })
    ).port;
  const port = await resolveUsbPort();
  if (options.port && options.port !== port) {
    throw new Error(
      `Requested port ${options.port} does not currently belong to ${options.definition.stableUsbSerial}; resolved ${port}.`,
    );
  }
  const runDirectory = join(
    options.outputDirectory,
    new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"),
  );
  await mkdir(options.outputDirectory, { recursive: true });
  await mkdir(runDirectory, { recursive: false });

  const partition = await readLocalEspIdfNamedPartition({
    buildDirectory: options.buildDirectory,
    device: firmwareDevice,
    partitionLabel: "iterate_kit",
  });
  const firmwareApplication = await readLocalEspIdfApplicationProvenance({
    buildDirectory: options.buildDirectory,
    device: firmwareDevice,
  });
  console.log(
    `aec_proof_start device=${options.definition.id} usb_serial=${options.definition.stableUsbSerial} ` +
      `port=${port} transport=${options.directLanHost ? "direct-lan" : "captun"} ` +
      `evidence=${runDirectory}`,
  );
  const originalConfigurationBytes = await readFlashRegionWithEsptool({
    chipFamily: "ESP32-S3",
    port,
    pythonExecutable: options.pythonExecutable,
    region: partition,
  });
  const originalConfiguration = decodeDeviceConfiguration(originalConfigurationBytes);
  const projectId = `prj_aec_${randomBytes(8).toString("hex")}`;
  const projectSecret = `itxk_aec_${randomBytes(24).toString("base64url")}`;
  const peer = new LocalDevicePeer({
    mountPath: options.definition.mountPath,
    projectId,
    projectSecret,
  });
  /*
   * PRBS challenges are versioned protocol values, not speaker-volume knobs.
   * Keep each challenge exactly as created so its commitment remains valid;
   * the renderer applies the reviewed residential-test attenuation at the
   * output boundary. Mutating carrierAmplitude here previously made phase two
   * throw before response.created, which looked like a device PCM reconnect.
   */
  const prbsFarChallenge = createDualCarrierPrbs31Challenge({ runId: randomUUID() });
  const prbsDoubleTalkChallenge = createDualCarrierPrbs31Challenge({ runId: randomUUID() });
  const prbsOutputGain =
    quietPhysicalAecAcousticProfile.prbsCarrierAmplitude / prbsFarChallenge.carrierAmplitude;
  const releaseReplay = releaseBundle
    ? new AecReleaseFixtureReplay({
        readFarPcm: (phaseId) => releaseBundle.readFarPcm(phaseId),
        sampleRateHz: releaseBundle.plan.sampleRateHz,
      })
    : undefined;
  const provider = new DeterministicPcmProvider({
    chunkBytes: 1_000,
    ...(releaseReplay
      ? {
          createResponse: (responseIndex: number) => releaseReplay.createResponse(responseIndex),
          responseIndexScope: "provider" as const,
        }
      : options.calibrationOutput
        ? {
            createRenderer(responseIndex: number) {
              const amplitude = calibrationDriveCandidates[responseIndex];
              if (amplitude === undefined) {
                throw new Error(`AEC calibration requested unplanned response ${responseIndex}.`);
              }
              return createTonePcm16LeRenderer({
                amplitude,
                frequencyHz: 997,
                sampleRateHz,
              });
            },
            durationMs: calibrationProviderDurationMs,
            responseIndexScope: "provider" as const,
          }
        : {
            createRenderer(responseIndex: number) {
              const role = physicalAecResponseRole(responseIndex);
              switch (role) {
                case "far-tone":
                  return createTonePcm16LeRenderer({
                    amplitude: quietPhysicalAecAcousticProfile.toneAmplitude,
                    frequencyHz: 997,
                    sampleRateHz,
                  });
                case "far-dual-carrier-prbs31":
                  return createPrbs31Pcm16LeRenderer(prbsFarChallenge, {
                    outputGain: prbsOutputGain,
                  });
                case "far-speech-shaped":
                  return createSpeechShapedPcm16LeRenderer({
                    amplitude: quietPhysicalAecAcousticProfile.speechRendererAmplitude,
                    sampleRateHz,
                    seed: 0x5a_17_20_26,
                  });
                case "near-path-pilot":
                case "near-repeat-path-pilot":
                  return createTonePcm16LeRenderer({
                    amplitude: quietPhysicalAecAcousticProfile.matchedPathPilotAmplitude,
                    frequencyHz: 431,
                    sampleRateHz,
                  });
                case "double-talk-dual-carrier-prbs31":
                  return createPrbs31Pcm16LeRenderer(prbsDoubleTalkChallenge, {
                    outputGain: prbsOutputGain,
                  });
              }
            },
            durationMs: providerDurationMs,
          }),
    sampleRateHz,
  });
  const recorder = await PcmConversationRecorder.create({
    frameBytes,
    outputDirectory: join(runDirectory, "pcm"),
    sampleRateHz,
  });
  const pcmReady = Promise.withResolvers<void>();
  let pcmReadyGenerations = 0;
  const bridgeOpenEvents: LocalFetchWebSocketBridgeOpenEvent[] = [];
  const bridgeCloseEvents: Array<{
    closedAtMonotonicMs: number;
    metrics: LocalFetchWebSocketBridgeMetrics;
  }> = [];
  const providerEvents: Array<{ observedAtMonotonicMs: number; raw: string; type: string }> = [];
  const pcmSocketCloseEvents: Array<{
    close: DevicePcmSocketClose;
    expectedByHarness: boolean;
    observedAtMonotonicMs: number;
  }> = [];
  let providerResponseCompletions = 0;
  let microphoneBytes = 0;
  let speakerBytes = 0;
  let speakerFrames = 0;
  let currentPhase: string | null = null;
  let asynchronousFailure: Error | undefined;
  let pcmCloseExpected = false;
  const server = new LocalDevicePeerServer(peer, {
    connectVoiceProvider: () => provider.connect(),
    onDownlinkResponseComplete: () => {
      providerResponseCompletions += 1;
    },
    onPcmFrame: (frame) => {
      recorder.observeFrame(frame);
      if (frame.direction === "microphone-uplink") microphoneBytes += frame.bytes.byteLength;
      else {
        speakerBytes += frame.bytes.byteLength;
        speakerFrames += 1;
      }
    },
    onPcmSessionReady: () => {
      pcmReadyGenerations += 1;
      pcmReady.resolve();
    },
    onVoiceSocketClose: (close) => {
      pcmSocketCloseEvents.push({
        close,
        expectedByHarness: pcmCloseExpected,
        observedAtMonotonicMs: performance.now(),
      });
      /*
       * A bridge-level 4011 only says its counterpart vanished. Retaining the
       * proxy's originating close event distinguishes a provider generator
       * failure from device loss, while failing immediately prevents a later
       * reconnect from making the physical interval appear continuous.
       */
      if (close.classification === "unexpected" && !pcmCloseExpected) {
        asynchronousFailure ??= new Error(
          `PCM ${close.origin} socket closed unexpectedly (${close.code}): ${close.reason || "no reason"}`,
        );
      }
    },
    onVoiceFailure: (reason) => {
      asynchronousFailure ??= new Error(`Local PCM proxy failed: ${reason}`);
    },
    onVoiceProviderEvent: (event) => {
      providerEvents.push({
        observedAtMonotonicMs: performance.now(),
        raw: event.raw,
        type: event.type,
      });
      if (event.type === "error") {
        asynchronousFailure ??= new Error(`Deterministic provider returned ${event.raw}`);
      }
    },
    pcmFrameBytes: frameBytes,
    pcmDeviceClockedInitialBurstFrames: aecFixturePcmPolicy.deviceClockedInitialBurstFrames,
    pcmDownlinkDeliveryMode: aecFixturePcmPolicy.downlinkDeliveryMode,
    pcmInputMode: "server-vad",
    pcmMinimumDownlinkStartupFrames: aecFixturePcmPolicy.minimumDownlinkStartupFrames,
  });
  let fixtureTransport: AecFixtureTransport | undefined;
  let networkMonitor: PhysicalNetworkRunMonitor | undefined;
  let temporaryConfigurationInstalled = false;
  let conversationStarted = false;
  let macOutputVolume: number | undefined;
  let runFailure: unknown;
  let networkCaptureOnFailure: PhysicalNetworkMonitorCapture | undefined;
  let recordingSummary: PcmConversationRecordingSummary | undefined;
  let terminalArtifactsWritten = false;
  const generalMetrics: Array<TimedMetric<DeviceRuntimeMetrics>> = [];
  const stackChanAecMetrics: Array<TimedMetric<KitAecMetrics>> = [];
  const voicePeAecMetrics: Array<TimedMetric<KitRawCleanAecMetrics>> = [];
  let callbackFailure: Error | undefined;

  try {
    fixtureTransport = await openAecFixtureTransport({
      ...(options.directLanHost
        ? {
            directLan: {
              host: options.directLanHost,
              ...(options.directLanPort === undefined ? {} : { port: options.directLanPort }),
            },
          }
        : {}),
      fetch: (request) => server.fetch(request),
      gateway: options.gateway,
      onBridgeClosed: (metrics) => {
        bridgeCloseEvents.push({ closedAtMonotonicMs: performance.now(), metrics });
      },
      onBridgeOpened: (event) => bridgeOpenEvents.push(event),
      token: options.captunToken,
      tunnelName: options.tunnelName,
    });
    console.log(
      `aec_fixture_ready transport=${fixtureTransport.kind} url=${fixtureTransport.baseUrl}`,
    );
    const temporaryConfiguration: DeviceConfiguration = {
      schemaVersion: 1,
      wifi: originalConfiguration.wifi,
      iterate: {
        baseUrl: fixtureTransport.baseUrl,
        pcmBaseUrl: fixtureTransport.baseUrl,
        projectApiKey: projectSecret,
        projectId,
      },
    };
    await flashFirmwareWithEsptool(
      {
        chipFamily: "ESP32-S3",
        eraseAll: false,
        parts: [
          {
            address: partition.offset,
            data: encodeDeviceConfiguration(temporaryConfiguration, partition.size),
            label: "temporary local AEC configuration",
          },
        ],
      },
      { port: await resolveUsbPort(), pythonExecutable: options.pythonExecutable },
    );
    temporaryConfigurationInstalled = true;
    await runApplicationWithEsptool({
      chipFamily: "ESP32-S3",
      port: await resolveUsbPort(),
      pythonExecutable: options.pythonExecutable,
    });

    const mounted = await withTimeout(
      peer.waitForMount(),
      mountTimeoutMs,
      `${options.definition.id} did not mount on the local Cap'n Web peer`,
    );
    /*
     * The local peer predates the second and third hardware profiles and its
     * retained stub is still named M5StickS3. Cap'n Web itself is structural:
     * __describe() below proves this mounted profile advertises AEC metrics
     * before this harness applies the shared device shape. Detailed DMA
     * playback metrics remain Stick-only; these synchronous-codec targets
     * report their truthful playback-health subset inside AEC metrics.
     */
    const device = mounted.device as unknown as AecDeviceCapability;
    const description = await device.__describe();
    await writeJson(join(runDirectory, "capability-description.json"), description);
    const observeCallbackFailure = (label: string, error: unknown) => {
      callbackFailure ??= new Error(`${label} metrics callback was malformed.`, { cause: error });
    };
    await device.subscribeToMetrics((value) => {
      try {
        const observation = parseKitMetricsCallback(value);
        if (observation.kind !== "metrics") {
          throw new Error(observation.kind === "failure" ? observation.reason : "not metrics");
        }
        generalMetrics.push({
          phase: currentPhase,
          receivedAtMonotonicMs: performance.now(),
          value: observation.values,
        });
      } catch (error) {
        observeCallbackFailure("general", error);
      }
    });
    await device.subscribeToAecMetrics((value) => {
      try {
        const timed = {
          phase: currentPhase,
          receivedAtMonotonicMs: performance.now(),
        };
        if (options.definition.id === "stackchan") {
          stackChanAecMetrics.push({ ...timed, value: parseKitAecMetrics(value) });
        } else {
          voicePeAecMetrics.push({ ...timed, value: parseKitRawCleanAecMetrics(value) });
        }
      } catch (error) {
        observeCallbackFailure("AEC", error);
      }
    });
    await waitFor(
      () =>
        generalMetrics.length > 0 &&
        (stackChanAecMetrics.length > 0 || voicePeAecMetrics.length > 0),
      operationTimeoutMs,
      "the first complete device metrics set",
    );
    assertNoAsynchronousFailure(asynchronousFailure, callbackFailure);
    const preconversationGeneral = generalMetrics.at(-1)!.value;
    const preconversationPlaybackHealth =
      options.definition.id === "stackchan"
        ? stackChanAecMetrics.at(-1)!.value
        : voicePeAecMetrics.at(-1)!.value;
    const mediaReadyGeneralTarget = generalMetrics.length + 1;
    const mediaReadyAecTarget =
      options.definition.id === "stackchan"
        ? stackChanAecMetrics.length + 1
        : voicePeAecMetrics.length + 1;

    if (!(await device.conversation.start())) {
      throw new Error(`${options.definition.id} rejected remote conversation.start().`);
    }
    conversationStarted = true;
    await withTimeout(pcmReady.promise, operationTimeoutMs, "the full-duplex PCM socket");
    await waitFor(
      () =>
        generalMetrics.length >= mediaReadyGeneralTarget &&
        (options.definition.id === "stackchan"
          ? stackChanAecMetrics.length
          : voicePeAecMetrics.length) >= mediaReadyAecTarget,
      operationTimeoutMs,
      "post-generation-barrier metrics",
    );
    const baselineGeneral = generalMetrics.at(-1)!.value;
    const baselinePlaybackHealth =
      options.definition.id === "stackchan"
        ? stackChanAecMetrics.at(-1)!.value
        : voicePeAecMetrics.at(-1)!.value;
    /*
     * Conversation start deliberately resets the synchronous playback owner.
     * Start StackChan's health interval at the first post-start callback so
     * startup classification cannot be mistaken for an in-call reset. Keep
     * that baseline sample because every lifetime health check is a delta.
     */
    const stackChanAssessmentStartIndex =
      options.definition.id === "stackchan" ? stackChanAecMetrics.length - 1 : 0;
    const startupLifecycle = assessPhysicalAecStartupTransition({
      afterGeneral: baselineGeneral,
      afterPlayback: baselinePlaybackHealth,
      beforeGeneral: preconversationGeneral,
      beforePlayback: preconversationPlaybackHealth,
    });
    if (!startupLifecycle.passed) {
      throw new Error(`Invalid AEC startup lifecycle: ${startupLifecycle.reasons.join(" ")}`);
    }
    const pcmOpen = bridgeOpenEvents.findLast((event) => event.endpoint === "/pcm");
    const deviceHost = options.deviceHost ?? normalizeSocketHost(pcmOpen?.remoteAddress);
    const routerHost = await discoverDarwinDefaultGateway();
    const workerHost = new URL(fixtureTransport.baseUrl).hostname;
    networkMonitor = new PhysicalNetworkRunMonitor({
      deviceHost,
      diagnostics: async () => parseKitControlDiagnostics(await device.getDiagnostics()),
      routerHost,
      workerHost,
    });
    networkMonitor.start();
    console.log(
      `aec_media_ready device=${deviceHost} router=${routerHost} worker=${workerHost} ` +
        `control=capnweb pcm=full-duplex`,
    );

    if (options.calibrationOutput) {
      const calibrationResult = await runCalibrationAcquisition({
        assertHealthy: () => assertNoAsynchronousFailure(asynchronousFailure, callbackFailure),
        calibrationOutput: options.calibrationOutput,
        bridgeCloseEvents,
        bridgeOpenEvents,
        device,
        deviceId: options.definition.id,
        deviceHost,
        firmwareApplication,
        fixtureTransport,
        generalMetrics,
        getProviderResponseCompletions: () => providerResponseCompletions,
        getPcmProgress: () => ({
          deviceToWorkerBytes: microphoneBytes,
          workerToDeviceBytes: speakerBytes,
        }),
        getSpeakerFrames: () => speakerFrames,
        networkMonitor,
        recorder,
        runDirectory,
        server,
        setConversationStarted: (started) => {
          conversationStarted = started;
        },
        setCurrentPhase: (phase) => {
          currentPhase = phase;
        },
        stackChanAecMetrics,
        voicePeAecMetrics,
      });
      networkMonitor = undefined;
      recordingSummary = calibrationResult.recording;
      terminalArtifactsWritten = true;
      return;
    }

    if (releaseBundle && releaseReplay) {
      const releaseResult = await runReleaseMatrixAcquisition({
        assertHealthy: () => assertNoAsynchronousFailure(asynchronousFailure, callbackFailure),
        bundle: releaseBundle,
        device,
        generalMetrics,
        getPcmReadyGenerations: () => pcmReadyGenerations,
        getProviderResponseCompletions: () => providerResponseCompletions,
        getSpeakerFrames: () => speakerFrames,
        markPcmCloseExpected: (expected) => {
          pcmCloseExpected = expected;
        },
        provider,
        replay: releaseReplay,
        recorder,
        runDirectory,
        server,
        setConversationStarted: (started) => {
          conversationStarted = started;
        },
        setCurrentPhase: (phase) => {
          currentPhase = phase;
        },
      });
      const terminalGeneralTarget = generalMetrics.length + 1;
      await waitFor(
        () => generalMetrics.length >= terminalGeneralTarget,
        operationTimeoutMs,
        "release-matrix terminal metrics",
      );
      const networkCapture = await networkMonitor.capture();
      networkMonitor = undefined;
      pcmCloseExpected = true;
      if (!(await device.conversation.hangUp())) {
        throw new Error(`${options.definition.id} rejected release-matrix conversation.hangUp().`);
      }
      conversationStarted = false;
      await delay(250);
      const recording = await recorder.close();
      recordingSummary = recording;
      const microphonePcm = await readFile(recording.microphone.path);
      const speakerPcm = await readFile(recording.speaker.path);
      const phaseArtifacts: Record<
        string,
        {
          downlink: Awaited<ReturnType<typeof writePcmArtifact>>;
          uplink: Awaited<ReturnType<typeof writePcmArtifact>>;
        }
      > = {};
      for (const [phaseId, markers] of Object.entries(releaseResult.phases)) {
        const phaseDirectory = join(runDirectory, "release-phases", phaseId);
        await mkdir(phaseDirectory, { recursive: true });
        phaseArtifacts[phaseId] = {
          downlink: await writePcmArtifact(
            join(phaseDirectory, "fixture-downlink.pcm16le"),
            sliceMarkerPcmBytes(speakerPcm, markers, "speaker", {
              allowEmpty: phaseId === "ambient-silence",
            }),
          ),
          uplink: await writePcmArtifact(
            join(phaseDirectory, "pcm-uplink.pcm16le"),
            sliceMarkerPcmBytes(microphonePcm, markers, "microphone"),
          ),
        };
      }
      const bridgeEvidence = aecFixturePcmEvidence({
        bridgeCloseEvents,
        bridgeOpenEvents,
        progress: {
          deviceToWorkerBytes: microphoneBytes,
          workerToDeviceBytes: speakerBytes,
        },
        transportKind: fixtureTransport.kind,
      });
      const networkArtifact = buildPhysicalNetworkRunArtifact({
        ...networkCapture,
        /* DSP is deliberately unscored here; this boolean only lets the network classifier speak. */
        audio: { failure: null, passed: true },
        pcmEvidence: bridgeEvidence,
      });
      await Promise.all([
        writeJson(join(runDirectory, "aec-metrics.json"), {
          stackchan: stackChanAecMetrics,
          voicePe: voicePeAecMetrics,
        }),
        writeJson(join(runDirectory, "general-metrics.json"), generalMetrics),
        writeJson(join(runDirectory, "pcm-socket-closes.json"), pcmSocketCloseEvents),
        writeJson(join(runDirectory, "provider-events.json"), providerEvents),
        writeJson(join(runDirectory, "release-phase-markers.json"), releaseResult.phases),
        writeJson(join(runDirectory, "release-traces.json"), releaseResult.traces),
        writeJson(join(runDirectory, "release-phase-artifacts.json"), phaseArtifacts),
        writePhysicalNetworkRunArtifact(
          join(runDirectory, "physical-network-validity.json"),
          networkArtifact,
        ),
        writeJson(join(runDirectory, "manifest.json"), {
          createdAt: new Date().toISOString(),
          device: options.definition.id,
          exactMac: options.definition.stableUsbSerial,
          firmwareApplication,
          fixtureBundle: {
            directory: releaseBundle.directory,
            manifestSha256: releaseBundle.manifestSha256,
            runId: releaseBundle.plan.runId,
          },
          networkClassification: networkArtifact.classification,
          networkVerdict: networkArtifact.network.verdict,
          pcm: {
            microphoneBytes: recording.microphone.bytes,
            microphoneSha256: recording.microphone.sha256,
            speakerBytes: recording.speaker.bytes,
            speakerSha256: recording.speaker.sha256,
          },
          qualification: "acquisition-complete-unscored",
          schemaVersion: 2,
          transport: {
            baseUrl: fixtureTransport.baseUrl,
            deviceHost,
            gateway: options.gateway,
            kind: fixtureTransport.kind,
            tunnelName: options.tunnelName ?? null,
          },
        }),
      ]);
      terminalArtifactsWritten = true;
      console.log(
        `aec_release_acquisition_complete device=${options.definition.id} ` +
          `network=${networkArtifact.classification} phases=${Object.keys(releaseResult.phases).length} ` +
          `qualification=unscored evidence=${runDirectory}`,
      );
      return;
    }

    const nearWavePath = join(runDirectory, "mac-near-source.wav");
    /*
     * XMOS noise suppression quite reasonably removed the old band-limited
     * random fixture, especially after its room level was made quiet. That
     * measured suppression was not evidence that near-end speech survives
     * double-talk. Generate one intelligible phrase once, retain the exact
     * WAVE bytes as evidence, and replay that same file in both phases. This
     * is quieter and more representative than static while preserving the
     * repeatable physical-transfer comparison the oracle needs.
     */
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
    const nearWave = await readFile(nearWavePath);
    const decodedNearWave = decodeMonoPcm16Wave(nearWave);
    if (decodedNearWave.sampleRateHz !== sampleRateHz) {
      throw new Error(
        `macOS say produced ${decodedNearWave.sampleRateHz} Hz instead of ${sampleRateHz} Hz.`,
      );
    }
    const nearPcm = decodedNearWave.pcm;
    const minimumNearBytes = ((settledLeadMs + assessmentIntervalMs) * sampleRateHz * 2) / 1_000;
    if (nearPcm.byteLength < minimumNearBytes) {
      throw new Error("The synthesized near-end phrase does not cover the assessment interval.");
    }
    macOutputVolume = await readMacOutputVolume();
    await setMacOutputVolume(quietPhysicalAecAcousticProfile.macOutputVolumePercent);

    const phases: Record<PhaseName, RecordedPhase | undefined> = {
      ambient: undefined,
      "double-talk": undefined,
      "far-dual-carrier-prbs31": undefined,
      "far-speech-shaped": undefined,
      "far-tone": undefined,
      "near-only": undefined,
      "near-repeat": undefined,
    };
    const diagnosticTraces: Partial<Record<PhaseName, RetainedTraceArtifact>> = {};
    currentPhase = "ambient";
    await delay(phaseGuardMs);
    [phases.ambient, diagnosticTraces.ambient] = await Promise.all([
      recordSettledInterval(recorder, "ambient", assessmentIntervalMs),
      capturePhaseTrace(device.aecTrace, runDirectory, "ambient"),
    ]);
    currentPhase = null;
    const farTone = await runFarOnlyPhase({
      label: "far-tone",
      recorder,
      server,
      speakerFrameCount: () => speakerFrames,
      responseCompletionCount: () => providerResponseCompletions,
      retainTrace: () => capturePhaseTrace(device.aecTrace, runDirectory, "far-tone"),
      setPhase: (phase) => {
        currentPhase = phase;
      },
    });
    phases["far-tone"] = farTone.phase;
    diagnosticTraces["far-tone"] = farTone.trace;
    const farPrbs = await runFarOnlyPhase({
      label: "far-dual-carrier-prbs31",
      recorder,
      server,
      speakerFrameCount: () => speakerFrames,
      responseCompletionCount: () => providerResponseCompletions,
      retainTrace: () =>
        capturePhaseTrace(device.aecTrace, runDirectory, "far-dual-carrier-prbs31"),
      setPhase: (phase) => {
        currentPhase = phase;
      },
    });
    phases["far-dual-carrier-prbs31"] = farPrbs.phase;
    diagnosticTraces["far-dual-carrier-prbs31"] = farPrbs.trace;
    const farSpeech = await runFarOnlyPhase({
      label: "far-speech-shaped",
      recorder,
      server,
      speakerFrameCount: () => speakerFrames,
      responseCompletionCount: () => providerResponseCompletions,
      retainTrace: () => capturePhaseTrace(device.aecTrace, runDirectory, "far-speech-shaped"),
      setPhase: (phase) => {
        currentPhase = phase;
      },
    });
    phases["far-speech-shaped"] = farSpeech.phase;
    diagnosticTraces["far-speech-shaped"] = farSpeech.trace;
    /*
     * XMOS's alternate architecture changes from AEC to IC after three
     * reference-free seconds. The old control phase crossed that boundary,
     * then compared it with AEC-active double-talk as if only echo differed.
     * Stream a -54 dBFS pilot first so both captures traverse the same AEC
     * path. It is far below the physical challenge signals, but above XMOS's
     * documented -60 dBFS reference-active threshold. Device playback metrics
     * below make its physical traversal a required part of acceptance.
     */
    const nearOnly = await runNearControlPhase({
      label: "near-only",
      nearWavePath,
      recorder,
      responseCompletionCount: () => providerResponseCompletions,
      retainTrace: () => capturePhaseTrace(device.aecTrace, runDirectory, "near-only"),
      server,
      setPhase: (phase) => {
        currentPhase = phase;
      },
      speakerFrameCount: () => speakerFrames,
    });
    phases["near-only"] = nearOnly.phase;
    diagnosticTraces["near-only"] = nearOnly.trace;
    /*
     * The second identical physical pass measures what the room, clock drift,
     * and XMOS nonlinear processing do even when no meaningful far-end signal
     * exists. Without it, a strict double-talk residual is indistinguishable
     * from the acoustic oracle's own repeatability floor.
     */
    const nearRepeat = await runNearControlPhase({
      label: "near-repeat",
      nearWavePath,
      recorder,
      responseCompletionCount: () => providerResponseCompletions,
      retainTrace: () => capturePhaseTrace(device.aecTrace, runDirectory, "near-repeat"),
      server,
      setPhase: (phase) => {
        currentPhase = phase;
      },
      speakerFrameCount: () => speakerFrames,
    });
    phases["near-repeat"] = nearRepeat.phase;
    diagnosticTraces["near-repeat"] = nearRepeat.trace;

    currentPhase = "double-talk";
    const doubleTalkSpeakerBaseline = speakerFrames;
    const doubleTalkResponseTarget = providerResponseCompletions + 1;
    if (!(await server.requestVoiceText("AEC double-talk fixture"))) {
      throw new Error("The local PCM bridge rejected the double-talk response request.");
    }
    await waitFor(
      () => speakerFrames > doubleTalkSpeakerBaseline,
      operationTimeoutMs,
      "the first double-talk device-speaker frame",
    );
    const doubleTalkNearPlayback = playFile(nearWavePath);
    await delay(settledLeadMs);
    [phases["double-talk"], diagnosticTraces["double-talk"]] = await Promise.all([
      recordSettledInterval(recorder, "double-talk", assessmentIntervalMs),
      capturePhaseTrace(device.aecTrace, runDirectory, "double-talk"),
    ]);
    await Promise.all([
      withTimeout(doubleTalkNearPlayback, operationTimeoutMs, "double-talk Mac playback"),
      waitFor(
        () => providerResponseCompletions >= doubleTalkResponseTarget,
        operationTimeoutMs,
        "the double-talk provider response to drain",
      ),
    ]);
    await delay(phaseGuardMs);
    currentPhase = null;
    assertNoAsynchronousFailure(asynchronousFailure, callbackFailure);
    const terminalGeneralTarget = generalMetrics.length + 1;
    const terminalAecTarget =
      options.definition.id === "stackchan"
        ? stackChanAecMetrics.length + 1
        : voicePeAecMetrics.length + 1;
    await waitFor(
      () =>
        generalMetrics.length >= terminalGeneralTarget &&
        (options.definition.id === "stackchan"
          ? stackChanAecMetrics.length
          : voicePeAecMetrics.length) >= terminalAecTarget,
      operationTimeoutMs,
      "terminal metrics",
    );
    const terminalGeneral = generalMetrics.at(-1)!.value;
    const terminalPlaybackHealth =
      options.definition.id === "stackchan"
        ? stackChanAecMetrics.at(-1)!.value
        : voicePeAecMetrics.at(-1)!.value;
    const stackChanAssessmentSamples = stackChanAecMetrics
      .slice(stackChanAssessmentStartIndex)
      .map((sample) => sample.value);
    const networkCapture = await networkMonitor.capture();
    networkMonitor = undefined;
    const bridgeEvidence = {
      bridgeEvidence: {
        closeEvents: bridgeCloseEvents,
        historyTruncated: false,
        openEvents: bridgeOpenEvents,
      },
      kind: "local-bridge" as const,
      progress: {
        deviceToWorkerBytes: microphoneBytes,
        workerToDeviceBytes: speakerBytes,
      },
    };
    const preliminaryNetwork = buildPhysicalNetworkRunArtifact({
      ...networkCapture,
      audio: { failure: null, passed: true },
      pcmEvidence: bridgeEvidence,
    });

    pcmCloseExpected = true;
    if (!(await device.conversation.hangUp())) {
      throw new Error(`${options.definition.id} rejected remote conversation.hangUp().`);
    }
    conversationStarted = false;
    await delay(250);
    const recording = await recorder.close();
    recordingSummary = recording;
    const microphonePcm = await readFile(recording.microphone.path);
    const speakerPcm = await readFile(recording.speaker.path);
    const requirePhase = (name: PhaseName) => {
      const phase = phases[name];
      if (!phase) throw new Error(`AEC phase ${name} did not retain its media boundaries.`);
      return phase;
    };
    for (const name of Object.keys(phases) as PhaseName[]) {
      const trace = diagnosticTraces[name];
      if (!trace) throw new Error(`AEC phase ${name} did not retain its device trace.`);
      const phase = requirePhase(name);
      const traceDirectory = join(runDirectory, "aec-traces", name);
      trace.planes.fixtureDownlink = await writePcmArtifact(
        join(traceDirectory, "fixture-downlink.pcm16le"),
        sliceMarkerPcm(
          speakerPcm,
          phase,
          "speaker",
          name === "ambient" ? { allowEmpty: true } : undefined,
        ),
      );
      trace.planes.pcmUplink = await writePcmArtifact(
        join(traceDirectory, "pcm-uplink.pcm16le"),
        sliceMarkerPcm(microphonePcm, phase, "microphone"),
      );
    }
    const farPhase = (name: PhaseName, kind: AecWaveformStimulusKind) => {
      const phase = requirePhase(name);
      return {
        clean: sliceMarkerPcm(microphonePcm, phase, "microphone"),
        kind,
        playbackObserved: phasePlaybackObserved(
          options.definition.id,
          name,
          stackChanAecMetrics,
          voicePeAecMetrics,
        ),
        source: sliceMarkerPcm(speakerPcm, phase, "speaker"),
      };
    };
    const nearPhase = requirePhase("near-only");
    const nearRepeatPhase = requirePhase("near-repeat");
    const doubleTalkPhase = requirePhase("double-talk");
    const nearSource = decodePcm16Le(
      nearPcm.subarray(
        (settledLeadMs * sampleRateHz * 2) / 1_000,
        ((settledLeadMs + assessmentIntervalMs) * sampleRateHz * 2) / 1_000,
      ),
    );
    const transportValidity = deriveTransportValidity({
      baselineGeneral,
      baselinePlaybackHealth,
      diagnostics: networkCapture.diagnostics,
      recordingComplete: recording.complete,
      terminalGeneral,
      terminalPlaybackHealth,
    });
    transportValidity.networkValid = preliminaryNetwork.network.verdict === "valid";
    const assessment = assessAecWaveformRun({
      ambient: sliceMarkerPcm(microphonePcm, requirePhase("ambient"), "microphone"),
      doubleTalk: {
        clean: sliceMarkerPcm(microphonePcm, doubleTalkPhase, "microphone"),
        farSource: sliceMarkerPcm(speakerPcm, doubleTalkPhase, "speaker"),
        nearOnlyClean: sliceMarkerPcm(microphonePcm, nearPhase, "microphone"),
        nearSource,
        playbackObserved: phasePlaybackObserved(
          options.definition.id,
          "double-talk",
          stackChanAecMetrics,
          voicePeAecMetrics,
        ),
      },
      farEndOnly: [
        farPhase("far-tone", "tone"),
        farPhase("far-dual-carrier-prbs31", "dual-carrier-prbs31"),
        farPhase("far-speech-shaped", "speech-shaped"),
      ],
      nearEndOnly: {
        clean: sliceMarkerPcm(microphonePcm, nearPhase, "microphone"),
        pathReferenceObserved: phasePlaybackObserved(
          options.definition.id,
          "near-only",
          stackChanAecMetrics,
          voicePeAecMetrics,
        ),
        source: nearSource,
      },
      nearEndRepeat: {
        clean: sliceMarkerPcm(microphonePcm, nearRepeatPhase, "microphone"),
        pathReferenceObserved: phasePlaybackObserved(
          options.definition.id,
          "near-repeat",
          stackChanAecMetrics,
          voicePeAecMetrics,
        ),
      },
      sampleRateHz,
      validity: transportValidity,
    });
    const stackChanAssessment =
      options.definition.id === "stackchan"
        ? assessStackChanAecRun(stackChanAssessmentSamples)
        : undefined;
    const audioReasons = [
      ...assessment.reasons,
      ...(stackChanAssessment?.reasons.map((reason) => `StackChan health: ${reason}`) ?? []),
    ];
    const audioPassed = assessment.passed && (stackChanAssessment?.passed ?? true);
    const networkArtifact = buildPhysicalNetworkRunArtifact({
      ...networkCapture,
      audio: {
        failure: audioPassed ? null : audioReasons.join(" "),
        passed: audioPassed,
      },
      pcmEvidence: bridgeEvidence,
    });
    await Promise.all([
      writeJson(join(runDirectory, "aec-assessment.json"), assessment),
      writeJson(join(runDirectory, "stackchan-aec-health.json"), stackChanAssessment ?? null),
      writeJson(join(runDirectory, "aec-metrics.json"), {
        stackchan: stackChanAecMetrics,
        voicePe: voicePeAecMetrics,
      }),
      writeJson(join(runDirectory, "general-metrics.json"), generalMetrics),
      writeJson(join(runDirectory, "pcm-socket-closes.json"), pcmSocketCloseEvents),
      writeJson(join(runDirectory, "provider-events.json"), providerEvents),
      writeJson(join(runDirectory, "phase-markers.json"), phases),
      writeJson(join(runDirectory, "aec-traces.json"), diagnosticTraces),
      writePhysicalNetworkRunArtifact(
        join(runDirectory, "physical-network-validity.json"),
        networkArtifact,
      ),
    ]);
    const manifest = {
      assessmentPassed: audioPassed,
      buildDirectory: options.buildDirectory,
      createdAt: new Date().toISOString(),
      device: options.definition.id,
      firmwareApplication,
      networkClassification: networkArtifact.classification,
      networkVerdict: networkArtifact.network.verdict,
      pcm: {
        microphoneBytes: recording.microphone.bytes,
        microphoneSha256: recording.microphone.sha256,
        speakerBytes: recording.speaker.bytes,
        speakerSha256: recording.speaker.sha256,
      },
      port,
      schemaVersion: 1,
      stableUsbSerial: options.definition.stableUsbSerial,
      transport: {
        baseUrl: fixtureTransport.baseUrl,
        deviceHost,
        gateway: options.gateway,
        kind: fixtureTransport.kind,
        tunnelName: options.tunnelName ?? null,
      },
      startupLifecycle,
      stimuli: {
        acousticProfile: quietPhysicalAecAcousticProfile,
        doubleTalkPrbsCommitment: prbsDoubleTalkChallenge.seedCommitmentSha256,
        farPrbsCommitment: prbsFarChallenge.seedCommitmentSha256,
        nearSpeech,
        nearSourceSha256: createHash("sha256").update(nearPcm).digest("hex"),
        nearSourceWindow: {
          durationSamples: (assessmentIntervalMs * sampleRateHz) / 1_000,
          offsetSamples: (settledLeadMs * sampleRateHz) / 1_000,
        },
      },
      diagnosticTraces,
      transportValidity,
    };
    await writeJson(join(runDirectory, "manifest.json"), manifest);
    terminalArtifactsWritten = true;
    console.log(
      `aec_proof_complete device=${options.definition.id} passed=${audioPassed} ` +
        `network=${networkArtifact.classification} reasons=${JSON.stringify(audioReasons)} ` +
        `evidence=${runDirectory}`,
    );
    if (!audioPassed || networkArtifact.classification !== "valid") {
      throw new Error(
        `${options.definition.id} AEC acceptance failed (${networkArtifact.classification}): ` +
          audioReasons.join(" "),
      );
    }
  } catch (error) {
    runFailure = error;
  } finally {
    if (networkMonitor) {
      try {
        networkCaptureOnFailure = await networkMonitor.capture();
        networkMonitor = undefined;
      } catch (error) {
        runFailure = combineFailures(
          runFailure,
          error,
          "AEC run and network monitor cleanup failed",
        );
      }
    }
    if (conversationStarted && peer.activeMount) {
      try {
        pcmCloseExpected = true;
        const device = peer.activeMount.device as unknown as AecDeviceCapability;
        await device.conversation.hangUp();
      } catch (error) {
        runFailure = combineFailures(runFailure, error, "AEC run and conversation cleanup failed");
      }
    }
    try {
      recordingSummary = await recorder.close();
    } catch (error) {
      runFailure = combineFailures(runFailure, error, "AEC run and recorder cleanup failed");
    }
    if (runFailure !== undefined && !terminalArtifactsWritten) {
      try {
        /*
         * A failed physical run is often the most valuable run. Persist every
         * observation accepted before touching USB configuration so a missing
         * speaker frame, reconnect, malformed metric, or recorder boundary can
         * be attributed offline instead of disappearing behind the terminal
         * exception that happened to stop the scenario.
         */
        await Promise.all([
          writeJson(join(runDirectory, "failure.json"), serializeFailure(runFailure)),
          writeJson(join(runDirectory, "aec-metrics.partial.json"), {
            stackchan: stackChanAecMetrics,
            voicePe: voicePeAecMetrics,
          }),
          writeJson(join(runDirectory, "general-metrics.partial.json"), generalMetrics),
          writeJson(join(runDirectory, "pcm-socket-closes.partial.json"), pcmSocketCloseEvents),
          writeJson(join(runDirectory, "provider-events.partial.json"), providerEvents),
          writeJson(join(runDirectory, "bridge-evidence.partial.json"), {
            closeEvents: bridgeCloseEvents,
            openEvents: bridgeOpenEvents,
            progress: { microphoneBytes, speakerBytes, speakerFrames },
          }),
          writeJson(join(runDirectory, "run-state.partial.json"), {
            currentPhase,
            firmwareApplication,
            recording: recordingSummary,
          }),
          ...(networkCaptureOnFailure
            ? [
                writeJson(
                  join(runDirectory, "physical-network-capture.partial.json"),
                  networkCaptureOnFailure,
                ),
              ]
            : []),
        ]);
      } catch (error) {
        runFailure = combineFailures(
          runFailure,
          error,
          "AEC run failed and its partial evidence could not be persisted",
        );
      }
    }
    if (macOutputVolume !== undefined) {
      try {
        await setMacOutputVolume(macOutputVolume);
      } catch (error) {
        runFailure = combineFailures(
          runFailure,
          error,
          "AEC run and Mac volume restoration failed",
        );
      }
    }
    if (fixtureTransport) await fixtureTransport.close();
    server[Symbol.dispose]();
    provider[Symbol.dispose]();
    peer[Symbol.dispose]();
    if (temporaryConfigurationInstalled) {
      try {
        await flashFirmwareWithEsptool(
          {
            chipFamily: "ESP32-S3",
            eraseAll: false,
            parts: [
              {
                address: partition.offset,
                data: originalConfigurationBytes,
                label: "restored original iterate-kit/v1 configuration",
              },
            ],
          },
          { port: await resolveUsbPort(), pythonExecutable: options.pythonExecutable },
        );
        /*
         * write_flash already finishes with a verified hard reset. A second
         * `run` races the freshly booting native-USB application and previously
         * turned a successful byte-for-byte restoration into a false cleanup
         * failure (`No serial data received`). The temporary install above
         * retains its explicit run because the following Cap'n Web mount is a
         * hard application-start proof; restoration ends at verified reset.
         */
        console.log(
          `aec_configuration_restored device=${options.definition.id} bytes=${partition.size}`,
        );
      } catch (error) {
        runFailure = combineFailures(
          runFailure,
          error,
          "AEC run failed and the original device configuration could not be restored",
        );
      }
    }
  }

  if (runFailure) throw runFailure;
}

async function runCalibrationAcquisition(options: {
  assertHealthy(): void;
  bridgeCloseEvents: Array<{
    closedAtMonotonicMs: number;
    metrics: LocalFetchWebSocketBridgeMetrics;
  }>;
  bridgeOpenEvents: LocalFetchWebSocketBridgeOpenEvent[];
  calibrationOutput: string;
  device: AecDeviceCapability;
  deviceHost: string;
  deviceId: DeviceKind;
  firmwareApplication: Awaited<ReturnType<typeof readLocalEspIdfApplicationProvenance>>;
  fixtureTransport: AecFixtureTransport;
  generalMetrics: Array<TimedMetric<DeviceRuntimeMetrics>>;
  getPcmProgress(): { deviceToWorkerBytes: number; workerToDeviceBytes: number };
  getProviderResponseCompletions(): number;
  getSpeakerFrames(): number;
  networkMonitor: PhysicalNetworkRunMonitor;
  recorder: PcmConversationRecorder;
  runDirectory: string;
  server: LocalDevicePeerServer;
  setConversationStarted(started: boolean): void;
  setCurrentPhase(phase: string | null): void;
  stackChanAecMetrics: Array<TimedMetric<KitAecMetrics>>;
  voicePeAecMetrics: Array<TimedMetric<KitRawCleanAecMetrics>>;
}) {
  const driveCandidates = [];
  const nearCandidates = [];
  const sourceDirectory = join(options.runDirectory, "calibration-sources");
  await mkdir(sourceDirectory, { recursive: true });

  for (const pcmPeakAmplitude of calibrationDriveCandidates) {
    const phase = `calibration-far-${pcmPeakAmplitude}`;
    options.setCurrentPhase(phase);
    const source = renderPcm16Le(
      createTonePcm16LeRenderer({
        amplitude: pcmPeakAmplitude,
        frequencyHz: 997,
        sampleRateHz,
      }),
      (calibrationProviderDurationMs * sampleRateHz) / 1_000,
      4_093,
    );
    const sourcePath = join(sourceDirectory, `${phase}.pcm16le`);
    await writePcmArtifact(sourcePath, source);
    const speakerBaseline = options.getSpeakerFrames();
    const completionTarget = options.getProviderResponseCompletions() + 1;
    if (!(await options.server.requestVoiceText(`AEC drive calibration ${pcmPeakAmplitude}`))) {
      throw new Error(`The local PCM bridge rejected calibration drive ${pcmPeakAmplitude}.`);
    }
    await waitFor(
      () => options.getSpeakerFrames() > speakerBaseline,
      operationTimeoutMs,
      `${phase} first device-speaker frame`,
    );
    await delay(500);
    const generation = await startAecDiagnosticTrace(options.device.aecTrace);
    const trace = await retainStartedPhaseTrace(
      options.device.aecTrace,
      options.runDirectory,
      phase,
      generation,
    );
    await waitFor(
      () => options.getProviderResponseCompletions() >= completionTarget,
      calibrationProviderDurationMs + operationTimeoutMs,
      `${phase} provider response completion`,
    );
    options.assertHealthy();
    driveCandidates.push({
      pcmPeakAmplitude,
      playoutClippedSamples: trace.fullScaleSamples.playout ?? 0,
      rawMicClippedSamples: trace.fullScaleSamples.near ?? 0,
      sourceClippedSamples: countFullScalePcm16LeSamples(source),
    });
    await delay(phaseGuardMs);
  }

  const nearWavePath = join(sourceDirectory, "near-deterministic-speech.wav");
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
  const nearWave = decodeMonoPcm16Wave(await readFile(nearWavePath));
  if (nearWave.sampleRateHz !== sampleRateHz) {
    throw new Error(
      `Calibration near source was ${nearWave.sampleRateHz} Hz, expected ${sampleRateHz}.`,
    );
  }
  const nearSourceClippedSamples = countFullScalePcm16LeSamples(nearWave.pcm);
  const originalMacVolume = await readMacOutputVolume();
  try {
    for (const macOutputVolumePercent of calibrationNearVolumes) {
      const phase = `calibration-near-${macOutputVolumePercent}`;
      options.setCurrentPhase(phase);
      await setMacOutputVolume(macOutputVolumePercent);
      const playback = playFile(nearWavePath);
      await delay(300);
      const generation = await startAecDiagnosticTrace(options.device.aecTrace);
      const trace = await retainStartedPhaseTrace(
        options.device.aecTrace,
        options.runDirectory,
        phase,
        generation,
      );
      await withTimeout(
        playback,
        (nearWave.pcm.byteLength / 2 / sampleRateHz) * 1_000 + operationTimeoutMs,
        `${phase} Mac acoustic playback`,
      );
      options.assertHealthy();
      nearCandidates.push({
        macOutputVolumePercent,
        rawMicClippedSamples: trace.fullScaleSamples.near ?? 0,
        sourceClippedSamples: nearSourceClippedSamples,
      });
      await delay(phaseGuardMs);
    }
  } finally {
    await setMacOutputVolume(originalMacVolume);
  }
  options.setCurrentPhase(null);

  const deviceId = options.deviceId;
  const exactMac = definitions[deviceId].stableUsbSerial;
  const composed = composeMeasuredAecReleaseCalibration({
    artifactDirectory: options.runDirectory,
    calibratedAt: new Date().toISOString(),
    codecDrive:
      deviceId === "stackchan"
        ? { kind: "esp-codec-volume-percent", percent: 90 }
        : { decibels: 0, kind: "aic3204-dac-decibels" },
    deviceId,
    driveCandidates,
    exactMac,
    nearCandidates,
    reviewedSafetyCeilingAmplitude: calibrationSafetyCeilingAmplitude,
  });
  const calibration = validateAecReleaseCalibration(composed.calibration, {
    expectedDeviceId: deviceId,
    expectedMac: exactMac,
  });
  await mkdir(dirname(options.calibrationOutput), { recursive: true });
  await writeJson(options.calibrationOutput, calibration);
  await writeJson(join(options.runDirectory, "calibration-acquisition.json"), composed);

  const networkCapture = await options.networkMonitor.capture();
  const networkArtifact = buildPhysicalNetworkRunArtifact({
    ...networkCapture,
    /* Calibration is a clipping boundary acquisition, not an AEC quality verdict. */
    audio: { failure: null, passed: true },
    pcmEvidence: aecFixturePcmEvidence({
      bridgeCloseEvents: options.bridgeCloseEvents,
      bridgeOpenEvents: options.bridgeOpenEvents,
      progress: options.getPcmProgress(),
      transportKind: options.fixtureTransport.kind,
    }),
  });
  await writePhysicalNetworkRunArtifact(
    join(options.runDirectory, "physical-network-validity.json"),
    networkArtifact,
  );
  if (!(await options.device.conversation.hangUp())) {
    throw new Error(`${deviceId} rejected calibration conversation.hangUp().`);
  }
  options.setConversationStarted(false);
  const recording = await options.recorder.close();
  await Promise.all([
    writeJson(join(options.runDirectory, "aec-metrics.json"), {
      stackchan: options.stackChanAecMetrics,
      voicePe: options.voicePeAecMetrics,
    }),
    writeJson(join(options.runDirectory, "general-metrics.json"), options.generalMetrics),
    writeJson(join(options.runDirectory, "manifest.json"), {
      calibrationOutput: options.calibrationOutput,
      createdAt: new Date().toISOString(),
      device: deviceId,
      exactMac,
      firmwareApplication: options.firmwareApplication,
      networkClassification: networkArtifact.classification,
      networkVerdict: networkArtifact.network.verdict,
      qualification: "calibration-acquisition-only",
      schemaVersion: 1,
      transport: {
        baseUrl: options.fixtureTransport.baseUrl,
        deviceHost: options.deviceHost,
        kind: options.fixtureTransport.kind,
      },
    }),
  ]);
  console.log(
    `aec_calibration_complete device=${deviceId} network=${networkArtifact.classification} ` +
      `calibration=${options.calibrationOutput} evidence=${options.runDirectory}`,
  );
  return { recording };
}

async function runReleaseMatrixAcquisition(options: {
  assertHealthy(): void;
  bundle: LoadedAecReleaseFixtureBundle;
  device: AecDeviceCapability;
  generalMetrics: Array<TimedMetric<DeviceRuntimeMetrics>>;
  getPcmReadyGenerations(): number;
  getProviderResponseCompletions(): number;
  getSpeakerFrames(): number;
  markPcmCloseExpected(expected: boolean): void;
  provider: DeterministicPcmProvider;
  replay: AecReleaseFixtureReplay;
  recorder: PcmConversationRecorder;
  runDirectory: string;
  server: LocalDevicePeerServer;
  setConversationStarted(started: boolean): void;
  setCurrentPhase(phase: string | null): void;
}) {
  const phases: Record<string, RecordedPhase> = {};
  const traces: Record<string, Record<string, RetainedTraceArtifact>> = {};
  const phaseStarts = new Map<string, number>();
  const phaseStartMarkers = new Map<string, PcmConversationMarker>();
  const nearWave = await options.bundle.readNearWave();
  const nearWavePath = join(options.runDirectory, "mac-near-source.wav");
  await writeFile(nearWavePath, nearWave, { flag: "wx" });
  const originalMacVolume = await readMacOutputVolume();

  const restartConversation = async (label: string) => {
    options.markPcmCloseExpected(true);
    if (!(await options.device.conversation.hangUp())) {
      throw new Error(`${label} conversation.hangUp() was rejected.`);
    }
    options.setConversationStarted(false);
    await delay(250);
    if (!(await options.device.conversation.start())) {
      throw new Error(`${label} conversation.start() was rejected.`);
    }
    options.setConversationStarted(true);
    /*
     * The shared firmware owns one lifetime /pcm connection and gates media by
     * conversation state. A clean stop/start therefore need not create a new
     * socket generation. One metrics period is the observable post-restart
     * barrier; demanding a reconnect here would regress the prewarming design.
     */
    const metricsTarget = options.generalMetrics.length + 1;
    await waitFor(
      () => options.generalMetrics.length >= metricsTarget,
      operationTimeoutMs,
      `${label} post-restart metrics barrier`,
    );
    options.markPcmCloseExpected(false);
  };

  const adapter: AecReleaseMatrixAdapter = {
    async beginPhase(phase) {
      options.assertHealthy();
      options.setCurrentPhase(phase.id);
      traces[phase.id] = {};
    },
    async capturePhase(phase) {
      const phaseStartedAt = phaseStarts.get(phase.id);
      if (phaseStartedAt === undefined) {
        throw new Error(`AEC release phase ${phase.id} has no media-start boundary.`);
      }
      const traceDescription = decodeAecDiagnosticTraceMetadata(
        await options.device.aecTrace.describe(),
      );
      const traceDurationMs =
        (traceDescription.captureSamples * 1_000) / traceDescription.sampleRateHz;
      const offsets = aecReleaseTraceOffsets(phase.durationMs, traceDurationMs, phase.id);
      for (let index = 0; index < offsets.length; index += 1) {
        const offsetMs = offsets[index]!;
        const waitMs = phaseStartedAt + offsetMs - performance.now();
        if (waitMs > 0) await delay(waitMs);
        options.assertHealthy();
        const window = aecReleaseTraceWindowName(index, offsets.length);
        traces[phase.id]![window] = await capturePhaseTrace(
          options.device.aecTrace,
          options.runDirectory,
          `${phase.id}/${window}`,
          offsetMs,
        );
      }
    },
    async endPhase(phase) {
      options.assertHealthy();
      const start = phaseStartMarkers.get(phase.id);
      if (!start) throw new Error(`AEC release phase ${phase.id} has no start marker.`);
      const end = requireMarker(
        options.recorder.recordEvent(`${phase.id}.assessment.completed`),
        phase.id,
      );
      phases[phase.id] = { end, start };
      options.setCurrentPhase(null);
      await delay(phaseGuardMs);
    },
    async performLifecycleAction(phase) {
      switch (phase.lifecycleAction) {
        case "conversation-stop-start":
          await restartConversation(phase.id);
          break;
        case "provider-generation-change": {
          const generation = options.getPcmReadyGenerations();
          options.markPcmCloseExpected(true);
          options.provider.retireConnections(phase.id);
          await waitFor(
            () => options.getPcmReadyGenerations() > generation,
            operationTimeoutMs,
            `${phase.id} replacement PCM generation`,
          );
          options.markPcmCloseExpected(false);
          break;
        }
        case "aec-restart-reconvergence":
          /* Conversation restart recreates/resets each target's actual AEC owner. */
          await restartConversation(phase.id);
          break;
        case "playback-underrun-recovery":
        case "long-duration-changing-playback":
          /* The former is encoded as an exact source pause; the latter needs no side action. */
          break;
        case null:
          throw new Error(`AEC release lifecycle phase ${phase.id} has no declared action.`);
      }
    },
    async sourcesStarted(phase) {
      phaseStarts.set(phase.id, performance.now());
      phaseStartMarkers.set(
        phase.id,
        requireMarker(options.recorder.recordEvent(`${phase.id}.assessment.started`), phase.id),
      );
    },
    async startFarSource(phase) {
      await options.replay.prepare(phase);
      const speakerBaseline = options.getSpeakerFrames();
      const completionTarget = options.getProviderResponseCompletions() + 1;
      if (!(await options.server.requestVoiceText(`AEC release fixture ${phase.id}`))) {
        throw new Error(`The local PCM bridge rejected release phase ${phase.id}.`);
      }
      await waitFor(
        () => options.getSpeakerFrames() > speakerBaseline,
        operationTimeoutMs,
        `${phase.id} first device-speaker frame`,
      );
      return () =>
        waitFor(
          () => options.getProviderResponseCompletions() >= completionTarget,
          phase.durationMs + operationTimeoutMs,
          `${phase.id} provider response completion`,
        );
    },
    async startNearSource(phase) {
      if (!phase.nearSource) throw new Error(`AEC release phase ${phase.id} has no near source.`);
      await setMacOutputVolume(phase.nearSource.macOutputVolumePercent);
      const playback = playFile(nearWavePath);
      return () =>
        withTimeout(
          playback,
          phase.durationMs + operationTimeoutMs,
          `${phase.id} Mac acoustic source playback`,
        );
    },
  };

  try {
    await runAecReleaseMatrixController(options.bundle.plan, adapter);
    return { phases, traces };
  } finally {
    await setMacOutputVolume(originalMacVolume);
  }
}

async function runFarOnlyPhase(options: {
  label: Extract<PhaseName, `far-${string}`>;
  recorder: PcmConversationRecorder;
  responseCompletionCount: () => number;
  retainTrace: () => Promise<RetainedTraceArtifact>;
  server: LocalDevicePeerServer;
  setPhase: (phase: PhaseName | null) => void;
  speakerFrameCount: () => number;
}) {
  options.setPhase(options.label);
  const speakerBaseline = options.speakerFrameCount();
  const responseTarget = options.responseCompletionCount() + 1;
  if (!(await options.server.requestVoiceText(`AEC ${options.label} fixture`))) {
    throw new Error(`The local PCM bridge rejected ${options.label}.`);
  }
  await waitFor(
    () => options.speakerFrameCount() > speakerBaseline,
    operationTimeoutMs,
    `the first ${options.label} speaker frame`,
  );
  await delay(settledLeadMs);
  const [phase, trace] = await Promise.all([
    recordSettledInterval(options.recorder, options.label, assessmentIntervalMs),
    options.retainTrace(),
  ]);
  await waitFor(
    () => options.responseCompletionCount() >= responseTarget,
    operationTimeoutMs,
    `${options.label} provider response to drain`,
  );
  await delay(phaseGuardMs);
  options.setPhase(null);
  return { phase, trace };
}

async function runNearControlPhase(options: {
  label: Extract<PhaseName, "near-only" | "near-repeat">;
  nearWavePath: string;
  recorder: PcmConversationRecorder;
  responseCompletionCount: () => number;
  retainTrace: () => Promise<RetainedTraceArtifact>;
  server: LocalDevicePeerServer;
  setPhase: (phase: PhaseName | null) => void;
  speakerFrameCount: () => number;
}) {
  options.setPhase(options.label);
  const speakerBaseline = options.speakerFrameCount();
  const responseTarget = options.responseCompletionCount() + 1;
  if (!(await options.server.requestVoiceText(`AEC ${options.label} matched-path pilot`))) {
    throw new Error(`The local PCM bridge rejected the ${options.label} matched-path pilot.`);
  }
  await waitFor(
    () => options.speakerFrameCount() > speakerBaseline,
    operationTimeoutMs,
    `the first ${options.label} matched-path pilot speaker frame`,
  );
  const nearPlayback = playFile(options.nearWavePath);
  await delay(settledLeadMs);
  const [phase, trace] = await Promise.all([
    recordSettledInterval(options.recorder, options.label, assessmentIntervalMs),
    options.retainTrace(),
  ]);
  await Promise.all([
    withTimeout(nearPlayback, operationTimeoutMs, `${options.label} Mac acoustic source playback`),
    waitFor(
      () => options.responseCompletionCount() >= responseTarget,
      operationTimeoutMs,
      `${options.label} matched-path pilot response to drain`,
    ),
  ]);
  await delay(phaseGuardMs);
  options.setPhase(null);
  return { phase, trace };
}

async function capturePhaseTrace(
  capability: AecDiagnosticTraceCapability,
  runDirectory: string,
  phase: string,
  scheduledOffsetMs?: number,
): Promise<RetainedTraceArtifact> {
  const captureStartedAtMonotonicMs = performance.now();
  const generation = await startAecDiagnosticTrace(capability);
  const artifact = await retainStartedPhaseTrace(capability, runDirectory, phase, generation);
  if (scheduledOffsetMs === undefined) return artifact;
  return {
    ...artifact,
    captureCompletedAtMonotonicMs: performance.now(),
    captureStartedAtMonotonicMs,
    scheduledOffsetMs,
  };
}

async function retainStartedPhaseTrace(
  capability: AecDiagnosticTraceCapability,
  runDirectory: string,
  phase: string,
  generation: number,
): Promise<RetainedTraceArtifact> {
  const trace = await retrieveAecDiagnosticTrace(capability, {
    expectedGeneration: generation,
    timeoutMs: operationTimeoutMs,
  });
  const traceDirectory = join(runDirectory, "aec-traces", phase);
  await mkdir(traceDirectory, { recursive: true });
  const filenames = {
    clean: "clean.pcm16le",
    linear: "linear.pcm16le",
    near: "raw-microphone.pcm16le",
    playout: "completed-dma-playout.pcm16le",
    reference: "electrical-reference.pcm16le",
  } as const;
  const planes: RetainedTraceArtifact["planes"] = {};
  const fullScaleSamples: RetainedTraceArtifact["fullScaleSamples"] = {};
  for (const [name, bytes] of Object.entries(trace.planes)) {
    if (bytes === undefined) continue;
    const filename = filenames[name as keyof typeof filenames];
    const path = join(traceDirectory, filename);
    await writeFile(path, bytes, { flag: "wx" });
    planes[name] = {
      bytes: bytes.byteLength,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    fullScaleSamples[name as keyof typeof fullScaleSamples] = countFullScalePcm16LeSamples(bytes);
  }
  await writeJson(join(traceDirectory, "metadata.json"), trace.metadata);
  return { fullScaleSamples, metadata: trace.metadata, planes };
}

async function writePcmArtifact(path: string, samples: Uint8Array | Int16Array) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  await writeFile(path, bytes, { flag: "wx" });
  return {
    bytes: bytes.byteLength,
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function recordSettledInterval(
  recorder: PcmConversationRecorder,
  label: PhaseName,
  durationMs: number,
): Promise<RecordedPhase> {
  const start = requireMarker(recorder.recordEvent(`${label}.assessment.started`), label);
  await delay(durationMs);
  const end = requireMarker(recorder.recordEvent(`${label}.assessment.completed`), label);
  return { end, start };
}

function requireMarker(marker: PcmConversationMarker | undefined, label: string) {
  if (!marker) throw new Error(`The PCM recorder rejected the ${label} phase marker.`);
  return marker;
}

export function sliceMarkerPcm(
  bytes: Uint8Array,
  phase: RecordedPhase,
  lane: "microphone" | "speaker",
  options: { allowEmpty?: boolean } = {},
) {
  return decodePcm16Le(sliceMarkerPcmBytes(bytes, phase, lane, options));
}

function sliceMarkerPcmBytes(
  bytes: Uint8Array,
  phase: RecordedPhase,
  lane: "microphone" | "speaker",
  options: { allowEmpty?: boolean } = {},
) {
  const start =
    lane === "microphone" ? phase.start.microphoneByteOffset : phase.start.speakerByteOffset;
  const end = lane === "microphone" ? phase.end.microphoneByteOffset : phase.end.speakerByteOffset;
  const isAllowedEmpty = options.allowEmpty === true && end === start;
  if (
    start < 0 ||
    end < start ||
    (!isAllowedEmpty && end === start) ||
    end > bytes.byteLength ||
    start % 2 !== 0 ||
    end % 2 !== 0
  ) {
    throw new Error(`${lane} phase boundaries ${start}..${end} are not valid PCM16 offsets.`);
  }
  return bytes.subarray(start, end);
}

function decodePcm16Le(bytes: Uint8Array) {
  if (bytes.byteLength % 2 !== 0) throw new Error("PCM16LE evidence has an odd byte count.");
  const samples = new Int16Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true);
  }
  return samples;
}

function phasePlaybackObserved(
  device: DeviceKind,
  phase: PhaseName,
  stackChan: readonly TimedMetric<KitAecMetrics>[],
  voicePe: readonly TimedMetric<KitRawCleanAecMetrics>[],
) {
  if (device === "stackchan") {
    return stackChanMatchedReferenceObserved(
      stackChan
        .filter((sample) => sample.phase === phase && sample.value.sampledSamples > 0)
        .map((sample) => ({
          lifetimePlaybackContentSamples: sample.value.lifetimePlaybackContentSamples,
          referenceMeanAbsolute: sample.value.referenceMeanAbsolute,
        })),
    );
  }
  return voicePe.some(
    (sample) => sample.phase === phase && sample.value.playbackContentSamples >= 8_000,
  );
}

function deriveTransportValidity(options: {
  baselineGeneral: DeviceRuntimeMetrics;
  baselinePlaybackHealth: KitSynchronousPlaybackHealthMetrics;
  diagnostics: ReadonlyArray<{
    diagnostics?: KitControlDiagnostics;
    outcome: "failure" | "success";
  }>;
  recordingComplete: boolean;
  terminalGeneral: DeviceRuntimeMetrics;
  terminalPlaybackHealth: KitSynchronousPlaybackHealthMetrics;
}) {
  const lifecycle = derivePhysicalAecLifecycleDelta({
    afterGeneral: options.terminalGeneral,
    afterPlayback: options.terminalPlaybackHealth,
    beforeGeneral: options.baselineGeneral,
    beforePlayback: options.baselinePlaybackHealth,
  });
  const successfulDiagnostics = options.diagnostics.flatMap((sample) =>
    sample.outcome === "success" && sample.diagnostics ? [sample.diagnostics] : [],
  );
  const firstDiagnostics = successfulDiagnostics[0];
  const lastDiagnostics = successfulDiagnostics.at(-1);
  const reconnects =
    firstDiagnostics && lastDiagnostics
      ? nonnegativeDelta(
          firstDiagnostics.network.pcmWebsocketConnections,
          lastDiagnostics.network.pcmWebsocketConnections,
        )
      : 1;
  return {
    captureFailures: lifecycle.captureFailures,
    captureFrameDrops: lifecycle.captureFrameDrops,
    clockDiscontinuities: 0,
    networkValid: false,
    playbackDroppedFrames: lifecycle.playbackDroppedFrames,
    playbackIntegrityFailures: lifecycle.playbackIntegrityFailures,
    playbackResets: lifecycle.playbackResets,
    /*
     * Neither synchronous codec exposes a truthful wire-frame underrun count;
     * queue, policy and write discontinuities are instead represented by the
     * integrity sum above. Zero here means unsupported failure category, not
     * a fabricated observation from the Stick-only DMA schema.
     */
    playbackUnderrunIncidents: 0,
    recorderComplete: options.recordingComplete,
    uplinkFrameDrops: lifecycle.uplinkFrameDrops,
    uplinkRestarts: lifecycle.uplinkRestarts,
    websocketReconnects: reconnects,
  };
}

function nonnegativeDelta(before: unknown, after: unknown) {
  return typeof before === "number" && typeof after === "number" && after >= before
    ? after - before
    : 1;
}

function assertNoAsynchronousFailure(...failures: Array<Error | undefined>) {
  const failure = failures.find((candidate) => candidate !== undefined);
  if (failure) throw failure;
}

function normalizeSocketHost(value: string | undefined) {
  if (!value) throw new Error("The PCM bridge did not retain the physical device address.");
  const normalized = value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
  if (!normalized.trim()) throw new Error("The PCM bridge retained an empty device address.");
  return normalized;
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

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await delay(10);
  }
}

function withTimeout<Value>(promise: Promise<Value>, timeoutMs: number, label: string) {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error(`Timed out waiting for ${label}.`);
    }),
  ]);
}

function requireFirmwareDevice(id: DeviceKind): FirmwareDevice {
  const device = findFirmwareDevice(id);
  if (!device || device.installMethod.kind !== "esp-serial") {
    throw new Error(`${id} is not an ESP serial firmware target.`);
  }
  return device;
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function combineFailures(current: unknown, next: unknown, message: string) {
  return current === undefined ? next : new AggregateError([current, next], message);
}

function countFullScalePcm16LeSamples(bytes: Uint8Array) {
  if (bytes.byteLength % 2 !== 0) {
    throw new Error("PCM16 clipping measurement received an odd byte count.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let clippedSamples = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true);
    if (sample === -32_768 || sample === 32_767) clippedSamples += 1;
  }
  return clippedSamples;
}

function serializeFailure(error: unknown): unknown {
  if (error instanceof AggregateError) {
    return {
      errors: [...error.errors].map(serializeFailure),
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  if (error instanceof Error) {
    return {
      cause: error.cause === undefined ? undefined : serializeFailure(error.cause),
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  return { value: String(error) };
}

export function parseAecPhysicalCliOptions(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): CliOptions {
  let device = environment.ITERATE_KIT_DEVICE_ID?.trim() ?? "stackchan";
  let buildDirectory: string | undefined;
  let outputDirectory: string | undefined;
  let fixtureBundle: string | undefined;
  let calibrationOutput: string | undefined;
  let port: string | undefined;
  let pythonExecutable = environment.ITERATE_KIT_PYTHON?.trim() ?? defaultPythonExecutable;
  const transportArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--") continue;
    const value = args[++index]?.trim();
    if (!value) throw new Error(`${flag} requires a value.`);
    if (flag === "--device") device = value;
    else if (flag === "--build-directory") buildDirectory = value;
    else if (flag === "--calibration-output") calibrationOutput = resolve(value);
    else if (flag === "--fixture-bundle") fixtureBundle = resolve(value);
    else if (flag === "--output-directory") outputDirectory = value;
    else if (flag === "--port") port = value;
    else if (flag === "--python") pythonExecutable = value;
    else if (
      flag === "--device-host" ||
      flag === "--direct-lan-host" ||
      flag === "--direct-lan-port" ||
      flag === "--gateway" ||
      flag === "--tunnel-name"
    ) {
      transportArgs.push(flag, value);
    } else if (flag === "--host") {
      /*
       * The pre-Captun proof called its LAN bind address `--host`. Preserve
       * old invocations while making the transport choice explicit in new
       * runbooks and evidence.
       */
      transportArgs.push("--direct-lan-host", value);
    } else throw new Error(`Unknown option ${flag}.`);
  }
  if (device !== "stackchan" && device !== "home-assistant-voice-preview-edition") {
    throw new Error("--device must be stackchan or home-assistant-voice-preview-edition.");
  }
  const definition = definitions[device];
  if (calibrationOutput && fixtureBundle) {
    throw new Error("--calibration-output and --fixture-bundle are mutually exclusive.");
  }
  const transport = parseAecFixtureCliOptions(transportArgs, environment);
  return {
    buildDirectory: resolve(buildDirectory ?? definition.buildDirectory),
    calibrationOutput,
    captunToken: transport.captunToken,
    deviceHost: transport.deviceHost,
    definition,
    directLanHost: transport.directLanHost,
    directLanPort: transport.directLanPort,
    fixtureBundle,
    gateway: transport.gateway,
    outputDirectory: resolve(
      outputDirectory ?? join(packageDirectory, "evidence", `${device}-aec-physical`),
    ),
    port,
    pythonExecutable,
    tunnelName: transport.tunnelName,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  proveLocalAec(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
