import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createCaptunTunnel, type CaptunTunnel } from "captun";
import {
  analyzeAcousticTonePcm16Artifact,
  assessAcousticToneAnalysis,
} from "../src/device/acoustic-tone-analysis.ts";
import {
  analyzeDualCarrierPrbs31Pcm16Artifact,
  assessDualCarrierPrbs31Analysis,
  computeDualCarrierPrbs31Pcm16SourceIdentity,
  createDualCarrierPrbs31Challenge,
} from "../src/device/acoustic-prbs31-challenge.ts";
import {
  observeAutonomousVoiceFrameTiming,
  type AutonomousVoiceTurnTiming,
} from "../src/device/autonomous-voice-timing.ts";
import {
  assessBoundedCapabilityChurn,
  BoundedCapabilityChurn,
  type BoundedCapabilityChurnSummary,
} from "../src/device/bounded-capability-churn.ts";
import {
  deviceE2eUsesGrokProvider,
  parseDeviceE2eCliOptions,
} from "../src/device/device-e2e-cli-options.ts";
import { resolveDeviceE2eProvisioning } from "../src/device/device-e2e-provisioning.ts";
import {
  observeControlMountOutcome,
  settleControlMountOutcome,
} from "../src/device/control-mount-diagnostics.ts";
import {
  DeviceRuntimeMetricsContinuity,
  assessDeviceRuntimeMetrics,
  devicePlaybackCompleted,
  devicePlaybackFramesCompleted,
  devicePlaybackResponseCompleted,
  deviceInterruptedVoiceSequenceCompleted,
  deviceUplinkStreaming,
  deviceVoiceTurnCompleted,
  parseKitMetricsCallback,
  parseDeviceRuntimeLogLine,
  type DeviceRuntimeLogObservation,
  type DeviceRuntimeMetrics,
} from "../src/device/device-runtime-log.ts";
import {
  LocalFetchWebSocketServer,
  type LocalFetchWebSocketBridgeMetrics,
  type LocalFetchWebSocketBridgeOpenEvent,
} from "../src/device/local-fetch-websocket-server.ts";
import {
  LocalDevicePeerServer,
  type LocalDevicePeerServerOptions,
} from "../src/device/local-device-peer-server.ts";
import { LocalDevicePeer } from "../src/device/local-device-peer.ts";
import {
  flattenKitPlaybackMetrics,
  parseKitPlaybackMetrics,
} from "../src/device/kit-playback-metrics.ts";
import { parseKitControlDiagnostics } from "../src/device/kit-control-diagnostics.ts";
import {
  MacOsPcm16Capture,
  type CompletedPcm16Capture,
} from "../src/device/macos-pcm16-capture.ts";
import {
  PcmConversationRecorder,
  type PcmConversationRecordingSummary,
} from "../src/device/pcm-conversation-recorder.ts";
import {
  buildPhysicalNetworkRunArtifact,
  type PhysicalNetworkMonitorCapture,
  type PhysicalNetworkBridgeEvidence,
  PhysicalNetworkRunMonitor,
  writePhysicalNetworkRunArtifact,
} from "../src/device/physical-network-run.ts";
import {
  discoverDarwinDefaultGateway,
  measureRemoteDnsAndTlsConnect,
  warmPhysicalNetworkReachability,
} from "../src/device/physical-network-reachability.ts";
import { assessPlaybackCounterPolicy } from "../src/device/playback-counter-policy.ts";
import { assessPlaybackRecoveryAcoustics } from "../src/device/playback-recovery-acoustic-policy.ts";
import {
  assessPlaybackRecoveryProof,
  playbackRecoveryIsComplete,
  playbackRecoverySafetyMaximumDeltas,
  type PlaybackRecoveryProofAssessment,
} from "../src/device/playback-recovery-policy.ts";
import { runM5StickS3PlaybackEnduranceMode } from "../src/device/m5sticks3-playback-endurance-mode.ts";
import {
  m5StickS3PlaybackEnduranceAcceptancePolicy,
  m5StickS3PlaybackEnduranceRequiredMetrics,
} from "../src/device/m5sticks3-playback-endurance-target.ts";
import { PythonSerialMonitor } from "../src/device/python-serial-monitor.ts";
import { M5STICKS3_CONFIGURATION_PARTITION } from "../src/firmware/catalog.ts";
import { decodeDeviceConfiguration } from "../src/firmware/config-image.ts";
import { readFlashRegionWithEsptool } from "../src/firmware/esptool-cli.ts";
import { parseLocalFlashCliOptions } from "../src/firmware/flash-cli-options.ts";
import { DeterministicPcmPrbs31Provider } from "../src/voice/deterministic-pcm-prbs31-provider.ts";
import { DeterministicPcmToneProvider } from "../src/voice/deterministic-pcm-tone-provider.ts";
import type { DevicePcmSocketClose } from "../src/voice/device-pcm-proxy.ts";
import { connectGrokRealtimeVoice } from "../src/voice/grok-realtime-voice.ts";
import {
  subscribePcmBridgeToDeviceEvents,
  type DeviceEvent,
} from "../src/userspace/config-worker/device-events.ts";
import { flashLocalM5StickS3 } from "./flash.ts";

const executeFile = promisify(execFile);
const pcmFrameBytes = 640;
const pcmFrameDurationMs = 20;
const deterministicToneFrequencyHz = 997;
const acousticCaptureTailMs = 500;
const voiceResponseTimeoutMs = 30_000;
/*
 * The Stick can safely hold only its existing eight-frame lead, but Grok's
 * measured WebSocket packet cadence has included a 203.28 ms source gap. Keep
 * 640 ms of already-generated audio at the userspace boundary before starting
 * a response, then drip-feed the device at the media cadence. This costs only
 * 20 KiB inside the proxy's already-allocated 256 KiB reservoir and does not
 * increase ESP RAM, device queue depth, or permission to replay stale audio.
 */
const deviceClockedSourceStartupFrames = 32;
const autonomousVoicePrompts = [
  "We are testing a conversation. Reply with a short greeting and remember the code word lantern.",
  "What code word did I ask you to remember? Reply in one short sentence.",
  "Tell me a short joke about engineers in one sentence.",
  "What profession was the joke about? Reply with only the profession.",
  "Combine the remembered code word and that profession in one short sentence.",
  "Count down from three, then say the remembered code word.",
  "Give that profession one cheerful piece of advice in one short sentence.",
  "Finish this test by saying the code word and goodbye in one short sentence.",
] as const;

const usage = `Usage:
  pnpm device:e2e -- --port /dev/cu.usbmodem101 --wifi-ssid <name> \\
    --build-directory firmware/targets/m5sticks3/build [options]

Harness options:
  --tunnel-name <name>          Optional stable tunnels.iterate.com subdomain
  --direct-lan-host <host>      Bind directly to this Mac LAN host; bypass Captun
  --direct-lan-port <port>      Stable LAN port, permitting verified --no-flash retries
  --device-clocked-downlink     Forward bounded PCM bursts; let device I²S own playout cadence
  --device-clocked-startup-frames <1..8>
                                Named startup lead; only with device-clocked delivery
  --control-churn-hz <1..100>   During deterministic playback, run bounded real
                                Cap'n Web getDiagnostics calls at this rate
  --mount-timeout-ms <ms>       Boot and mount deadline (default: 90000)
  --remote-hold-ms <ms>         Remote push-to-talk hold (default: 500)
  --voice                       Route Stick PCM through real Grok and inject a spoken prompt
  --remote-voice-turns <1..20>  Run that many unattended PTT turns on one Grok session
  --remote-interruption-proof   Interrupt a live Grok reply, then prove a fresh PTT reply
  --network-device-host <host>  Stick LAN address for tunnel-aligned reachability evidence
  --physical-voice-turns <1..20>
                                Drive a finite Grok conversation from physical Button A events;
                                the Stick speaks both ready and completed boundaries
  --grok-playback-only          Ask Grok by text and prove only Grok-to-speaker audio
  --tone-playback-only          Send a known tone through the complete provider-to-speaker lane
  --prbs31-playback-only        Send a run-keyed acoustic source that identifies lost intervals
  --playback-recovery-proof     Allow only conserved silence/drop recovery in deterministic tone
  --playback-endurance          Run the canonical 1m/2m/10m idle+load physical playback gate
  --playback-duration-ms <ms>   Whole 20 ms frames; 1000..600000 (default: 3000)
  --tone-duration-ms <ms>       Backwards-compatible alias for --playback-duration-ms
  --no-flash                    Reuse and verify the configuration already on the device
  --exit-after-remote-proof     Close after start/stop instead of observing the button

All firmware:flash options except --base-url and --dry-run are forwarded.
The tunnel supplies --base-url. Flashing generates project credentials when
ITERATE_KIT_PROJECT_ID / ITERATE_KIT_PROJECT_API_KEY are absent; --no-flash
reads the exact credentials and stable tunnel URL already on the device.

Required environment:
  CAPTUN_TOKEN                  unless --direct-lan-host is used
  ITERATE_KIT_WIFI_PASSWORD     optional when reflashing an already provisioned stick
  XAI_API_KEY                   only with --voice or --grok-playback-only

Optional environment:
  CAPTUN_GATEWAY (default: https://tunnels.iterate.com)
  CAPTUN_TUNNEL_NAME
  ITERATE_KIT_DIRECT_LAN_HOST
  ITERATE_KIT_DIRECT_LAN_PORT
  ITERATE_KIT_WIFI_SSID
  ITERATE_KIT_PROJECT_ID
  ITERATE_KIT_PROJECT_API_KEY
  ITERATE_KIT_PORT
  ITERATE_KIT_PYTHON
  ITERATE_KIT_ACOUSTIC_INPUT     AVFoundation selector used to verify CoreAudio input (default: :0)
  ITERATE_KIT_ACOUSTIC_OUTPUT_DIRECTORY
  ITERATE_KIT_NETWORK_EVIDENCE_OUTPUT_DIRECTORY
  ITERATE_KIT_NETWORK_DEVICE_HOST
  ITERATE_KIT_PCM_RECORDING_OUTPUT_DIRECTORY
  ITERATE_KIT_PLAYBACK_ENDURANCE_OUTPUT_DIRECTORY
  ITERATE_KIT_FFMPEG             default: /opt/homebrew/bin/ffmpeg
  ITERATE_KIT_SOX                CoreAudio recorder (default: /opt/homebrew/bin/sox)
  ITERATE_KIT_SERIAL_DIAGNOSTICS set to 1 to attach the USB serial fallback
  ITERATE_KIT_SAY                default: /usr/bin/say
  ITERATE_KIT_VOICE_PHRASE`;

interface AcousticCaptureMarker {
  capturedSampleCount: number;
  hostMonotonicMs: number;
  phase: string;
  sampleRateHz: number;
}

export async function runDeviceE2e(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  workingDirectory: string,
) {
  const options = parseDeviceE2eCliOptions(args, environment);
  const captunToken = environment.CAPTUN_TOKEN?.trim();
  if (!options.directLanHost && !captunToken) {
    throw new Error("Missing CAPTUN_TOKEN. Run this command through the app's Doppler config.");
  }
  /*
   * Endurance uses the deterministic 997 Hz challenge rather than a provider
   * account. Requiring XAI_API_KEY here would couple a physical continuity
   * gate to an unrelated external secret and could hide the more important
   * missing device-runtime operation behind an authentication error.
   */
  const usesGrokProvider = deviceE2eUsesGrokProvider(options);
  const xaiApiKey = usesGrokProvider ? environment.XAI_API_KEY?.trim() : undefined;
  if (usesGrokProvider && !xaiApiKey) {
    throw new Error("Missing XAI_API_KEY. Run the voice proof through the voice Doppler config.");
  }

  const existingConfiguration = await readExistingConfigurationWhenNeeded(
    options.flash,
    options.flashArgs,
    environment,
  );
  const provisioning = resolveDeviceE2eProvisioning({
    environment,
    existingConfiguration,
    flash: options.flash,
    generateProjectApiKey: () => `itxk_local_${randomBytes(24).toString("base64url")}`,
    generateProjectId: () => `prj_local_${randomBytes(8).toString("hex")}`,
  });
  const deviceEnvironment = {
    ...environment,
    ...provisioning.environment,
  };
  const validatedFlashOptions = parseLocalFlashCliOptions(
    [...options.flashArgs, "--base-url", "https://device-peer.invalid"],
    deviceEnvironment,
    workingDirectory,
  );
  const peer = new LocalDevicePeer({
    mountPath: ["kit", "m5sticks3"],
    projectId: validatedFlashOptions.configuration.iterate.projectId,
    projectSecret: validatedFlashOptions.configuration.iterate.projectApiKey,
  });
  const runtimeProbe = new DeviceRuntimeProbe();
  const pcmSessionReady = Promise.withResolvers<void>();
  const providerResponseDone = Promise.withResolvers<void>();
  const acousticChallenge =
    options.deterministicPlayback === "prbs31"
      ? createDualCarrierPrbs31Challenge({ runId: randomUUID() })
      : undefined;
  const deterministicProvider =
    options.deterministicPlayback === "tone"
      ? new DeterministicPcmToneProvider({
          amplitude: 24_576,
          /*
           * Deliberately misalign provider chunks with the 640-byte device
           * frame. A physical pass must therefore cover the proxy's streaming
           * reassembly, not just an unusually convenient fixture boundary.
           */
          chunkBytes: 1_000,
          durationMs: options.playbackDurationMs,
          /*
           * A 1 kHz tone contains exactly twenty cycles per 20 ms frame,
           * making a duplicated or skipped whole frame phase-invisible.
           * 997 Hz retains the simple narrow-band oracle while ensuring frame
           * discontinuities cannot accidentally join at the same phase.
           */
          frequencyHz: deterministicToneFrequencyHz,
          sampleRateHz: 16_000,
        })
      : acousticChallenge
        ? new DeterministicPcmPrbs31Provider({
            challenge: acousticChallenge,
            chunkBytes: 1_000,
            durationMs: options.playbackDurationMs,
          })
        : undefined;
  const recordsAutonomousVoiceConversation =
    options.voice &&
    options.physicalVoiceTurns === undefined &&
    !options.grokPlaybackOnly &&
    options.deterministicPlayback === undefined &&
    !options.playbackEndurance;
  const conversationOutputDirectory =
    options.physicalVoiceTurns !== undefined || recordsAutonomousVoiceConversation
      ? environment.ITERATE_KIT_PCM_RECORDING_OUTPUT_DIRECTORY?.trim() ||
        join(
          workingDirectory,
          "evidence",
          "m5sticks3-conversation",
          new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"),
        )
      : undefined;
  const conversationRecorder = conversationOutputDirectory
    ? await PcmConversationRecorder.create({
        frameBytes: pcmFrameBytes,
        outputDirectory: conversationOutputDirectory,
        sampleRateHz: 16_000,
      })
    : undefined;
  let conversationRecorderClosed = false;
  let physicalConversationStarts = 0;
  let physicalConversationStops = 0;
  let providerResponsesDone = 0;
  const providerResponseOutcomes: Array<{
    id: string | null;
    observedAtMonotonicMs: number;
    status: string | null;
  }> = [];
  let downlinkResponsesCompleted = 0;
  let microphoneUplinkFramesObserved = 0;
  let speakerDownlinkFramesObserved = 0;
  const providerResponseDoneAtMonotonicMs: number[] = [];
  const downlinkResponseCompletedAtMonotonicMs: number[] = [];
  let activeAutonomousTurn: AutonomousVoiceTurnTiming | undefined;
  let physicalConversationProviderResponseBaseline = 0;
  let physicalConversationDownlinkResponseBaseline = 0;
  let pendingVoiceProgress:
    | {
        downlinkTarget: number;
        providerTarget: number;
        resolve(): void;
      }
    | undefined;
  const resolvePendingVoiceProgress = () => {
    if (
      pendingVoiceProgress &&
      providerResponsesDone >= pendingVoiceProgress.providerTarget &&
      downlinkResponsesCompleted >= pendingVoiceProgress.downlinkTarget
    ) {
      pendingVoiceProgress.resolve();
    }
  };
  const waitForVoiceProgress = async (options: {
    downlinkTarget: number;
    message: string;
    providerTarget: number;
  }) => {
    if (pendingVoiceProgress) {
      throw new Error("Only one spoken device cue may be awaited at a time.");
    }
    if (
      providerResponsesDone >= options.providerTarget &&
      downlinkResponsesCompleted >= options.downlinkTarget
    ) {
      return;
    }
    const completed = Promise.withResolvers<void>();
    pendingVoiceProgress = {
      downlinkTarget: options.downlinkTarget,
      providerTarget: options.providerTarget,
      resolve: completed.resolve,
    };
    try {
      await runtimeProbe.race(
        withTimeout(completed.promise, voiceResponseTimeoutMs, options.message),
      );
    } finally {
      pendingVoiceProgress = undefined;
    }
  };
  const waitForObservedState = async (
    predicate: () => boolean,
    timeoutMs: number,
    message: string,
  ) => {
    /*
     * Frame/provider observations are synchronous callbacks on this process's
     * WebSocket event loop. A one-shot Promise would need a second mutable
     * waiter protocol beside the existing response waiter; a bounded 5 ms host
     * poll keeps that test-only coordination simple and never runs on the ESP
     * or in the PCM send path.
     */
    await runtimeProbe.race(
      withTimeout(
        (async () => {
          while (!predicate()) await delay(5);
        })(),
        timeoutMs,
        message,
      ),
    );
  };
  const physicalConversationComplete = Promise.withResolvers<void>();
  const maybeCompletePhysicalConversation = () => {
    if (
      options.physicalVoiceTurns !== undefined &&
      physicalConversationStops >= options.physicalVoiceTurns &&
      providerResponsesDone - physicalConversationProviderResponseBaseline >=
        options.physicalVoiceTurns &&
      downlinkResponsesCompleted - physicalConversationDownlinkResponseBaseline >=
        options.physicalVoiceTurns
    ) {
      physicalConversationComplete.resolve();
    }
  };
  let activeAcousticCapture: MacOsPcm16Capture | undefined;
  const acousticMarkerTasks = new Set<Promise<AcousticCaptureMarker | undefined>>();
  const recordAcousticMarker = (phase: string) => {
    const capture = activeAcousticCapture;
    if (!capture) return Promise.resolve(undefined);
    const hostMonotonicMs = performance.now();
    const task = capture
      .inspectProgress()
      .then((progress) => {
        const marker = {
          capturedSampleCount: progress.capturedSampleCount,
          hostMonotonicMs,
          phase,
          sampleRateHz: progress.sampleRateHz,
        };
        console.log(`acoustic_capture_marker=${JSON.stringify(marker)}`);
        return marker;
      })
      .catch((error) => {
        runtimeProbe.fail(
          new Error(
            `Unable to inspect acoustic capture at ${phase}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
        return undefined;
      })
      .finally(() => acousticMarkerTasks.delete(task));
    acousticMarkerTasks.add(task);
    return task;
  };
  const connectVoiceProvider = deterministicProvider
    ? () => deterministicProvider.connect()
    : xaiApiKey
      ? () =>
          connectGrokRealtimeVoice({
            apiKey: xaiApiKey,
            instructions:
              "This is a physical end-to-end device test. Reply in one very short sentence.",
            sampleRateHz: 16_000,
            turnDetection: "manual",
          })
      : undefined;
  const voiceServerOptions: LocalDevicePeerServerOptions | undefined = connectVoiceProvider
    ? {
        connectVoiceProvider,
        onVoiceFailure: (reason) => runtimeProbe.fail(new Error(`PCM proxy failure: ${reason}`)),
        onDownlinkResponseComplete: (observedAtMonotonicMs) => {
          downlinkResponsesCompleted += 1;
          downlinkResponseCompletedAtMonotonicMs.push(observedAtMonotonicMs);
          conversationRecorder?.recordEvent("speaker-downlink.completed", {
            proxyObservedAtMonotonicMs: observedAtMonotonicMs,
            response: downlinkResponsesCompleted,
          });
          console.log(`speaker_downlink_completed response=${downlinkResponsesCompleted}`);
          resolvePendingVoiceProgress();
          maybeCompletePhysicalConversation();
        },
        onPcmFrame: (frame) => {
          const autonomousTurn = activeAutonomousTurn;
          if (frame.direction === "microphone-uplink") {
            microphoneUplinkFramesObserved += 1;
          } else {
            speakerDownlinkFramesObserved += 1;
          }
          if (autonomousTurn) {
            observeAutonomousVoiceFrameTiming(
              autonomousTurn,
              frame.direction,
              frame.observedAtMonotonicMs,
            );
          }
          conversationRecorder?.observeFrame(frame);
        },
        onVoiceSocketClose: (close) => {
          /*
           * A prior physical failure produced 127 ms of sound and then only a
           * timeout. Preserve the causal WebSocket fields verbatim so device
           * loss, provider loss, and an orderly end cannot collapse into that
           * same useless symptom. Unexpected closure is a failed run; normal
           * closure remains visible lifecycle evidence.
           */
          runtimeProbe.observePcmSocketClose(close);
        },
        onPcmSessionReady: (session) => {
          if (session.id !== peer.pcmSessionId) {
            runtimeProbe.fail(
              new Error(`Unexpected PCM session ${session.id}; expected ${peer.pcmSessionId}.`),
            );
            return;
          }
          console.log(`pcm_session_ready id=${session.id}`);
          pcmSessionReady.resolve();
        },
        onVoiceProviderEvent: (event) => {
          console.log(`would_post_to_stream event=${event.type} frame=${event.raw}`);
          conversationRecorder?.recordEvent("provider.event", {
            raw: event.raw,
            turn: activeAutonomousTurn?.turn ?? null,
            type: event.type,
          });
          if (event.type === "response.created" || event.type === "response.done") {
            void recordAcousticMarker(`provider.${event.type}`);
          }
          if (event.type === "response.created" && activeAutonomousTurn) {
            activeAutonomousTurn.providerResponseCreatedAtMonotonicMs = performance.now();
          }
          if (event.type === "error") {
            runtimeProbe.fail(
              new Error(`The voice provider returned an error event: ${event.raw}`),
            );
          } else if (event.type === "response.done") {
            const decoded = JSON.parse(event.raw) as {
              response?: { id?: unknown; status?: unknown };
            };
            providerResponseOutcomes.push({
              id: typeof decoded.response?.id === "string" ? decoded.response.id : null,
              observedAtMonotonicMs: performance.now(),
              status: typeof decoded.response?.status === "string" ? decoded.response.status : null,
            });
            providerResponsesDone += 1;
            providerResponseDoneAtMonotonicMs.push(performance.now());
            conversationRecorder?.recordEvent("provider.response.done", {
              response: providerResponsesDone,
            });
            providerResponseDone.resolve();
            resolvePendingVoiceProgress();
            maybeCompletePhysicalConversation();
          }
        },
        pcmDeviceClockedInitialBurstFrames:
          options.downlinkDeliveryMode === "device-clocked"
            ? (options.deviceClockedStartupFrames ?? 8)
            : undefined,
        pcmDownlinkDeliveryMode: options.downlinkDeliveryMode,
        pcmFrameBytes,
        pcmInputMode: "push-to-talk",
        pcmMinimumDownlinkStartupFrames:
          options.downlinkDeliveryMode === "device-clocked"
            ? deviceClockedSourceStartupFrames
            : undefined,
      }
    : undefined;
  const server = new LocalDevicePeerServer(peer, voiceServerOptions);
  const maximumRetainedBridgeEvents = 64;
  const bridgeOpenEvents: LocalFetchWebSocketBridgeOpenEvent[] = [];
  const bridgeCloseEvents: Array<{
    closedAtMonotonicMs: number;
    metrics: LocalFetchWebSocketBridgeMetrics;
  }> = [];
  let bridgeHistoryTruncated = false;
  let latestCapabilityMetrics: DeviceRuntimeMetrics | undefined;
  let directLanServer: LocalFetchWebSocketServer | undefined;
  let serialMonitor: PythonSerialMonitor | undefined;
  let tunnel: CaptunTunnel | undefined;
  let autonomousAcousticCapture: MacOsPcm16Capture | undefined;
  let autonomousAcousticRecording: CompletedPcm16Capture | undefined;
  let autonomousFinalVoiceMetrics: DeviceRuntimeMetrics | undefined;
  let autonomousNetworkBaseline: DeviceRuntimeMetrics | undefined;
  let autonomousNetworkCapture: PhysicalNetworkMonitorCapture | undefined;
  let autonomousNetworkMonitor: PhysicalNetworkRunMonitor | undefined;
  let autonomousNetworkMeasurement: ReturnType<typeof measureRemoteDnsAndTlsConnect> | undefined;
  let autonomousNetworkArtifactPath: string | undefined;
  let autonomousRunPassed = false;
  let terminalRunError: unknown;

  try {
    let peerBaseUrl: string;
    if (options.directLanHost) {
      /*
       * This route deliberately reuses the exact same fetch handler and peer
       * state as Captun. Only the runtime transport changes. That makes a
       * direct-LAN pass meaningful: it isolates Internet tunnel cadence
       * without proving a friendlier authentication/proxy implementation.
       */
      directLanServer = await LocalFetchWebSocketServer.listen({
        fetch: (request) => server.fetch(request),
        host: options.directLanHost,
        /*
         * This is one terminal aggregate per socket generation, not a PCM-frame
         * log. It lets a retained endurance artifact distinguish proxy pacing
         * from host TCP backpressure while keeping memory and console work
         * independent of playback duration.
         */
        onBridgeClosed: (metrics) => {
          if (bridgeCloseEvents.length === maximumRetainedBridgeEvents) {
            bridgeCloseEvents.shift();
            bridgeHistoryTruncated = true;
          }
          bridgeCloseEvents.push({
            closedAtMonotonicMs: performance.now(),
            metrics,
          });
          console.log(`direct_lan_bridge_metrics=${JSON.stringify(metrics)}`);
        },
        onBridgeOpened: (event) => {
          if (bridgeOpenEvents.length === maximumRetainedBridgeEvents) {
            bridgeOpenEvents.shift();
            bridgeHistoryTruncated = true;
          }
          bridgeOpenEvents.push(event);
          console.log(`direct_lan_bridge_open=${JSON.stringify(event)}`);
        },
        port: options.directLanPort,
      });
      peerBaseUrl = directLanServer.baseUrl;
      console.log(`direct_lan_ready url=${peerBaseUrl}`);
    } else {
      if (!captunToken) {
        throw new Error("Captun transport selected without a CAPTUN_TOKEN.");
      }
      tunnel = await createCaptunTunnel({
        fetch: (request) => server.fetch(request),
        gateway: options.gateway,
        name: options.tunnelName,
        token: captunToken,
      });
      peerBaseUrl = tunnel.url;
      console.log(`tunnel_ready url=${peerBaseUrl}`);
    }

    if (options.flash) {
      console.log(
        `flashing device=${validatedFlashOptions.port} build=${validatedFlashOptions.buildDirectory}`,
      );
      await flashLocalM5StickS3(
        [...options.flashArgs, "--base-url", peerBaseUrl],
        deviceEnvironment,
        workingDirectory,
      );
      console.log("flash_verified");
    } else if (provisioning.baseUrl !== new URL(peerBaseUrl).origin) {
      /*
       * Reusing the stored key against a different tunnel would still leave
       * the device dialing its old origin. Fail before the mount timeout so a
       * no-flash repetition can never masquerade as a network or Cap'n Web
       * compatibility failure.
       */
      throw new Error(
        `The no-flash device is provisioned for ${provisioning.baseUrl}, ` +
          `but this run opened ${new URL(peerBaseUrl).origin}.`,
      );
    }

    if (environment.ITERATE_KIT_SERIAL_DIAGNOSTICS === "1") {
      serialMonitor = await PythonSerialMonitor.open({
        onError: (error) => runtimeProbe.fail(error),
        onLine: (line) => {
          if (environment.ITERATE_KIT_VERBOSE_SERIAL === "1") {
            console.log(`device_serial=${line}`);
          }
          runtimeProbe.observeLine(line);
        },
        port: validatedFlashOptions.port,
        pythonExecutable: environment.ITERATE_KIT_PYTHON,
      });
      console.log(`serial_monitor_ready port=${validatedFlashOptions.port}`);
    }

    const mounted = await runtimeProbe.race(
      withTimeout(
        peer.waitForMount(),
        options.mountTimeoutMs,
        "Timed out waiting for the M5StickS3 to authenticate and mount.",
      ),
    );
    /*
     * Recurring metric callbacks belong to this exact Cap'n Web generation.
     * If it is replaced, the new generation is useful only as a bounded
     * diagnostic reader: an unexplained reconnect still fails the endurance
     * run instead of silently resubscribing and hiding the outage.
     */
    const controlMountOutcome = observeControlMountOutcome({
      mount: mounted,
      peer,
    });
    void controlMountOutcome
      .then((outcome) => {
        if (outcome.kind !== "replaced") return;
        console.error(
          `control_reconnect_diagnostics=${JSON.stringify({
            ...outcome,
            diagnostics: outcome.diagnostics,
          })}`,
        );
        runtimeProbe.fail(
          new Error(
            `Control Cap'n Web mount generation ${outcome.previousGeneration} ` +
              `was unexpectedly replaced by generation ${outcome.replacementGeneration}; ` +
              `ESP WebSocket error=${outcome.errorTypeName} ` +
              `(${outcome.diagnostics.control.lastErrorType}).`,
          ),
        );
      })
      .catch((error: unknown) => {
        console.error(
          `control_reconnect_diagnostics_error=${JSON.stringify({
            generation: mounted.generation,
            message: error instanceof Error ? error.message : String(error),
          })}`,
        );
        runtimeProbe.fail(
          new Error(
            `Control Cap'n Web mount generation ${mounted.generation} was replaced, ` +
              "but retained transport diagnostics could not be recovered.",
            { cause: error },
          ),
        );
      });
    const description = await mounted.device.__describe();
    console.log(
      `device_mounted path=${mounted.path.join(".")} capabilities=${Object.keys(description.children).join(",")}`,
    );
    await mounted.device.subscribeToMetrics((metrics) => {
      latestCapabilityMetrics =
        runtimeProbe.observeCapabilityMetrics(metrics) ?? latestCapabilityMetrics;
      if (environment.ITERATE_KIT_VERBOSE_METRICS === "1") {
        /*
         * The capability callback already paid the device-side cost of one
         * coherent snapshot. Echoing that sample on the host adds no firmware
         * queue or history and gives a failed physical run the second-by-second
         * evidence needed to identify the first diverging counter.
         */
        console.log(`capability_runtime_metrics_sample=${JSON.stringify(metrics)}`);
      }
    });
    await mounted.device.subscribeToPlaybackMetrics((metrics) => {
      runtimeProbe.observePlaybackMetrics(metrics);
      if (environment.ITERATE_KIT_VERBOSE_METRICS === "1") {
        console.log(`playback_runtime_metrics_sample=${JSON.stringify(metrics)}`);
      }
    });
    const firstCapabilityMetrics = await runtimeProbe.race(
      withTimeout(
        runtimeProbe.waitForMetrics(
          "capability",
          (metrics) =>
            hasCapabilityResourceEvidence(metrics) &&
            (!options.voice || hasCapabilityAudioEvidence(metrics)),
        ),
        30_000,
        "Timed out waiting for the device metrics callback.",
      ),
    );
    const firstPlaybackMetrics = await runtimeProbe.race(
      withTimeout(
        runtimeProbe.waitForMetrics("playback-detail", (metrics) =>
          m5StickS3PlaybackEnduranceRequiredMetrics.every(
            (name) => typeof metrics[name] === "number",
          ),
        ),
        30_000,
        "Timed out waiting for the detailed playback metrics callback.",
      ),
    );
    console.log(`playback_runtime_metrics=${JSON.stringify(firstPlaybackMetrics)}`);
    if (options.deterministicPlayback) {
      /*
       * The final acoustic and endurance judges still decide acceptance, but
       * an explicit no-loss counter increase already proves this run failed.
       * Arm the gate before starting the recorder/provider so the failure
       * artifact ends near the incident instead of growing until the generic
       * response timeout. Deltas intentionally permit historical incidents
       * from an earlier run on the same boot.
       */
      runtimeProbe.armPlaybackCounterPolicy(
        firstPlaybackMetrics,
        options.playbackRecoveryProof
          ? playbackRecoverySafetyMaximumDeltas(
              m5StickS3PlaybackEnduranceAcceptancePolicy.thresholds.counterMaximumDeltas,
            )
          : m5StickS3PlaybackEnduranceAcceptancePolicy.thresholds.counterMaximumDeltas,
      );
    }
    if (options.playbackEndurance) {
      /*
       * The canonical runner is deliberately wired into the real mounted
       * device path before its complete runtime adapter exists. In particular,
       * the public capability cannot yet attest stable running identity,
       * firmware SHA, per-descriptor playback telemetry, exact applied load,
       * or physical recording ownership. Supplying an empty partial adapter
       * makes the named first missing operation fail closed; filling any of
       * those fields from host intent or aggregate metrics would manufacture
       * acceptance evidence.
       */
      const completed = await runM5StickS3PlaybackEnduranceMode({
        outputRoot: environment.ITERATE_KIT_PLAYBACK_ENDURANCE_OUTPUT_DIRECTORY,
        runtime: {},
      });
      console.log(
        `playback_endurance_complete acceptance=${completed.result.acceptancePassed} ` +
          `manifests=${completed.manifestsPath} raw_metrics=${completed.rawMetricsPath}`,
      );
      return;
    }
    if (voiceServerOptions) {
      await runtimeProbe.race(
        withTimeout(
          pcmSessionReady.promise,
          30_000,
          "Timed out waiting for the independent PCM transport.",
        ),
      );
    }
    console.log(
      `device_transports_ready control=ready pcm=${voiceServerOptions ? "ready" : "not-required"}`,
    );
    console.log(`capability_runtime_metrics=${JSON.stringify(firstCapabilityMetrics)}`);

    if (options.physicalVoiceTurns !== undefined) {
      const expectedPhysicalVoiceTurns = options.physicalVoiceTurns;
      if (!conversationRecorder || !conversationOutputDirectory) {
        throw new Error("Physical conversation started without its PCM recorder.");
      }
      let acceptingPhysicalTurns = false;
      let acousticCapture: MacOsPcm16Capture | undefined;
      let acousticCaptureFinished = false;
      let acousticRecording: CompletedPcm16Capture | undefined;
      let audioRunError: unknown;
      let audioRunPassed = false;
      let finalVoiceMetrics: DeviceRuntimeMetrics | undefined;
      let networkCapture: PhysicalNetworkMonitorCapture | undefined;
      let networkMonitor: PhysicalNetworkRunMonitor | undefined;
      const networkArtifactPath = join(
        conversationOutputDirectory,
        "physical-network-validity.json",
      );
      let recording: PcmConversationRecordingSummary | undefined;
      const bridgeOperations = new Set<Promise<void>>();
      const retainRunError = (error: unknown, message: string) => {
        audioRunError =
          audioRunError === undefined ? error : new AggregateError([audioRunError, error], message);
      };
      const trackBridgeOperation = (operation: Promise<boolean>, event: string) => {
        let tracked: Promise<void>;
        tracked = operation
          .then((accepted) => {
            if (!accepted) {
              runtimeProbe.fail(new Error(`Userspace rejected physical ${event}.`));
            }
          })
          .catch((error: unknown) => {
            runtimeProbe.fail(
              new Error(`Userspace failed physical ${event}.`, {
                cause: error,
              }),
            );
          })
          .finally(() => bridgeOperations.delete(tracked));
        bridgeOperations.add(tracked);
      };
      const recordPhysicalEvent = (event: DeviceEvent) => {
        if (event.snapshot === true || event.source !== "physical") return;
        if (!acceptingPhysicalTurns) {
          conversationRecorder.recordEvent("physical-event.ignored", {
            sequence: event.sequence,
            source: event.source,
            type: event.type,
          });
          console.log(`physical_voice_event_ignored type=${event.type} reason=not-armed`);
          return;
        }
        if (event.type === "pushToTalk.started") {
          physicalConversationStarts += 1;
          if (physicalConversationStarts > expectedPhysicalVoiceTurns) {
            runtimeProbe.fail(
              new Error(
                `Received unexpected physical turn ${physicalConversationStarts}; ` +
                  `this run requested ${options.physicalVoiceTurns}.`,
              ),
            );
            return;
          }
          conversationRecorder.recordEvent(event.type, {
            sequence: event.sequence,
            source: event.source,
            turn: physicalConversationStarts,
          });
          console.log(`physical_voice_turn_started turn=${physicalConversationStarts}`);
        } else if (event.type === "pushToTalk.stopped") {
          physicalConversationStops += 1;
          conversationRecorder.recordEvent(event.type, {
            sequence: event.sequence,
            source: event.source,
            turn: physicalConversationStops,
          });
          console.log(`physical_voice_turn_stopped turn=${physicalConversationStops}`);
          maybeCompletePhysicalConversation();
        }
      };
      const speakThroughStick = async (label: string, exactText: string) => {
        const providerTarget = providerResponsesDone + 1;
        const downlinkTarget = downlinkResponsesCompleted + 1;
        const playbackBaseline = latestCapabilityMetrics ?? firstCapabilityMetrics;
        const speakerFrameBaseline = speakerDownlinkFramesObserved;
        conversationRecorder.recordEvent("operator-cue.started", { exactText, label });
        if (!(await server.requestVoiceText(`Say exactly: ${exactText}`))) {
          throw new Error(`The userspace bridge rejected the ${label} spoken cue.`);
        }
        await waitForVoiceProgress({
          downlinkTarget,
          message: `Timed out waiting for the ${label} spoken cue from Grok.`,
          providerTarget,
        });
        const expectedSpeakerFrames = speakerDownlinkFramesObserved - speakerFrameBaseline;
        if (expectedSpeakerFrames <= 0) {
          throw new Error(`The ${label} spoken cue completed without a PCM frame.`);
        }
        const metrics = await runtimeProbe.race(
          withTimeout(
            runtimeProbe.waitForMetrics("capability", (candidate) =>
              devicePlaybackResponseCompleted(playbackBaseline, candidate, expectedSpeakerFrames),
            ),
            voiceResponseTimeoutMs,
            `Timed out waiting for the ${label} cue to drain from the Stick speaker.`,
          ),
        );
        console.log(
          `voice_frame_conservation phase=${label} expected=${expectedSpeakerFrames} ` +
            `host_observed=${speakerDownlinkFramesObserved - speakerFrameBaseline} device=exact`,
        );
        conversationRecorder.recordEvent("operator-cue.completed", { exactText, label });
        return metrics;
      };
      const captureNetworkEvidence = async () => {
        if (!networkMonitor || networkCapture) return;
        networkCapture = await networkMonitor.capture();
      };
      try {
        acousticCapture = await MacOsPcm16Capture.start({
          identityFfmpegExecutable: environment.ITERATE_KIT_FFMPEG,
          input: environment.ITERATE_KIT_ACOUSTIC_INPUT,
          outputDirectory: conversationOutputDirectory,
          recorderExecutable: environment.ITERATE_KIT_SOX,
        });
        activeAcousticCapture = acousticCapture;
        console.log(
          `conversation_acoustic_capture_ready path=${acousticCapture.artifactPath} ` +
            `sample_rate_hz=${acousticCapture.sampleRateHz}`,
        );
        if (options.directLanHost) {
          const pcmOpen = bridgeOpenEvents.findLast((event) => event.endpoint === "/pcm");
          const remoteAddress = pcmOpen?.remoteAddress;
          if (!remoteAddress) {
            throw new Error(
              "The PCM bridge opened without a device address; exact network attribution is impossible.",
            );
          }
          const deviceHost = normalizeSocketHost(remoteAddress);
          const routerHost = await discoverDarwinDefaultGateway();
          networkMonitor = new PhysicalNetworkRunMonitor({
            deviceHost,
            diagnostics: async () =>
              parseKitControlDiagnostics(await mounted.device.getDiagnostics()),
            routerHost,
            workerHost: options.directLanHost,
          });
          networkMonitor.start();
          console.log(
            `physical_network_monitor_started device=${deviceHost} router=${routerHost} ` +
              `worker=${options.directLanHost} artifact=${networkArtifactPath}`,
          );
        } else {
          console.log(
            "physical_network_monitor_unavailable reason=device-address-hidden-by-tunnel",
          );
        }
        await subscribePcmBridgeToDeviceEvents(
          mounted.device,
          {
            inputStarted() {
              if (acceptingPhysicalTurns) {
                trackBridgeOperation(server.inputStarted(), "pushToTalk.started");
              }
              return true;
            },
            inputStopped() {
              if (acceptingPhysicalTurns) {
                trackBridgeOperation(server.inputStopped(), "pushToTalk.stopped");
              }
              return true;
            },
            setConversationActive() {
              /*
               * This local deterministic server is created before the device
               * connects and has no disposable upstream provider. Production
               * uses this callback to create/retire Grok while preserving the
               * warm device lane; here the event is still retained by
               * recordPhysicalEvent, but no server resource needs toggling.
               */
              return true;
            },
          },
          "push-to-talk",
          (diagnostic) => {
            runtimeProbe.fail(
              new Error(`Physical device event subscription failed: ${JSON.stringify(diagnostic)}`),
            );
          },
          recordPhysicalEvent,
        );

        /*
         * The human operator is beside the device, not watching this process.
         * A console-only instruction previously caused an apparent fourth-turn
         * audio failure after the finite three-turn harness had already torn
         * down. Put both lifecycle boundaries through the device speaker so a
         * missing reply cannot be confused with an invisible test boundary.
         */
        await speakThroughStick("attention", "Attention; the voice test is about to begin.");
        await speakThroughStick(
          "ready",
          `Ready for ${expectedPhysicalVoiceTurns} ${
            expectedPhysicalVoiceTurns === 1 ? "turn" : "turns"
          }; hold the button, speak, then release.`,
        );
        const conversationPlaybackBaseline = structuredClone(
          latestCapabilityMetrics ?? firstCapabilityMetrics,
        );
        const conversationSpeakerFrameBaseline = speakerDownlinkFramesObserved;
        physicalConversationProviderResponseBaseline = providerResponsesDone;
        physicalConversationDownlinkResponseBaseline = downlinkResponsesCompleted;
        acceptingPhysicalTurns = true;
        conversationRecorder.recordEvent("conversation.started", {
          expectedTurns: expectedPhysicalVoiceTurns,
          transport: options.directLanHost ? "direct-lan" : "captun",
        });
        console.log(
          `physical_conversation_ready turns=${expectedPhysicalVoiceTurns} ` +
            "recording=enabled instruction=spoken-through-stick",
        );
        await runtimeProbe.race(
          withTimeout(
            physicalConversationComplete.promise,
            10 * 60_000,
            `Timed out waiting for ${expectedPhysicalVoiceTurns} physical voice turns.`,
          ),
        );
        acceptingPhysicalTurns = false;
        await Promise.all(bridgeOperations);
        const expectedConversationSpeakerFrames =
          speakerDownlinkFramesObserved - conversationSpeakerFrameBaseline;
        if (expectedConversationSpeakerFrames <= 0) {
          throw new Error("The physical conversation completed without a speaker PCM frame.");
        }
        finalVoiceMetrics = await runtimeProbe.race(
          withTimeout(
            runtimeProbe.waitForMetrics("capability", (metrics) =>
              devicePlaybackResponseCompleted(
                conversationPlaybackBaseline,
                metrics,
                expectedConversationSpeakerFrames,
              ),
            ),
            voiceResponseTimeoutMs,
            "Timed out waiting for exact physical-conversation frame conservation through the Stick speaker.",
          ),
        );
        console.log(
          `voice_frame_conservation phase=physical-conversation ` +
            `expected=${expectedConversationSpeakerFrames} ` +
            `host_observed=${speakerDownlinkFramesObserved - conversationSpeakerFrameBaseline} ` +
            "device=exact",
        );
        const conversationDownlinkResponsesCompleted =
          downlinkResponsesCompleted - physicalConversationDownlinkResponseBaseline;
        const conversationProviderResponsesDone =
          providerResponsesDone - physicalConversationProviderResponseBaseline;
        finalVoiceMetrics = await speakThroughStick("complete", "Test complete; you can stop now.");
        conversationRecorder.recordEvent("conversation.completed", {
          downlinkResponsesCompleted: conversationDownlinkResponsesCompleted,
          providerResponsesDone: conversationProviderResponsesDone,
          turns: physicalConversationStops,
        });
        await delay(acousticCaptureTailMs);
        await Promise.all(acousticMarkerTasks);
        acousticRecording = await acousticCapture.stop();
        acousticCaptureFinished = true;
        activeAcousticCapture = undefined;
        console.log(
          `conversation_acoustic_capture=${JSON.stringify({
            artifactPath: acousticRecording.artifactPath,
            capturedByteLength: acousticRecording.capturedByteLength,
            capturedSampleCount: acousticRecording.capturedSampleCount,
            captureProvenance: acousticRecording.captureProvenance,
            sampleRateHz: acousticRecording.sampleRateHz,
          })}`,
        );
        audioRunPassed = true;
      } catch (error) {
        retainRunError(error, "The physical conversation failed more than once.");
      } finally {
        acceptingPhysicalTurns = false;
        if (acousticCapture && !acousticCaptureFinished) {
          try {
            await Promise.all(acousticMarkerTasks);
            acousticRecording = await acousticCapture.stop();
            acousticCaptureFinished = true;
            activeAcousticCapture = undefined;
            console.log(
              `conversation_acoustic_capture_preserved path=${acousticRecording.artifactPath} ` +
                `samples=${acousticRecording.capturedSampleCount}`,
            );
          } catch (error) {
            retainRunError(
              error,
              "The physical conversation and its acoustic recorder both failed.",
            );
          }
        }
        if (networkMonitor && !networkCapture) {
          try {
            await captureNetworkEvidence();
          } catch (error) {
            retainRunError(
              error,
              "The physical conversation and its terminal network capture both failed.",
            );
          }
        }
        try {
          recording = await conversationRecorder.close();
          conversationRecorderClosed = true;
          console.log(`pcm_conversation_recording=${JSON.stringify(recording)}`);
        } catch (error) {
          retainRunError(error, "The physical conversation and its recorder both failed.");
        }
      }
      if (recording && !recording.complete) {
        retainRunError(
          new Error(`PCM conversation recording was incomplete: ${recording.failure}.`),
          "The physical conversation and its recorder both failed.",
        );
      }
      if (networkCapture) {
        const artifact = buildPhysicalNetworkRunArtifact({
          ...networkCapture,
          audio: {
            failure:
              audioRunError === undefined
                ? null
                : audioRunError instanceof Error
                  ? audioRunError.message
                  : String(audioRunError),
            passed: audioRunPassed && recording?.complete === true,
          },
          pcmEvidence: {
            bridgeEvidence: snapshotPhysicalNetworkBridgeEvidence({
              closeEvents: bridgeCloseEvents,
              historyTruncated: bridgeHistoryTruncated,
              openEvents: bridgeOpenEvents,
            }),
            kind: "local-bridge",
            progress: physicalNetworkProgress(firstCapabilityMetrics, finalVoiceMetrics),
          },
        });
        await writePhysicalNetworkRunArtifact(networkArtifactPath, artifact);
        console.log(
          `physical_network_validity=${JSON.stringify({
            artifactPath: networkArtifactPath,
            classification: artifact.classification,
            reasons: artifact.network.reasons,
            verdict: artifact.network.verdict,
          })}`,
        );
        if (audioRunError === undefined && artifact.classification !== "valid") {
          audioRunError = new Error(
            `Physical conversation completed, but its network evidence was ` +
              `${artifact.classification}. See ${networkArtifactPath}.`,
          );
        }
      }
      if (audioRunError !== undefined) throw audioRunError;
      if (!recording || !finalVoiceMetrics) {
        throw new Error("Physical conversation ended without complete terminal evidence.");
      }
      console.log(`capability_voice_metrics=${JSON.stringify(finalVoiceMetrics)}`);
      console.log(
        `device_conversation_passed physical=true turns=${expectedPhysicalVoiceTurns} ` +
          `provider=grok recording=${recording.outputDirectory} ` +
          `acoustic=${acousticRecording?.artifactPath ?? "not-captured"} ` +
          `network=${networkCapture ? "valid" : "not-captured"}`,
      );
      return;
    }

    if (options.grokPlaybackOnly || options.deterministicPlayback) {
      const provider = options.deterministicPlayback
        ? `deterministic-${options.deterministicPlayback}`
        : "grok";
      const expectedPlaybackFrames = options.deterministicPlayback
        ? options.playbackDurationMs / pcmFrameDurationMs
        : undefined;
      const acousticCapture = options.deterministicPlayback
        ? await MacOsPcm16Capture.start({
            identityFfmpegExecutable: environment.ITERATE_KIT_FFMPEG,
            input: environment.ITERATE_KIT_ACOUSTIC_INPUT,
            outputDirectory: environment.ITERATE_KIT_ACOUSTIC_OUTPUT_DIRECTORY,
            recorderExecutable: environment.ITERATE_KIT_SOX,
          })
        : undefined;
      let acousticCaptureFinished = false;
      let controlChurnSummary: BoundedCapabilityChurnSummary | undefined;
      let recoveryProofAssessment:
        | Extract<PlaybackRecoveryProofAssessment, { kind: "healthy" }>
        | undefined;
      let audioRunError: unknown;
      let audioRunPassed = false;
      let networkCapture: PhysicalNetworkMonitorCapture | undefined;
      let networkMonitor: PhysicalNetworkRunMonitor | undefined;
      let networkArtifactPath: string | undefined;
      const controlChurn =
        options.controlChurnHz === undefined
          ? undefined
          : new BoundedCapabilityChurn({
              cyclesPerSecond: options.controlChurnHz,
              /*
               * Four nominal periods lets a cycle span ordinary control-task
               * scheduling jitter, while one second remains a hard bound at
               * high rates. A stuck Cap'n Web promise must not extend a
               * physical audio run indefinitely.
               */
              operationTimeoutMs: Math.max(1_000, Math.ceil(4_000 / options.controlChurnHz)),
              onFailure: (error) => {
                const failure = new Error(
                  `Bounded control capability churn failed: ${error.message}`,
                  { cause: error },
                );
                /*
                 * BoundedCapabilityChurn has already stopped scheduling here,
                 * so no stale RPC backlog can grow. Keep only the surrounding
                 * server/device session alive long enough for the transport's
                 * bounded reconnect to expose its fixed latest-state snapshot.
                 * The original load failure remains terminal regardless of
                 * whether diagnostics arrive.
                 */
                void settleControlMountOutcome({
                  outcome: controlMountOutcome,
                }).then((settlement) => {
                  console.error(
                    `control_failure_diagnostic_grace=${JSON.stringify(
                      settlement.kind === "observation-failed"
                        ? {
                            kind: settlement.kind,
                            message:
                              settlement.error instanceof Error
                                ? settlement.error.message
                                : String(settlement.error),
                          }
                        : settlement,
                    )}`,
                  );
                  runtimeProbe.fail(failure);
                });
              },
              /*
               * One work unit has one unambiguous completion boundary: a real
               * getDiagnostics call that samples and serializes fresh fixed-
               * buffer device state. Repeating static __describe() here made
               * a timeout impossible to attribute and doubled a synthetic
               * workload that production does not need. Description dispatch
               * belongs in its own benchmark; this runner admits only one
               * diagnostics operation so slowdown is reported as skipped load
               * rather than an RPC backlog competing with fresh PCM.
               */
              operation: async () => {
                parseKitControlDiagnostics(await mounted.device.getDiagnostics());
              },
            });
      const stopControlChurn = async (judgeAppliedLoad: boolean) => {
        if (!controlChurn) return;
        const summary = await controlChurn.stop();
        if (!controlChurnSummary) {
          controlChurnSummary = summary;
          console.log(`control_capability_churn_summary=${JSON.stringify(summary)}`);
        }
        if (!judgeAppliedLoad) return;
        const assessment = assessBoundedCapabilityChurn(summary, 0.9);
        console.log(`control_capability_churn_assessment=${JSON.stringify(assessment)}`);
        if (assessment.kind === "failure") {
          throw new Error(`Control capability load was not applied: ${assessment.reason}`);
        }
      };
      const prompt =
        environment.ITERATE_KIT_VOICE_PHRASE ??
        "Say exactly: Grok audio is playing directly on the Iterate device.";
      if (acousticCapture) {
        activeAcousticCapture = acousticCapture;
        console.log(
          `acoustic_capture_ready path=${acousticCapture.artifactPath} ` +
            `sample_rate_hz=${acousticCapture.sampleRateHz}`,
        );
        console.log(
          `acoustic_capture_provenance=${JSON.stringify(acousticCapture.captureProvenance)}`,
        );
        if (acousticChallenge) {
          const sourceIdentity = computeDualCarrierPrbs31Pcm16SourceIdentity({
            challenge: acousticChallenge,
            durationMs: options.playbackDurationMs,
          });
          console.log(
            `acoustic_source_identity=${JSON.stringify({
              ...sourceIdentity,
              challenge: acousticChallenge,
            })}`,
          );
        }
      }
      const captureNetworkEvidence = async () => {
        if (!networkMonitor || networkCapture) return;
        networkCapture = await networkMonitor.capture();
      };
      try {
        if (options.directLanHost) {
          const pcmOpen = bridgeOpenEvents.findLast((event) => event.endpoint === "/pcm");
          const remoteAddress = pcmOpen?.remoteAddress;
          if (!remoteAddress) {
            throw new Error(
              "The PCM bridge opened without a device address; exact network attribution is impossible.",
            );
          }
          const deviceHost = normalizeSocketHost(remoteAddress);
          const routerHost = await discoverDarwinDefaultGateway();
          networkArtifactPath = await createPhysicalNetworkArtifactPath({
            acousticArtifactPath: acousticCapture?.artifactPath,
            outputRoot: environment.ITERATE_KIT_NETWORK_EVIDENCE_OUTPUT_DIRECTORY,
          });
          networkMonitor = new PhysicalNetworkRunMonitor({
            deviceHost,
            diagnostics: async () =>
              parseKitControlDiagnostics(await mounted.device.getDiagnostics()),
            routerHost,
            workerHost: options.directLanHost,
          });
          networkMonitor.start();
          console.log(
            `physical_network_monitor_started device=${deviceHost} router=${routerHost} ` +
              `worker=${options.directLanHost} artifact=${networkArtifactPath}`,
          );
        } else {
          /*
           * Captun does not expose the device-side TCP peer address to this
           * process. Calling that interval network-valid would invent a
           * reachability lane. Production userspace gets its own worker-side
           * socket/DNS observations; this local harness only makes a verdict
           * when the direct-LAN bridge supplies all three real hosts.
           */
          console.log(
            "physical_network_monitor_unavailable reason=device-address-hidden-by-tunnel",
          );
        }
        if (controlChurn) {
          controlChurn.start();
          console.log(
            `control_capability_churn_started work_unit=getDiagnostics ` +
              `cycles_per_second=${options.controlChurnHz}`,
          );
        }
        console.log(
          `voice_prompt_injection_started source=${provider}` +
            (expectedPlaybackFrames === undefined
              ? ""
              : ` duration_ms=${options.playbackDurationMs} ` +
                `expected_frames=${expectedPlaybackFrames}`),
        );
        const providerRequestMarker = await recordAcousticMarker("provider.request.before");
        if (acousticCapture && providerRequestMarker === undefined) {
          throw new Error(
            "The acoustic capture was active but its provider-request marker was unavailable.",
          );
        }
        if (!(await server.requestVoiceText(prompt))) {
          throw new Error("The PCM proxy did not accept the direct provider turn.");
        }
        await recordAcousticMarker("provider.request.accepted");
        console.log(`voice_prompt_injection_complete source=${provider}`);
        let playbackMetrics: DeviceRuntimeMetrics;
        if (options.playbackRecoveryProof && expectedPlaybackFrames !== undefined) {
          /*
           * Recovery intentionally discards the source frame whose physical
           * slot was replaced by silence. The ordinary exact-completion gate
           * therefore cannot reach `expectedPlaybackFrames`; waiting on it
           * would turn a healthy recovery into a generic timeout. Instead,
           * wait for both queues to drain and for the detailed schema-2
           * accounting to close content + discard + recovery + EOS exactly.
           */
          const [metrics, detailedMetrics] = await runtimeProbe.race(
            withTimeout(
              Promise.all([
                runtimeProbe.waitForMetrics("capability", (candidate) =>
                  devicePlaybackCompleted(firstCapabilityMetrics, candidate),
                ),
                runtimeProbe.waitForMetrics("playback-detail", (candidate) =>
                  playbackRecoveryIsComplete({
                    baseline: firstPlaybackMetrics,
                    current: candidate,
                    expectedContentFrames: expectedPlaybackFrames,
                  }),
                ),
                providerResponseDone.promise,
              ]).then(([capabilityMetrics, detailed]) => [capabilityMetrics, detailed] as const),
              options.playbackDurationMs + voiceResponseTimeoutMs,
              "Timed out waiting for bounded playback recovery to drain and conserve all frames.",
            ),
          );
          const assessment = assessPlaybackRecoveryProof({
            baseline: firstPlaybackMetrics,
            current: detailedMetrics,
            expectedContentFrames: expectedPlaybackFrames,
            safetyMaximumDeltas: playbackRecoverySafetyMaximumDeltas(
              m5StickS3PlaybackEnduranceAcceptancePolicy.thresholds.counterMaximumDeltas,
            ),
          });
          console.log(`playback_recovery_assessment=${JSON.stringify(assessment)}`);
          if (assessment.kind === "failure") {
            throw new Error(`Playback recovery proof failed: ${assessment.reasons.join("; ")}.`);
          }
          recoveryProofAssessment = assessment;
          playbackMetrics = metrics;
        } else {
          playbackMetrics = await runtimeProbe.race(
            withTimeout(
              Promise.all([
                providerResponseDone.promise,
                runtimeProbe.waitForMetrics("capability", (metrics) =>
                  expectedPlaybackFrames === undefined
                    ? devicePlaybackCompleted(firstCapabilityMetrics, metrics)
                    : devicePlaybackFramesCompleted(
                        firstCapabilityMetrics,
                        metrics,
                        expectedPlaybackFrames,
                      ),
                ),
              ]).then(([, metrics]) => metrics),
              expectedPlaybackFrames === undefined
                ? voiceResponseTimeoutMs
                : options.playbackDurationMs + voiceResponseTimeoutMs,
              "Timed out waiting for provider audio to be consumed by the Stick speaker queue.",
            ),
          );
        }
        await recordAcousticMarker("device.playback.completed");
        /*
         * Stop at physical queue completion, before the recorder's quiet tail.
         * The summary therefore describes only work that actually competed
         * with downlink playback, not easier post-audio cleanup traffic.
         */
        await stopControlChurn(true);
        console.log(`capability_playback_metrics=${JSON.stringify(playbackMetrics)}`);
        if (acousticCapture) {
          /*
           * Keep a short quiet tail after the device reports empty queues.
           * Besides protecting room-ring decay at the final edge, this catches
           * a dishonest completion metric that returns while DMA is still
           * audibly draining.
           */
          await delay(acousticCaptureTailMs);
          await recordAcousticMarker("capture.tail.completed");
          await Promise.all(acousticMarkerTasks);
          const recording = await acousticCapture.stop();
          acousticCaptureFinished = true;
          activeAcousticCapture = undefined;
          /*
           * Stop network sampling at the physical recording boundary. The
           * waveform analyzers below can do seconds of disk/CPU work, but that
           * offline work neither caused nor witnessed the audible interval and
           * must not dilute its Wi-Fi/socket classification.
           */
          await captureNetworkEvidence();
          const result = acousticChallenge
            ? (() => {
                const analysis = analyzeDualCarrierPrbs31Pcm16Artifact({
                  artifactPath: recording.artifactPath,
                  challenge: acousticChallenge,
                  expectedDurationMs: options.playbackDurationMs,
                  /*
                   * This diagnostic must retain a recorder/codec startup
                   * offset rather than failing before it can identify source
                   * loss. The acceptance ladder keeps the tighter bound.
                   */
                  maximumLeadingSilenceMs: 5_000,
                  sampleRateHz: recording.sampleRateHz,
                });
                return {
                  analysis,
                  assessment: assessDualCarrierPrbs31Analysis(analysis),
                  kind: "prbs31" as const,
                };
              })()
            : await (async () => {
                const analysis = await analyzeAcousticTonePcm16Artifact({
                  /*
                   * A full-level carrier fragment at file offset zero has
                   * appeared after back-to-back CoreAudio captures. Samples
                   * cannot distinguish it from this response. The marker was
                   * recorded before requesting this response, so it supplies
                   * the causal lower bound without selecting a convenient
                   * waveform episode or masking any later outage.
                   */
                  analysisStartMs:
                    providerRequestMarker === undefined
                      ? undefined
                      : (providerRequestMarker.capturedSampleCount * 1_000) /
                        providerRequestMarker.sampleRateHz,
                  artifactPath: recording.artifactPath,
                  expectedDurationMs: options.playbackDurationMs,
                  frequencyHz: deterministicToneFrequencyHz,
                  sampleRateHz: recording.sampleRateHz,
                });
                return {
                  analysis,
                  assessment: assessAcousticToneAnalysis(analysis, {
                    maximumAmplitudeStepDecibels: 1.5,
                    maximumAmplitudeStepP99Decibels: 1.5,
                    maximumDurationErrorMs: 200,
                    maximumInternalGapMs: 0,
                    maximumMissingToneMs: 200,
                    maximumPhaseStepErrorRadians: 0.1,
                  }),
                  kind: "tone" as const,
                };
              })();
          console.log(
            `acoustic_${result.kind}_analysis=${JSON.stringify({
              ...result.analysis,
              artifactPath: recording.artifactPath,
              assessment: result.assessment,
            })}`,
          );
          if (options.playbackRecoveryProof) {
            if (result.kind !== "tone" || !recoveryProofAssessment) {
              throw new Error("Playback recovery completed without matching tone evidence.");
            }
            const recoveryAcoustics = assessPlaybackRecoveryAcoustics({
              expectedDurationMs: options.playbackDurationMs,
              frameDurationMs: pcmFrameDurationMs,
              longestInternalGapMs: result.analysis.longestInternalGapMs,
              maximumDurationErrorMs: 200,
              /*
               * Five-millisecond overlapping windows and room decay make an
               * exact 20 ms silence appear a few milliseconds wider or
               * narrower. Keep that uncertainty explicit and far below one
               * additional protocol frame.
               */
              maximumUnattributedMissingToneMs: 10,
              missingToneMs: result.analysis.missingToneMs,
              observedSpanMs: result.analysis.observedSpanMs,
              recoveryFrameCount: recoveryProofAssessment.recoveryFrameCount,
            });
            console.log(
              `acoustic_playback_recovery_assessment=${JSON.stringify(recoveryAcoustics)}`,
            );
            if (recoveryAcoustics.kind === "failure") {
              throw new Error(
                `Physical playback recovery failed: ${recoveryAcoustics.reasons.join("; ")}.`,
              );
            }
          } else if (!result.assessment.passed) {
            throw new Error(
              `Physical playback continuity failed: ${result.assessment.reasons.join("; ")}.`,
            );
          }
        }
        await captureNetworkEvidence();
        audioRunPassed = true;
      } catch (error) {
        audioRunError = error;
      } finally {
        if (networkMonitor && !networkCapture) {
          try {
            await captureNetworkEvidence();
          } catch (error) {
            audioRunError =
              audioRunError === undefined
                ? error
                : new AggregateError(
                    [audioRunError, error],
                    "The physical audio run and its terminal network capture both failed.",
                  );
          }
        }
        if (controlChurn && !controlChurnSummary) {
          try {
            await stopControlChurn(false);
          } catch (error) {
            console.error("Unable to finalize bounded control capability churn.", error);
          }
        }
        if (acousticCapture && !acousticCaptureFinished) {
          try {
            await Promise.all(acousticMarkerTasks);
            const recording = await acousticCapture.stop();
            activeAcousticCapture = undefined;
            console.log(
              `acoustic_capture_preserved path=${recording.artifactPath} ` +
                `samples=${recording.capturedSampleCount}`,
            );
          } catch (error) {
            console.error("Unable to finalize acoustic failure artifact.", error);
          }
        }
      }
      if (networkCapture && networkArtifactPath) {
        const artifact = buildPhysicalNetworkRunArtifact({
          ...networkCapture,
          audio: {
            failure:
              audioRunError === undefined
                ? null
                : audioRunError instanceof Error
                  ? audioRunError.message
                  : String(audioRunError),
            passed: audioRunPassed,
          },
          pcmEvidence: {
            bridgeEvidence: snapshotPhysicalNetworkBridgeEvidence({
              closeEvents: bridgeCloseEvents,
              historyTruncated: bridgeHistoryTruncated,
              openEvents: bridgeOpenEvents,
            }),
            kind: "local-bridge",
            progress: physicalNetworkProgress(firstCapabilityMetrics, latestCapabilityMetrics),
          },
        });
        await writePhysicalNetworkRunArtifact(networkArtifactPath, artifact);
        console.log(
          `physical_network_validity=${JSON.stringify({
            artifactPath: networkArtifactPath,
            classification: artifact.classification,
            reasons: artifact.network.reasons,
            verdict: artifact.network.verdict,
          })}`,
        );
        if (audioRunError === undefined && artifact.classification !== "valid") {
          audioRunError = new Error(
            `Physical audio completed, but its network evidence was ${artifact.classification}. ` +
              `See ${networkArtifactPath}.`,
          );
        }
      }
      if (audioRunError !== undefined) throw audioRunError;
      console.log(
        `device_playback_pipeline_observed provider=${provider} ` +
          `evidence=provider-events+capability-metrics ` +
          `acoustic=${acousticCapture ? "passed" : "external"} ` +
          `network=${networkCapture ? "valid" : "not-captured"}`,
      );
      return;
    }

    if (recordsAutonomousVoiceConversation) {
      if (!conversationRecorder || !conversationOutputDirectory) {
        throw new Error("Autonomous voice proof started without its PCM recorder.");
      }
      /*
       * Start the host microphone before the remote PTT edge. This recording
       * is an independent physical witness: the two exact PCM files prove the
       * digital lanes, while this artifact lets a later transcription or
       * waveform judge establish what actually left the Stick speaker. The
       * recorder writes to disk and never enters the firmware/audio queues.
       */
      autonomousAcousticCapture = await MacOsPcm16Capture.start({
        identityFfmpegExecutable: environment.ITERATE_KIT_FFMPEG,
        input: environment.ITERATE_KIT_ACOUSTIC_INPUT,
        outputDirectory: conversationOutputDirectory,
        recorderExecutable: environment.ITERATE_KIT_SOX,
      });
      activeAcousticCapture = autonomousAcousticCapture;
      console.log(
        `conversation_acoustic_capture_ready path=${autonomousAcousticCapture.artifactPath} ` +
          `sample_rate_hz=${autonomousAcousticCapture.sampleRateHz}`,
      );
      autonomousNetworkBaseline = structuredClone(
        latestCapabilityMetrics ?? firstCapabilityMetrics,
      );
      let deviceHost = options.networkDeviceHost;
      if (options.directLanHost) {
        const pcmOpen = bridgeOpenEvents.findLast((event) => event.endpoint === "/pcm");
        const remoteAddress = pcmOpen?.remoteAddress;
        if (!remoteAddress) {
          throw new Error(
            "The PCM bridge opened without a device address; exact network attribution is impossible.",
          );
        }
        deviceHost = normalizeSocketHost(remoteAddress);
      }
      if (deviceHost) {
        const routerHost = await discoverDarwinDefaultGateway();
        const workerHost = options.directLanHost ?? new URL(peerBaseUrl).hostname;
        /*
         * `--no-flash` reads the settings partition and resets the ESP. Its
         * outbound WebSockets can be established before this Mac refreshes its
         * ARP entry for the station, which made two otherwise exact runs fail
         * on only the first host-originated ping. Warm that setup-only path,
         * then open a new interval whose first and every subsequent probe keep
         * the original strict thresholds. These attempts are retained in the
         * conversation timeline; none are deleted from measured evidence.
         */
        const networkPreflight = await warmPhysicalNetworkReachability(deviceHost);
        conversationRecorder.recordEvent("physical-network.preflight", {
          attempts: networkPreflight.attempts,
          maximumHealthyRttMs: networkPreflight.maximumHealthyRttMs,
          passed: networkPreflight.passed,
          requiredConsecutiveHealthyReplies: networkPreflight.requiredConsecutiveHealthyReplies,
        });
        console.log(`physical_network_preflight=${JSON.stringify(networkPreflight)}`);
        if (!networkPreflight.passed) {
          throw new Error(
            `The device did not pass bounded post-mount reachability warm-up at ${deviceHost}.`,
          );
        }
        autonomousNetworkArtifactPath = join(
          conversationOutputDirectory,
          "physical-network-validity.json",
        );
        autonomousNetworkMonitor = new PhysicalNetworkRunMonitor({
          deviceHost,
          diagnostics: async () =>
            parseKitControlDiagnostics(await mounted.device.getDiagnostics()),
          routerHost,
          workerHost,
        });
        autonomousNetworkMonitor.start();
        if (!options.directLanHost) {
          /*
           * Start the public-origin DNS/TLS observation inside the same
           * interval as the reachability and device samplers. Captun hides the
           * device address at its fetch boundary, but it must not hide whether
           * the exact public origin was resolvable and connectable while the
           * conversation was being judged.
           */
          autonomousNetworkMeasurement = measureRemoteDnsAndTlsConnect(workerHost);
        }
        console.log(
          `physical_network_monitor_started device=${deviceHost} router=${routerHost} ` +
            `worker=${workerHost} artifact=${autonomousNetworkArtifactPath}`,
        );
      } else {
        console.log("physical_network_monitor_unavailable reason=device-host-not-provided");
      }
      conversationRecorder.recordEvent("autonomous-conversation.started", {
        input: "macos-say-through-device-microphone",
        mode: options.remoteInterruptionProof ? "interruption" : "sequential",
        transport: options.directLanHost ? "direct-lan" : "captun",
        turns: options.remoteInterruptionProof ? 2 : (options.remoteVoiceTurns ?? 1),
      });
    }

    if (options.remoteInterruptionProof) {
      const sequenceBaseline = structuredClone(latestCapabilityMetrics ?? firstCapabilityMetrics);
      const microphoneFrameBaseline = microphoneUplinkFramesObserved;
      const speakerFrameBaseline = speakerDownlinkFramesObserved;
      const providerResponseBaseline = providerResponsesDone;
      const downlinkResponseBaseline = downlinkResponsesCompleted;
      const firstTiming: AutonomousVoiceTurnTiming = { turn: 1 };
      activeAutonomousTurn = firstTiming;
      conversationRecorder?.recordEvent("autonomous-interruption.started", {
        baseline: sequenceBaseline,
        providerResponseBaseline,
      });

      const firstStarted = await runtimeProbe.race(mounted.device.pushToTalk.start());
      if (!firstStarted || !(await server.inputStarted())) {
        throw new Error("The first interruption-proof PTT epoch was not accepted.");
      }
      const firstPttStartedAtMonotonicMs = performance.now();
      console.log("remote_event=pushToTalk.started accepted=true phase=interrupted-response");
      const longReplyPrompt =
        "Recite the numbers one through twenty slowly, with a short pause between each number. " +
        "Do not stop early.";
      conversationRecorder?.recordEvent("autonomous-turn.prompt", {
        phrase: longReplyPrompt,
        turn: 1,
      });
      await executeFile(environment.ITERATE_KIT_SAY ?? "/usr/bin/say", [longReplyPrompt]);
      const firstHeldUplinkMetrics = await runtimeProbe.race(
        withTimeout(
          runtimeProbe.waitForMetrics("capability", (metrics) =>
            deviceUplinkStreaming(sequenceBaseline, metrics),
          ),
          5_000,
          "The first interruption-proof microphone epoch did not stream while held.",
        ),
      );
      await delay(options.remoteHoldMs);
      const firstStopped = await runtimeProbe.race(mounted.device.pushToTalk.stop());
      if (!firstStopped || !(await server.inputStopped())) {
        throw new Error("The first interruption-proof PTT release was not accepted.");
      }
      const firstPttStoppedAtMonotonicMs = performance.now();
      console.log("remote_event=pushToTalk.stopped accepted=true phase=interrupted-response");

      /*
       * Interrupt only after a meaningful prefix has crossed the real device
       * socket. Twenty frames are 400 ms of speech; with the eight-frame device
       * lead this guarantees an audible prefix while keeping the stale suffix
       * small. Waiting for response.done would test a second turn, not barge-in.
       */
      const minimumFirstReplyFrames = 20;
      await waitForObservedState(
        () => speakerDownlinkFramesObserved - speakerFrameBaseline >= minimumFirstReplyFrames,
        voiceResponseTimeoutMs,
        "Grok did not emit enough live reply PCM to exercise interruption.",
      );
      await delay(120);
      const firstReplyFramesAtInterruption = speakerDownlinkFramesObserved - speakerFrameBaseline;
      const interruptionRequestedAtMonotonicMs = performance.now();
      const secondTiming: AutonomousVoiceTurnTiming = { turn: 2 };
      activeAutonomousTurn = secondTiming;

      /*
       * Preserve the physical causal order: the device stops I2S and starts
       * capture before its semantic edge can tell userspace to cancel Grok.
       * Firmware continuously classifies any PCM crossing that narrow gap as
       * generation-flushed, so this remote proof exercises the same ordering
       * as Button A rather than a friendlier server-first shortcut.
       */
      const secondStarted = await runtimeProbe.race(mounted.device.pushToTalk.start());
      const deviceInterruptionAcceptedAtMonotonicMs = performance.now();
      if (!secondStarted || !(await server.inputStarted())) {
        throw new Error("The live Grok reply did not accept the interrupting PTT edge.");
      }
      const interruptionDeviceRpcMs =
        deviceInterruptionAcceptedAtMonotonicMs - interruptionRequestedAtMonotonicMs;
      if (interruptionDeviceRpcMs > 1_000) {
        throw new Error(
          `The device took ${interruptionDeviceRpcMs.toFixed(1)} ms to stop stale playback; ` +
            "the bounded interruption limit is 1000 ms.",
        );
      }
      conversationRecorder?.recordEvent("autonomous-interruption.edge", {
        deviceRpcMs: interruptionDeviceRpcMs,
        firstReplyFramesAtInterruption,
        requestedAtMonotonicMs: interruptionRequestedAtMonotonicMs,
      });
      console.log(
        `voice_interruption_edge device_rpc_ms=${interruptionDeviceRpcMs.toFixed(3)} ` +
          `speaker_frames_before_interrupt=${firstReplyFramesAtInterruption}`,
      );

      await waitForObservedState(
        () => providerResponsesDone >= providerResponseBaseline + 1,
        voiceResponseTimeoutMs,
        "Grok did not acknowledge cancellation of the interrupted response.",
      );
      const interruptedOutcome = providerResponseOutcomes[providerResponseBaseline];
      if (
        !interruptedOutcome ||
        !["canceled", "cancelled"].includes(interruptedOutcome.status ?? "")
      ) {
        throw new Error(
          `The interrupted Grok response ended as ${interruptedOutcome?.status ?? "unknown"}; ` +
            "expected an explicit canceled status.",
        );
      }

      const recoveryPrompt =
        "The previous answer was interrupted. Reply exactly: interruption successful.";
      conversationRecorder?.recordEvent("autonomous-turn.prompt", {
        phrase: recoveryPrompt,
        turn: 2,
      });
      await executeFile(environment.ITERATE_KIT_SAY ?? "/usr/bin/say", [recoveryPrompt]);
      const secondHeldUplinkMetrics = await runtimeProbe.race(
        withTimeout(
          runtimeProbe.waitForMetrics("capability", (metrics) =>
            deviceUplinkStreaming(firstHeldUplinkMetrics, metrics),
          ),
          5_000,
          "Microphone PCM did not remain live after interrupting the old reply.",
        ),
      );
      await delay(options.remoteHoldMs);
      const secondStopped = await runtimeProbe.race(mounted.device.pushToTalk.stop());
      if (!secondStopped || !(await server.inputStopped())) {
        throw new Error("The post-interruption PTT release was not accepted.");
      }
      const secondPttStoppedAtMonotonicMs = performance.now();
      console.log("remote_event=pushToTalk.stopped accepted=true phase=fresh-response");

      await waitForVoiceProgress({
        downlinkTarget: downlinkResponseBaseline + 1,
        message: "Timed out waiting for the fresh Grok response after interruption.",
        providerTarget: providerResponseBaseline + 2,
      });
      const expectedMicrophoneFrames = microphoneUplinkFramesObserved - microphoneFrameBaseline;
      const expectedSpeakerFrames = speakerDownlinkFramesObserved - speakerFrameBaseline;
      const finalMetrics = await runtimeProbe.race(
        withTimeout(
          runtimeProbe.waitForMetrics("capability", (metrics) =>
            deviceInterruptedVoiceSequenceCompleted(sequenceBaseline, metrics, {
              microphoneFrames: expectedMicrophoneFrames,
              speakerFrames: expectedSpeakerFrames,
            }),
          ),
          voiceResponseTimeoutMs,
          "The interrupted sequence did not close its exact played-or-flushed frame ledger.",
        ),
      );
      autonomousFinalVoiceMetrics = finalMetrics;
      const freshOutcome = providerResponseOutcomes[providerResponseBaseline + 1];
      if (freshOutcome?.status !== "completed") {
        throw new Error(
          `The fresh post-interruption Grok response ended as ${freshOutcome?.status ?? "unknown"}.`,
        );
      }
      const firstSpeakerAtMonotonicMs = firstTiming.firstSpeakerFrameAtMonotonicMs;
      const secondFirstMicrophoneAtMonotonicMs = secondTiming.firstMicrophoneFrameAtMonotonicMs;
      const secondFirstSpeakerAtMonotonicMs = secondTiming.firstSpeakerFrameAtMonotonicMs;
      const secondResponseCreatedAtMonotonicMs = secondTiming.providerResponseCreatedAtMonotonicMs;
      const secondProviderDoneAtMonotonicMs =
        providerResponseDoneAtMonotonicMs[providerResponseBaseline + 1];
      const secondDownlinkDoneAtMonotonicMs =
        downlinkResponseCompletedAtMonotonicMs[downlinkResponseBaseline];
      if (
        firstSpeakerAtMonotonicMs === undefined ||
        secondFirstMicrophoneAtMonotonicMs === undefined ||
        secondFirstSpeakerAtMonotonicMs === undefined ||
        secondResponseCreatedAtMonotonicMs === undefined ||
        secondProviderDoneAtMonotonicMs === undefined ||
        secondDownlinkDoneAtMonotonicMs === undefined
      ) {
        throw new Error("The interruption proof ended without a complete two-epoch timing ledger.");
      }
      const metricDelta = (name: string) =>
        numericMetric(finalMetrics, name) - numericMetric(sequenceBaseline, name);
      const interruptionEvidence = {
        frames: {
          microphone: expectedMicrophoneFrames,
          speaker: expectedSpeakerFrames,
          speakerCompleted: metricDelta("playback_completed"),
          speakerFlushed: metricDelta("playback_flushed"),
        },
        interruption: {
          deviceRpcMs: interruptionDeviceRpcMs,
          firstAudiblePrefixMs: interruptionRequestedAtMonotonicMs - firstSpeakerAtMonotonicMs,
          providerStatus: interruptedOutcome.status,
          speakerFramesBeforeInterrupt: firstReplyFramesAtInterruption,
        },
        latencyMs: {
          firstPttHeld: firstPttStoppedAtMonotonicMs - firstPttStartedAtMonotonicMs,
          firstPttStopToFirstSpeaker: firstSpeakerAtMonotonicMs - firstPttStoppedAtMonotonicMs,
          secondPttStartToFirstMicrophone:
            secondFirstMicrophoneAtMonotonicMs - deviceInterruptionAcceptedAtMonotonicMs,
          secondPttStopToDownlinkComplete:
            secondDownlinkDoneAtMonotonicMs - secondPttStoppedAtMonotonicMs,
          secondPttStopToFirstSpeaker:
            secondFirstSpeakerAtMonotonicMs - secondPttStoppedAtMonotonicMs,
          secondPttStopToProviderDone:
            secondProviderDoneAtMonotonicMs - secondPttStoppedAtMonotonicMs,
          secondPttStopToResponseCreated:
            secondResponseCreatedAtMonotonicMs - secondPttStoppedAtMonotonicMs,
        },
        provider: {
          fresh: freshOutcome,
          interrupted: interruptedOutcome,
        },
        resources: {
          baseline: sequenceBaseline,
          final: finalMetrics,
          secondHeld: secondHeldUplinkMetrics,
        },
      };
      conversationRecorder?.recordEvent("autonomous-interruption.completed", interruptionEvidence);
      console.log(`voice_interruption_evidence=${JSON.stringify(interruptionEvidence)}`);
      console.log(
        `voice_frame_conservation mode=interruption microphone=${expectedMicrophoneFrames} ` +
          `speaker=${expectedSpeakerFrames} completed=${metricDelta("playback_completed")} ` +
          `flushed=${metricDelta("playback_flushed")} device=exact`,
      );
      activeAutonomousTurn = undefined;
    }

    const remoteTurnCount = options.remoteInterruptionProof
      ? 0
      : recordsAutonomousVoiceConversation
        ? (options.remoteVoiceTurns ?? 1)
        : 1;
    for (let turn = 1; turn <= remoteTurnCount; turn += 1) {
      /*
       * Re-baseline every turn only after the previous response drained. One
       * end-of-run delta would let a clean later reply compensate for a dropped
       * earlier reply; per-turn conservation makes the first divergence the
       * durable failure boundary while the provider session remains shared.
       */
      const remotePlaybackBaseline = structuredClone(
        latestCapabilityMetrics ?? firstCapabilityMetrics,
      );
      const remoteMicrophoneFrameBaseline = microphoneUplinkFramesObserved;
      const remoteSpeakerFrameBaseline = speakerDownlinkFramesObserved;
      const remoteProviderResponseTarget = providerResponsesDone + 1;
      const remoteDownlinkResponseTarget = downlinkResponsesCompleted + 1;
      const turnStartedAtMonotonicMs = performance.now();
      const turnTiming: AutonomousVoiceTurnTiming = { turn };
      activeAutonomousTurn = recordsAutonomousVoiceConversation ? turnTiming : undefined;
      conversationRecorder?.recordEvent("autonomous-turn.started", {
        baseline: remotePlaybackBaseline,
        turn,
      });

      const remoteStartedLog = serialMonitor
        ? runtimeProbe.waitForDeviceEvent("pushToTalk.started", "remote")
        : undefined;
      const started = await runtimeProbe.race(mounted.device.pushToTalk.start());
      if (!started) {
        throw new Error(`Remote push-to-talk start was not accepted for turn ${turn}.`);
      }
      if (remoteStartedLog) {
        await runtimeProbe.race(
          withTimeout(
            remoteStartedLog,
            5_000,
            "The device accepted remote push-to-talk start but did not process its semantic event.",
          ),
        );
      }
      if (options.voice && !(await server.inputStarted())) {
        throw new Error(`The PCM proxy did not accept push-to-talk start for turn ${turn}.`);
      }
      const pttStartedAtMonotonicMs = performance.now();
      console.log(`remote_event=pushToTalk.started accepted=true turn=${turn}`);

      let pttStoppedAtMonotonicMs: number | undefined;
      let stopped = false;
      try {
        if (options.voice) {
          const phrase =
            environment.ITERATE_KIT_VOICE_PHRASE ??
            autonomousVoicePrompts[turn - 1] ??
            `This is conversation turn ${turn} of ${remoteTurnCount}. Reply with the turn number and one cheerful word.`;
          conversationRecorder?.recordEvent("autonomous-turn.prompt", { phrase, turn });
          console.log(`voice_prompt_injection_started source=macos-say turn=${turn}`);
          await executeFile(environment.ITERATE_KIT_SAY ?? "/usr/bin/say", [phrase]);
          console.log(`voice_prompt_injection_complete turn=${turn}`);
          const firstHeldUplinkMetrics = await runtimeProbe.race(
            withTimeout(
              runtimeProbe.waitForMetrics("capability", (metrics) =>
                deviceUplinkStreaming(remotePlaybackBaseline, metrics),
              ),
              5_000,
              `Microphone frames did not reach Grok while turn ${turn} remained held.`,
            ),
          );
          const continuingHeldUplinkMetrics = await runtimeProbe.race(
            withTimeout(
              runtimeProbe.waitForMetrics("capability", (metrics) =>
                deviceUplinkStreaming(firstHeldUplinkMetrics, metrics),
              ),
              5_000,
              `Microphone frames stopped reaching Grok before turn ${turn} was released.`,
            ),
          );
          console.log(
            `capability_uplink_while_held turn=${turn} ` +
              `metrics=${JSON.stringify(continuingHeldUplinkMetrics)}`,
          );
        }
        await delay(options.remoteHoldMs);
        const remoteStoppedLog = serialMonitor
          ? runtimeProbe.waitForDeviceEvent("pushToTalk.stopped", "remote")
          : undefined;
        stopped = await runtimeProbe.race(mounted.device.pushToTalk.stop());
        if (remoteStoppedLog) {
          await runtimeProbe.race(
            withTimeout(
              remoteStoppedLog,
              5_000,
              "The device accepted remote push-to-talk stop but did not process its semantic event.",
            ),
          );
        }
        if (options.voice && !(await server.inputStopped())) {
          throw new Error(`The PCM proxy did not accept push-to-talk stop for turn ${turn}.`);
        }
        pttStoppedAtMonotonicMs = performance.now();
      } finally {
        if (!stopped) {
          await mounted.device.pushToTalk.stop();
        }
      }
      if (!stopped || pttStoppedAtMonotonicMs === undefined) {
        throw new Error(`Remote push-to-talk stop was not accepted for turn ${turn}.`);
      }
      console.log(`remote_event=pushToTalk.stopped accepted=true turn=${turn}`);

      const baselineUptime = numericMetric(remotePlaybackBaseline, "uptime_ms");
      const remoteCapabilityMetrics = await runtimeProbe.race(
        withTimeout(
          runtimeProbe.waitForMetrics(
            "capability",
            (metrics) =>
              numericMetric(metrics, "uptime_ms") > baselineUptime &&
              hasCapabilityResourceEvidence(metrics),
          ),
          5_000,
          `Timed out waiting for post-turn-${turn} Cap'n Web metrics.`,
        ),
      );
      console.log(
        `capability_runtime_metrics turn=${turn} metrics=${JSON.stringify(remoteCapabilityMetrics)}`,
      );
      if (serialMonitor) {
        const [remoteSystemMetrics, remoteControlMetrics] = await runtimeProbe.race(
          withTimeout(
            Promise.all([
              runtimeProbe.waitForMetrics(
                "system",
                (metrics) => metrics.control_transport === "ready" && hasResourceEvidence(metrics),
              ),
              runtimeProbe.waitForMetrics(
                "control",
                (metrics) => numericMetric(metrics, "events_processed") >= turn * 2,
              ),
            ]),
            5_000,
            `Timed out waiting for healthy post-turn-${turn} runtime metrics.`,
          ),
        );
        console.log(
          `runtime_metrics=${JSON.stringify({
            control: remoteControlMetrics,
            system: remoteSystemMetrics,
            turn,
          })}`,
        );
      }
      if (!options.voice) continue;

      /*
       * Do not arm the metric predicate until both provider response.done and
       * the ordered PCM EOS have crossed userspace. An earlier implementation
       * captured a metrics sample after the first 12 frames, then paired that
       * stale sample with a later response.done and declared a 46-frame reply
       * successful even though the device flushed the remaining 34.
       */
      await waitForVoiceProgress({
        downlinkTarget: remoteDownlinkResponseTarget,
        message: `Timed out waiting for Grok to finish remote turn ${turn}.`,
        providerTarget: remoteProviderResponseTarget,
      });
      const expectedMicrophoneFrames =
        microphoneUplinkFramesObserved - remoteMicrophoneFrameBaseline;
      const expectedSpeakerFrames = speakerDownlinkFramesObserved - remoteSpeakerFrameBaseline;
      if (expectedMicrophoneFrames <= 0) {
        throw new Error(`Turn ${turn} completed without a microphone PCM frame reaching Grok.`);
      }
      if (expectedSpeakerFrames <= 0) {
        throw new Error(`Grok completed turn ${turn} without sending a PCM frame to the Stick.`);
      }
      const capabilityVoiceMetrics = runtimeProbe.waitForMetrics("capability", (metrics) =>
        deviceVoiceTurnCompleted(remotePlaybackBaseline, metrics, {
          microphoneFrames: expectedMicrophoneFrames,
          speakerFrames: expectedSpeakerFrames,
        }),
      );
      let remoteVoiceMetrics: DeviceRuntimeMetrics;
      if (serialMonitor) {
        const [pcmMetrics, metrics] = await runtimeProbe.race(
          withTimeout(
            Promise.all([
              runtimeProbe.waitForMetrics(
                "pcm",
                (metrics) =>
                  numericMetric(metrics, "uplink_sent") > 0 &&
                  numericMetric(metrics, "downlink_accepted") > 0 &&
                  numericMetric(metrics, "playback_submitted") > 0,
              ),
              capabilityVoiceMetrics,
            ]).then(([serialMetrics, metrics]) => [serialMetrics, metrics] as const),
            voiceResponseTimeoutMs,
            `Timed out waiting for exact turn-${turn} frame conservation through the Stick.`,
          ),
        );
        remoteVoiceMetrics = metrics;
        console.log(`pcm_runtime_metrics turn=${turn} metrics=${JSON.stringify(pcmMetrics)}`);
      } else {
        remoteVoiceMetrics = await runtimeProbe.race(
          withTimeout(
            capabilityVoiceMetrics,
            voiceResponseTimeoutMs,
            `Timed out waiting for exact turn-${turn} frame conservation through the Stick.`,
          ),
        );
      }
      console.log(
        `capability_voice_metrics turn=${turn} metrics=${JSON.stringify(remoteVoiceMetrics)}`,
      );
      autonomousFinalVoiceMetrics = remoteVoiceMetrics;

      const providerDoneAtMonotonicMs =
        providerResponseDoneAtMonotonicMs[remoteProviderResponseTarget - 1];
      const downlinkDoneAtMonotonicMs =
        downlinkResponseCompletedAtMonotonicMs[remoteDownlinkResponseTarget - 1];
      const firstMicrophoneFrameAtMonotonicMs = turnTiming.firstMicrophoneFrameAtMonotonicMs;
      const firstSpeakerFrameAtMonotonicMs = turnTiming.firstSpeakerFrameAtMonotonicMs;
      const providerResponseCreatedAtMonotonicMs = turnTiming.providerResponseCreatedAtMonotonicMs;
      if (
        providerDoneAtMonotonicMs === undefined ||
        downlinkDoneAtMonotonicMs === undefined ||
        firstMicrophoneFrameAtMonotonicMs === undefined ||
        firstSpeakerFrameAtMonotonicMs === undefined ||
        providerResponseCreatedAtMonotonicMs === undefined
      ) {
        throw new Error(`Turn ${turn} ended without a complete provider/audio timing ledger.`);
      }
      const turnCompletedAtMonotonicMs = performance.now();
      const turnEvidence = {
        frames: {
          microphone: expectedMicrophoneFrames,
          speaker: expectedSpeakerFrames,
        },
        latencyMs: {
          pttStartToFirstMicrophone: firstMicrophoneFrameAtMonotonicMs - pttStartedAtMonotonicMs,
          pttStopToDownlinkComplete: downlinkDoneAtMonotonicMs - pttStoppedAtMonotonicMs,
          pttStopToFirstSpeaker: firstSpeakerFrameAtMonotonicMs - pttStoppedAtMonotonicMs,
          pttStopToPlaybackConserved: turnCompletedAtMonotonicMs - pttStoppedAtMonotonicMs,
          pttStopToProviderDone: providerDoneAtMonotonicMs - pttStoppedAtMonotonicMs,
          pttStopToResponseCreated: providerResponseCreatedAtMonotonicMs - pttStoppedAtMonotonicMs,
          total: turnCompletedAtMonotonicMs - turnStartedAtMonotonicMs,
        },
        resources: {
          baseline: {
            cpuPermille: numericMetric(remotePlaybackBaseline, "cpu_permille"),
            freeHeapBytes: numericMetric(remotePlaybackBaseline, "heap"),
            freeInternalHeapBytes: numericMetric(remotePlaybackBaseline, "internal"),
            minimumFreeHeapBytes: numericMetric(remotePlaybackBaseline, "min_heap"),
            minimumFreeInternalHeapBytes: numericMetric(remotePlaybackBaseline, "min_internal"),
          },
          final: {
            cpuPermille: numericMetric(remoteVoiceMetrics, "cpu_permille"),
            freeHeapBytes: numericMetric(remoteVoiceMetrics, "heap"),
            freeInternalHeapBytes: numericMetric(remoteVoiceMetrics, "internal"),
            minimumFreeHeapBytes: numericMetric(remoteVoiceMetrics, "min_heap"),
            minimumFreeInternalHeapBytes: numericMetric(remoteVoiceMetrics, "min_internal"),
          },
          maximumTransportAcceptAgeMs: numericMetric(
            remoteVoiceMetrics,
            "uplink_maximum_transport_accept_age_ms",
          ),
          playbackHighWaterFrames: numericMetric(remoteVoiceMetrics, "playback_high_water"),
          uplinkHighWaterFrames: numericMetric(remoteVoiceMetrics, "uplink_high_water"),
        },
        turn,
      };
      conversationRecorder?.recordEvent("autonomous-turn.completed", turnEvidence);
      console.log(`voice_turn_evidence=${JSON.stringify(turnEvidence)}`);
      console.log(
        `voice_frame_conservation turn=${turn} microphone=${expectedMicrophoneFrames} ` +
          `speaker=${expectedSpeakerFrames} device=exact`,
      );
      activeAutonomousTurn = undefined;
    }
    if (options.voice) {
      console.log(
        `device_voice_pipeline_observed provider=grok ` +
          `mode=${options.remoteInterruptionProof ? "interruption" : "sequential"} ` +
          `turns=${options.remoteInterruptionProof ? 2 : remoteTurnCount} ` +
          "evidence=capability-metrics+pcm-recording+provider-lifecycle acoustic=recorded",
      );
    }

    if (!options.exitAfterRemoteProof) {
      if (!serialMonitor) {
        throw new Error("Physical button observation requires ITERATE_KIT_SERIAL_DIAGNOSTICS=1.");
      }
      console.log(
        "remote_proof_passed; hold and release Button A to exercise the same event queue",
      );
      const physicalStarted = runtimeProbe.waitForDeviceEvent("pushToTalk.started", "physical");
      await runtimeProbe.race(physicalStarted);
      console.log("physical_event=pushToTalk.started processed=true");
      const physicalStopped = runtimeProbe.waitForDeviceEvent("pushToTalk.stopped", "physical");
      await runtimeProbe.race(physicalStopped);
      console.log("physical_event=pushToTalk.stopped processed=true");
      const [physicalSystemMetrics, physicalControlMetrics] = await runtimeProbe.race(
        withTimeout(
          Promise.all([
            runtimeProbe.waitForMetrics(
              "system",
              (metrics) => metrics.control_transport === "ready" && hasResourceEvidence(metrics),
            ),
            runtimeProbe.waitForMetrics(
              "control",
              (metrics) => numericMetric(metrics, "events_processed") >= 4,
            ),
          ]),
          5_000,
          "Timed out waiting for healthy post-physical runtime metrics.",
        ),
      );
      console.log(
        `runtime_metrics=${JSON.stringify({
          control: physicalControlMetrics,
          system: physicalSystemMetrics,
        })}`,
      );
      console.log(
        recordsAutonomousVoiceConversation
          ? "device_remote_operations_completed remote=true physical=true"
          : "device_e2e_passed remote=true physical=true",
      );
    } else {
      console.log(
        recordsAutonomousVoiceConversation
          ? "device_remote_operations_completed remote=true physical=skipped"
          : "device_e2e_passed remote=true physical=skipped",
      );
    }
    autonomousRunPassed = recordsAutonomousVoiceConversation;
  } catch (error) {
    terminalRunError = error;
    throw error;
  } finally {
    let autonomousFinalizationError: unknown;
    const retainAutonomousFinalizationError = (error: unknown, message: string) => {
      autonomousFinalizationError =
        autonomousFinalizationError === undefined
          ? error
          : new AggregateError([autonomousFinalizationError, error], message);
    };
    if (recordsAutonomousVoiceConversation) {
      if (conversationRecorder && autonomousRunPassed) {
        conversationRecorder.recordEvent("autonomous-conversation.completed", {
          mode: options.remoteInterruptionProof ? "interruption" : "sequential",
          providerResponsesDone,
          providerResponseOutcomes,
          speakerDownlinkFramesObserved,
        });
      }
      if (autonomousAcousticCapture) {
        try {
          if (autonomousRunPassed) await delay(acousticCaptureTailMs);
          await Promise.all(acousticMarkerTasks);
          autonomousAcousticRecording = await autonomousAcousticCapture.stop();
          activeAcousticCapture = undefined;
          console.log(
            `conversation_acoustic_capture=${JSON.stringify({
              artifactPath: autonomousAcousticRecording.artifactPath,
              capturedByteLength: autonomousAcousticRecording.capturedByteLength,
              capturedSampleCount: autonomousAcousticRecording.capturedSampleCount,
              captureProvenance: autonomousAcousticRecording.captureProvenance,
              sampleRateHz: autonomousAcousticRecording.sampleRateHz,
            })}`,
          );
        } catch (error) {
          retainAutonomousFinalizationError(
            error,
            "The autonomous voice run and its acoustic recorder both failed.",
          );
        }
      }
      if (autonomousNetworkMonitor) {
        try {
          autonomousNetworkCapture = await autonomousNetworkMonitor.capture();
          if (autonomousNetworkMeasurement) {
            const measurement = await autonomousNetworkMeasurement;
            autonomousNetworkCapture.dnsAndConnect = {
              connect: measurement.connect,
              coverage: { ...autonomousNetworkCapture.audioInterval },
              dns: measurement.dns,
              kind: "measured",
            };
          }
        } catch (error) {
          retainAutonomousFinalizationError(
            error,
            "The autonomous voice run and its terminal network capture both failed.",
          );
        }
      }
      let recording: PcmConversationRecordingSummary | undefined;
      if (conversationRecorder && !conversationRecorderClosed) {
        try {
          recording = await conversationRecorder.close();
          conversationRecorderClosed = true;
          console.log(`pcm_conversation_recording=${JSON.stringify(recording)}`);
          if (!recording.complete) {
            retainAutonomousFinalizationError(
              new Error(`PCM conversation recording was incomplete: ${recording.failure}.`),
              "The autonomous voice run and its PCM recorder both failed.",
            );
          }
        } catch (error) {
          retainAutonomousFinalizationError(
            error,
            "The autonomous voice run and its PCM recorder both failed.",
          );
        }
      }
      const autonomousNetworkTerminalMetrics =
        autonomousFinalVoiceMetrics ?? latestCapabilityMetrics;
      if (
        autonomousNetworkCapture &&
        autonomousNetworkArtifactPath &&
        autonomousNetworkBaseline &&
        autonomousNetworkTerminalMetrics
      ) {
        try {
          const failure = terminalRunError ?? autonomousFinalizationError;
          const progress = physicalNetworkProgress(
            autonomousNetworkBaseline,
            autonomousNetworkTerminalMetrics,
          );
          const artifact = buildPhysicalNetworkRunArtifact({
            ...autonomousNetworkCapture,
            audio: {
              failure:
                failure === undefined
                  ? null
                  : failure instanceof Error
                    ? failure.message
                    : String(failure),
              passed:
                autonomousRunPassed &&
                failure === undefined &&
                recording?.complete === true &&
                autonomousAcousticRecording !== undefined,
            },
            pcmEvidence: options.directLanHost
              ? {
                  bridgeEvidence: snapshotPhysicalNetworkBridgeEvidence({
                    closeEvents: bridgeCloseEvents,
                    historyTruncated: bridgeHistoryTruncated,
                    openEvents: bridgeOpenEvents,
                  }),
                  kind: "local-bridge",
                  progress,
                }
              : {
                  /*
                   * Captun terminates the outer TCP/WebSocket connection, so
                   * the local fetch adapter cannot truthfully invent a device
                   * remote address or socket-open event. The device's v3
                   * diagnostics independently sample the real PCM generation;
                   * use that explicit evidence kind and keep local PCM byte
                   * progress as the orthogonal conservation witness.
                   */
                  kind: "device-observed",
                  progress,
                },
          });
          await writePhysicalNetworkRunArtifact(autonomousNetworkArtifactPath, artifact);
          console.log(
            `physical_network_validity=${JSON.stringify({
              artifactPath: autonomousNetworkArtifactPath,
              classification: artifact.classification,
              reasons: artifact.network.reasons,
              verdict: artifact.network.verdict,
            })}`,
          );
          if (terminalRunError === undefined && artifact.classification !== "valid") {
            retainAutonomousFinalizationError(
              new Error(
                `Autonomous voice completed, but its network evidence was ` +
                  `${artifact.classification}. See ${autonomousNetworkArtifactPath}.`,
              ),
              "The autonomous voice evidence failed more than once.",
            );
          } else if (
            terminalRunError === undefined &&
            autonomousFinalizationError === undefined &&
            artifact.classification === "valid"
          ) {
            console.log(
              `device_e2e_passed remote=true ` +
                `physical=${options.exitAfterRemoteProof ? "skipped" : "true"} ` +
                `mode=${options.remoteInterruptionProof ? "interruption" : "sequential"} ` +
                `turns=${options.remoteInterruptionProof ? 2 : (options.remoteVoiceTurns ?? 1)} ` +
                `network=valid recording=${recording?.outputDirectory} ` +
                `acoustic=${autonomousAcousticRecording?.artifactPath}`,
            );
          }
        } catch (error) {
          retainAutonomousFinalizationError(
            error,
            "The autonomous voice run and its network artifact both failed.",
          );
        }
      } else if (terminalRunError === undefined) {
        retainAutonomousFinalizationError(
          new Error("The autonomous voice run ended without complete network evidence."),
          "The autonomous voice evidence failed more than once.",
        );
      }
    }
    serialMonitor?.[Symbol.dispose]();
    /*
     * End the mount observer before closing the transport that owns its
     * ProvisionTarget. Closing the server first looks exactly like an
     * unexpected remote revocation, so the postmortem observer waits 25
     * seconds for a replacement and prints a false reconnect error after an
     * otherwise clean run. Peer disposal gives the observer the explicit
     * `peer-disposed` terminal reason; the following transport teardown still
     * closes the physical sockets, but it can no longer rewrite intentional
     * harness shutdown into failure telemetry.
     */
    peer[Symbol.dispose]();
    tunnel?.[Symbol.dispose]();
    server[Symbol.dispose]();
    await directLanServer?.close();
    deterministicProvider?.[Symbol.dispose]();
    if (conversationRecorder && !conversationRecorderClosed) {
      try {
        const recording = await conversationRecorder.close();
        console.log(`pcm_conversation_recording_preserved=${JSON.stringify(recording)}`);
      } catch (error) {
        console.error("Unable to finalize the PCM conversation recording.", error);
      }
    }
    if (terminalRunError === undefined && autonomousFinalizationError !== undefined) {
      throw autonomousFinalizationError;
    }
  }
}

async function createPhysicalNetworkArtifactPath(options: {
  acousticArtifactPath: string | undefined;
  outputRoot: string | undefined;
}) {
  if (!options.outputRoot && options.acousticArtifactPath) {
    return join(dirname(options.acousticArtifactPath), "physical-network-validity.json");
  }
  const outputRoot = options.outputRoot ?? tmpdir();
  await mkdir(outputRoot, { recursive: true });
  const directory = await mkdtemp(join(outputRoot, "iterate-kit-network-"));
  return join(directory, "physical-network-validity.json");
}

function normalizeSocketHost(remoteAddress: string) {
  /*
   * Node may render an IPv4 peer accepted by a dual-stack socket as an
   * IPv4-mapped IPv6 literal. `/sbin/ping` needs the underlying station
   * address, while retaining the original bridge event in the artifact keeps
   * the transport provenance intact.
   */
  return remoteAddress.startsWith("::ffff:")
    ? remoteAddress.slice("::ffff:".length)
    : remoteAddress;
}

function physicalNetworkProgress(
  baseline: DeviceRuntimeMetrics,
  current: DeviceRuntimeMetrics | undefined,
) {
  const increasedFrames = (name: string) => {
    const before = numericMetric(baseline, name);
    const after = current ? numericMetric(current, name) : -1;
    return before < 0 || after < before ? 0 : after - before;
  };
  return {
    deviceToWorkerBytes: increasedFrames("uplink_sent") * pcmFrameBytes,
    workerToDeviceBytes: increasedFrames("downlink_accepted") * pcmFrameBytes,
  };
}

function snapshotPhysicalNetworkBridgeEvidence(
  evidence: PhysicalNetworkBridgeEvidence,
): PhysicalNetworkBridgeEvidence {
  /*
   * The server callbacks continue through outer teardown. Clone at the audio
   * boundary so a normal post-proof close can never be rewritten into an
   * in-window disconnect after the classifier has run.
   */
  return structuredClone(evidence);
}

async function readExistingConfigurationWhenNeeded(
  flash: boolean,
  flashArgs: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
) {
  if (flash && environment.ITERATE_KIT_WIFI_PASSWORD !== undefined) {
    return undefined;
  }
  const port = optionValue(flashArgs, "--port") ?? environment.ITERATE_KIT_PORT;
  if (!port) {
    return undefined;
  }
  console.log(`reading_existing_device_configuration device=${port}`);
  const image = await readFlashRegionWithEsptool({
    chipFamily: "ESP32-S3",
    port,
    pythonExecutable: environment.ITERATE_KIT_PYTHON,
    region: M5STICKS3_CONFIGURATION_PARTITION,
  });
  const configuration = decodeDeviceConfiguration(image);
  const requestedSsid = optionValue(flashArgs, "--wifi-ssid") ?? environment.ITERATE_KIT_WIFI_SSID;
  if (flash && requestedSsid !== undefined && requestedSsid !== configuration.wifi.ssid) {
    throw new Error(
      "The requested Wi-Fi network differs from the stick's existing provisioning; provide ITERATE_KIT_WIFI_PASSWORD explicitly.",
    );
  }
  console.log("existing_device_configuration_loaded");
  return configuration;
}

function optionValue(args: readonly string[], name: string) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function withTimeout<Value>(promise: Promise<Value>, timeoutMs: number, message: string) {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

interface ObservationWaiter {
  predicate(observation: DeviceRuntimeLogObservation): boolean;
  reject(error: Error): void;
  resolve(observation: DeviceRuntimeLogObservation): void;
}

interface PcmClosePlaybackDiagnosticSnapshot {
  sequence: number;
  producedAtMs: number;
  downlinkAccepted: number;
  playbackSubmitted: number;
  playbackCompleted: number;
  pcmReceiveCalls: number;
  pcmReceiveChunks: number;
}

interface PendingUnexpectedPcmClose {
  baseline: PcmClosePlaybackDiagnosticSnapshot | undefined;
  close: DevicePcmSocketClose;
  error: Error;
  startedAtMonotonicMs: number;
  timeout: NodeJS.Timeout;
}

/*
 * The control capability samples once per second, but a callback can already
 * be in flight when the PCM socket closes. Six seconds is deliberately a
 * diagnostics-only ceiling: it spans one delayed callback and a reconnect
 * attempt seen in physical runs without ever retaining PCM or converting the
 * failed generation into a pass. The timer is the bounded explanation when
 * the independent control plane is itself unavailable.
 */
const pcmCloseFollowupMetricsTimeoutMs = 6_000;

export class DeviceRuntimeProbe {
  readonly #continuity = new DeviceRuntimeMetricsContinuity();
  readonly #failure: Promise<never>;
  readonly #history: DeviceRuntimeLogObservation[] = [];
  readonly #waiters = new Set<ObservationWaiter>();
  #failureReason: Error | undefined;
  #lastPcmDiagnostic: string | undefined;
  #latestPcmClosePlaybackDiagnostic: PcmClosePlaybackDiagnosticSnapshot | undefined;
  #pendingUnexpectedPcmClose: PendingUnexpectedPcmClose | undefined;
  #playbackCounterPolicy:
    | {
        baseline: DeviceRuntimeMetrics;
        maximumDeltas: Readonly<Record<string, number>>;
      }
    | undefined;
  #lastTransportDiagnostic: string | undefined;
  #rejectFailure!: (error: Error) => void;

  constructor() {
    this.#failure = new Promise<never>((_resolve, reject) => {
      this.#rejectFailure = reject;
    });
    void this.#failure.catch(() => {});
  }

  observeLine(line: string) {
    const observation = parseDeviceRuntimeLogLine(line);
    if (!observation) return;
    this.#observe(observation);
  }

  observeCapabilityMetrics(value: unknown) {
    const observation = parseKitMetricsCallback(value);
    this.#observe(observation);
    return observation.kind === "metrics" ? observation.values : undefined;
  }

  observePlaybackMetrics(value: unknown) {
    try {
      const parsed = parseKitPlaybackMetrics(value);
      const values = {
        ...flattenKitPlaybackMetrics(parsed),
        playback_metrics_produced_at_ms: parsed.producedAtMs,
        playback_metrics_sequence: parsed.sequence,
        playback_metrics_schema_version: parsed.schemaVersion,
      };
      this.#latestPcmClosePlaybackDiagnostic = {
        sequence: parsed.sequence,
        producedAtMs: parsed.producedAtMs,
        downlinkAccepted: parsed.downlinkAccepted,
        playbackSubmitted: parsed.playback.submitted,
        playbackCompleted: parsed.playback.completed,
        pcmReceiveCalls: parsed.runtime.pcmReceiveCalls,
        pcmReceiveChunks: parsed.runtime.pcmReceiveChunks,
      };
      this.#observe({
        family: "playback-detail",
        kind: "metrics",
        values,
      });
      this.#completeUnexpectedPcmCloseDiagnostic(this.#latestPcmClosePlaybackDiagnostic);
    } catch (error) {
      this.fail(
        new Error("Malformed detailed playback metrics callback.", {
          cause: error,
        }),
      );
    }
  }

  observePcmSocketClose(close: DevicePcmSocketClose) {
    console.log(`pcm_socket_close=${JSON.stringify(close)}`);
    if (close.classification === "unexpected") {
      if (this.#pendingUnexpectedPcmClose) return;
      const error = new Error(
        `PCM ${close.origin} socket closed unexpectedly with code ${close.code}: ${
          close.reason || "(no reason)"
        }.`,
      );
      const startedAtMonotonicMs = performance.now();
      const timeout = setTimeout(() => {
        const pending = this.#pendingUnexpectedPcmClose;
        if (!pending) return;
        this.#pendingUnexpectedPcmClose = undefined;
        console.error(
          `pcm_socket_close_followup_timeout=${JSON.stringify({
            baseline: pending.baseline ?? null,
            close: pending.close,
            waitedMs: performance.now() - pending.startedAtMonotonicMs,
          })}`,
        );
        this.fail(pending.error);
      }, pcmCloseFollowupMetricsTimeoutMs);
      this.#pendingUnexpectedPcmClose = {
        baseline: this.#latestPcmClosePlaybackDiagnostic,
        close,
        error,
        startedAtMonotonicMs,
        timeout,
      };
    }
  }

  #completeUnexpectedPcmCloseDiagnostic(current: PcmClosePlaybackDiagnosticSnapshot) {
    const pending = this.#pendingUnexpectedPcmClose;
    if (!pending) return;
    if (
      pending.baseline &&
      current.sequence === pending.baseline.sequence &&
      current.producedAtMs === pending.baseline.producedAtMs
    ) {
      /*
       * A callback already queued before the close may be delivered twice by a
       * host adapter. It contains no post-close evidence, so keep waiting
       * rather than reporting zero deltas as if the device had been observed.
       */
      return;
    }
    clearTimeout(pending.timeout);
    this.#pendingUnexpectedPcmClose = undefined;
    const baseline = pending.baseline;
    console.log(
      `pcm_socket_close_followup_metrics=${JSON.stringify({
        baseline: baseline ?? null,
        close: pending.close,
        current,
        deltas: baseline
          ? {
              downlinkAccepted: current.downlinkAccepted - baseline.downlinkAccepted,
              pcmReceiveCalls: current.pcmReceiveCalls - baseline.pcmReceiveCalls,
              pcmReceiveChunks: current.pcmReceiveChunks - baseline.pcmReceiveChunks,
              playbackCompleted: current.playbackCompleted - baseline.playbackCompleted,
              playbackSubmitted: current.playbackSubmitted - baseline.playbackSubmitted,
            }
          : null,
        waitedMs: performance.now() - pending.startedAtMonotonicMs,
      })}`,
    );
    this.fail(pending.error);
  }

  armPlaybackCounterPolicy(
    baseline: DeviceRuntimeMetrics,
    maximumDeltas: Readonly<Record<string, number>>,
  ) {
    /*
     * Evaluate the baseline against itself before arming. This catches schema
     * omissions and saturated counters synchronously, before starting a
     * physical recording that could never produce valid before/after proof.
     */
    const assessment = assessPlaybackCounterPolicy({
      baseline,
      current: baseline,
      maximumDeltas,
    });
    if (assessment.kind === "failure") {
      throw new Error(assessment.reason);
    }
    this.#playbackCounterPolicy = {
      baseline: structuredClone(baseline),
      maximumDeltas: structuredClone(maximumDeltas),
    };
  }

  #observe(observation: DeviceRuntimeLogObservation) {
    if (observation.kind === "failure") {
      this.fail(new Error(observation.reason));
      return;
    }
    if (observation.kind === "metrics") {
      /*
       * Health checks on individual values cannot detect a stale/reordered
       * record. Run the report-envelope proof first so no waiter can consume a
       * plausible `ready` value from an impossible serial ordering.
       */
      const continuity = this.#continuity.observe(observation);
      if (continuity?.kind === "failure") {
        this.fail(new Error(continuity.reason));
        return;
      }
      this.#reportTransportDiagnostic(observation);
      if (observation.family === "playback-detail" && this.#playbackCounterPolicy) {
        const assessment = assessPlaybackCounterPolicy({
          baseline: this.#playbackCounterPolicy.baseline,
          current: observation.values,
          maximumDeltas: this.#playbackCounterPolicy.maximumDeltas,
        });
        if (assessment.kind === "failure") {
          console.error(`playback_counter_policy_failure=${JSON.stringify(assessment)}`);
          this.fail(new Error(assessment.reason));
          return;
        }
      }
      const health = assessDeviceRuntimeMetrics(observation.values, {
        maximumTaskWorkCyclesPerReport: 300_000_000,
        minimumNetworkStackHeadroomBytes: 512,
      });
      if (health?.kind === "failure") {
        console.error(
          `unhealthy_device_runtime_metrics=${JSON.stringify({
            family: observation.family,
            values: observation.values,
          })}`,
        );
        this.fail(new Error(health.reason));
        return;
      }
    }
    if (observation.kind === "device-event") {
      if (observation.result !== 0) {
        this.fail(
          new Error(
            `Device event ${observation.event} from ${observation.source} failed with status ${observation.result}.`,
          ),
        );
        return;
      }
      console.log(
        `device_event=${observation.event} source=${observation.source} result=${observation.result}`,
      );
    }
    this.#history.push(observation);
    if (this.#history.length > 64) this.#history.shift();
    for (const waiter of this.#waiters) {
      if (!waiter.predicate(observation)) continue;
      this.#waiters.delete(waiter);
      waiter.resolve(observation);
    }
  }

  #reportTransportDiagnostic(
    observation: Extract<DeviceRuntimeLogObservation, { kind: "metrics" }>,
  ) {
    if (observation.family === "system") {
      const diagnostic = JSON.stringify({
        control: observation.values.control_transport,
        pcm: observation.values.pcm_transport,
      });
      if (diagnostic !== this.#lastTransportDiagnostic) {
        this.#lastTransportDiagnostic = diagnostic;
        console.log(`device_transport_state=${diagnostic}`);
      }
      return;
    }
    if (observation.family !== "pcm") return;
    const diagnostic = JSON.stringify({
      connections: observation.values.ws_connections,
      disconnects: observation.values.ws_disconnects,
      errors: observation.values.ws_errors,
      protocolFailures: observation.values.protocol_failures,
      startAttempts: observation.values.ws_attempts,
    });
    if (diagnostic === this.#lastPcmDiagnostic) return;
    this.#lastPcmDiagnostic = diagnostic;
    console.log(`device_pcm_transport_metrics=${diagnostic}`);
  }

  fail(error: Error) {
    if (this.#failureReason) return;
    this.#failureReason = error;
    this.#rejectFailure(error);
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }

  race<Value>(operation: PromiseLike<Value>) {
    return Promise.race([Promise.resolve(operation), this.#failure]);
  }

  async waitForDeviceEvent(event: string, source: string) {
    const observation = await this.#waitFor(
      (candidate) =>
        candidate.kind === "device-event" &&
        candidate.event === event &&
        candidate.source === source,
    );
    if (observation.kind !== "device-event") {
      throw new Error("Device event waiter resolved with the wrong log type.");
    }
    return observation;
  }

  async waitForMetrics(family: string, predicate: (metrics: DeviceRuntimeMetrics) => boolean) {
    const observation = await this.#waitFor(
      (candidate) =>
        candidate.kind === "metrics" && candidate.family === family && predicate(candidate.values),
    );
    if (observation.kind !== "metrics") {
      throw new Error("Metrics waiter resolved with the wrong log type.");
    }
    return observation.values;
  }

  #waitFor(predicate: (observation: DeviceRuntimeLogObservation) => boolean) {
    if (this.#failureReason) return Promise.reject(this.#failureReason);
    const existing = this.#history.findLast(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<DeviceRuntimeLogObservation>((resolve, reject) => {
      this.#waiters.add({ predicate, reject, resolve });
    });
  }
}

function numericMetric(metrics: DeviceRuntimeMetrics, name: string) {
  const value = metrics[name];
  return typeof value === "number" ? value : -1;
}

function hasResourceEvidence(metrics: DeviceRuntimeMetrics) {
  const cpuPermille = numericMetric(metrics, "cpu_permille");
  return (
    cpuPermille >= 0 &&
    cpuPermille <= 1000 &&
    numericMetric(metrics, "main_cycles") > 0 &&
    numericMetric(metrics, "net_cycles") > 0 &&
    numericMetric(metrics, "pcm_net_cycles") > 0
  );
}

function hasCapabilityResourceEvidence(metrics: DeviceRuntimeMetrics) {
  const cpuPermille = numericMetric(metrics, "cpu_permille");
  const heap = numericMetric(metrics, "heap");
  const internal = numericMetric(metrics, "internal");
  return (
    numericMetric(metrics, "uptime_ms") >= 0 &&
    heap > 0 &&
    numericMetric(metrics, "min_heap") >= 0 &&
    numericMetric(metrics, "min_heap") <= heap &&
    internal > 0 &&
    numericMetric(metrics, "min_internal") >= 0 &&
    numericMetric(metrics, "min_internal") <= internal &&
    numericMetric(metrics, "psram") >= 0 &&
    numericMetric(metrics, "main_stack_headroom") >= 512 &&
    cpuPermille >= 0 &&
    cpuPermille <= 1000
  );
}

function hasCapabilityAudioEvidence(metrics: DeviceRuntimeMetrics) {
  return (
    numericMetric(metrics, "audio_sent") >= 0 &&
    numericMetric(metrics, "uplink_sent") >= 0 &&
    numericMetric(metrics, "downlink_accepted") >= 0 &&
    numericMetric(metrics, "playback_submitted") >= 0 &&
    numericMetric(metrics, "playback_completed") >= 0 &&
    numericMetric(metrics, "downlink_current") >= 0 &&
    numericMetric(metrics, "playback_current") >= 0
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], "file:"))
) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage);
  } else {
    try {
      await runDeviceE2e(process.argv.slice(2), process.env, process.cwd());
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
