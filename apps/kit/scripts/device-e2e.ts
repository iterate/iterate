import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
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
  deviceUplinkStreaming,
  deviceVoiceRoundTripCompleted,
  parseKitMetricsCallback,
  parseDeviceRuntimeLogLine,
  type DeviceRuntimeLogObservation,
  type DeviceRuntimeMetrics,
} from "../src/device/device-runtime-log.ts";
import { LocalFetchWebSocketServer } from "../src/device/local-fetch-websocket-server.ts";
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
import { MacOsPcm16Capture } from "../src/device/macos-pcm16-capture.ts";
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
import { flashLocalM5StickS3 } from "./flash.ts";

const executeFile = promisify(execFile);
const pcmFrameBytes = 640;
const pcmFrameDurationMs = 20;
const deterministicToneFrequencyHz = 997;
const acousticCaptureTailMs = 500;
const voiceResponseTimeoutMs = 30_000;

interface AcousticCaptureMarker {
  capturedSampleCount: number;
  hostMonotonicMs: number;
  phase: string;
  sampleRateHz: number;
}

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
  ITERATE_KIT_PLAYBACK_ENDURANCE_OUTPUT_DIRECTORY
  ITERATE_KIT_FFMPEG             default: /opt/homebrew/bin/ffmpeg
  ITERATE_KIT_SOX                CoreAudio recorder (default: /opt/homebrew/bin/sox)
  ITERATE_KIT_SERIAL_DIAGNOSTICS set to 1 to attach the USB serial fallback
  ITERATE_KIT_SAY                default: /usr/bin/say
  ITERATE_KIT_VOICE_PHRASE`;

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
          if (event.type === "response.created" || event.type === "response.done") {
            void recordAcousticMarker(`provider.${event.type}`);
          }
          if (event.type === "error") {
            runtimeProbe.fail(
              new Error(`The voice provider returned an error event: ${event.raw}`),
            );
          } else if (event.type === "response.done") {
            providerResponseDone.resolve();
          }
        },
        pcmDownlinkDeliveryMode: options.downlinkDeliveryMode,
        pcmFrameBytes,
        pcmInputMode: "push-to-talk",
        pcmMinimumDownlinkStartupFrames: options.deviceClockedStartupFrames,
      }
    : undefined;
  const server = new LocalDevicePeerServer(peer, voiceServerOptions);
  let directLanServer: LocalFetchWebSocketServer | undefined;
  let serialMonitor: PythonSerialMonitor | undefined;
  let tunnel: CaptunTunnel | undefined;

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
          console.log(`direct_lan_bridge_metrics=${JSON.stringify(metrics)}`);
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
      runtimeProbe.observeCapabilityMetrics(metrics);
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
    if (options.voice) {
      await runtimeProbe.race(
        withTimeout(
          pcmSessionReady.promise,
          30_000,
          "Timed out waiting for the independent PCM transport.",
        ),
      );
    }
    console.log(
      `device_transports_ready control=ready pcm=${options.voice ? "ready" : "not-required"}`,
    );
    console.log(`capability_runtime_metrics=${JSON.stringify(firstCapabilityMetrics)}`);

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
      try {
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
        console.log(
          `device_playback_pipeline_observed provider=${provider} ` +
            `evidence=provider-events+capability-metrics ` +
            `acoustic=${acousticCapture ? "passed" : "external"}`,
        );
        return;
      } finally {
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
    }

    const remoteStartedLog = serialMonitor
      ? runtimeProbe.waitForDeviceEvent("pushToTalk.started", "remote")
      : undefined;
    const started = await runtimeProbe.race(mounted.device.pushToTalk.start());
    if (!started) {
      throw new Error("Remote push-to-talk start was not accepted.");
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
      throw new Error("The PCM proxy did not accept the push-to-talk start event.");
    }
    console.log("remote_event=pushToTalk.started accepted=true");
    let stopped = false;
    try {
      if (options.voice) {
        const phrase =
          environment.ITERATE_KIT_VOICE_PHRASE ??
          "Please reply by saying Iterate device audio works.";
        console.log("voice_prompt_injection_started source=macos-say");
        await executeFile(environment.ITERATE_KIT_SAY ?? "/usr/bin/say", [phrase]);
        console.log("voice_prompt_injection_complete");
        const firstHeldUplinkMetrics = await runtimeProbe.race(
          withTimeout(
            runtimeProbe.waitForMetrics("capability", (metrics) =>
              deviceUplinkStreaming(firstCapabilityMetrics, metrics),
            ),
            5_000,
            "Microphone frames did not reach Grok while push-to-talk remained held.",
          ),
        );
        const continuingHeldUplinkMetrics = await runtimeProbe.race(
          withTimeout(
            runtimeProbe.waitForMetrics("capability", (metrics) =>
              deviceUplinkStreaming(firstHeldUplinkMetrics, metrics),
            ),
            5_000,
            "Microphone frames stopped reaching Grok before push-to-talk release.",
          ),
        );
        console.log(`capability_uplink_while_held=${JSON.stringify(continuingHeldUplinkMetrics)}`);
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
        throw new Error("The PCM proxy did not accept the push-to-talk stop event.");
      }
    } finally {
      if (!stopped) {
        await mounted.device.pushToTalk.stop();
      }
    }
    if (!stopped) {
      throw new Error("Remote push-to-talk stop was not accepted.");
    }
    console.log("remote_event=pushToTalk.stopped accepted=true");
    const firstUptime = numericMetric(firstCapabilityMetrics, "uptime_ms");
    const remoteCapabilityMetrics = await runtimeProbe.race(
      withTimeout(
        runtimeProbe.waitForMetrics(
          "capability",
          (metrics) =>
            numericMetric(metrics, "uptime_ms") > firstUptime &&
            hasCapabilityResourceEvidence(metrics),
        ),
        5_000,
        "Timed out waiting for post-remote Cap'n Web metrics.",
      ),
    );
    console.log(`capability_runtime_metrics=${JSON.stringify(remoteCapabilityMetrics)}`);
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
              (metrics) => numericMetric(metrics, "events_processed") >= 2,
            ),
          ]),
          5_000,
          "Timed out waiting for healthy post-remote runtime metrics.",
        ),
      );
      console.log(
        `runtime_metrics=${JSON.stringify({
          control: remoteControlMetrics,
          system: remoteSystemMetrics,
        })}`,
      );
    }
    if (options.voice) {
      const capabilityVoiceMetrics = runtimeProbe.waitForMetrics("capability", (metrics) =>
        deviceVoiceRoundTripCompleted(firstCapabilityMetrics, metrics),
      );
      if (serialMonitor) {
        const [pcmMetrics, remoteVoiceMetrics] = await runtimeProbe.race(
          withTimeout(
            Promise.all([
              providerResponseDone.promise,
              runtimeProbe.waitForMetrics(
                "pcm",
                (metrics) =>
                  numericMetric(metrics, "uplink_sent") > 0 &&
                  numericMetric(metrics, "downlink_accepted") > 0 &&
                  numericMetric(metrics, "playback_submitted") > 0,
              ),
              capabilityVoiceMetrics,
            ]).then(([, serialMetrics, metrics]) => [serialMetrics, metrics] as const),
            voiceResponseTimeoutMs,
            "Timed out waiting for Grok audio to reach the Stick speaker.",
          ),
        );
        console.log(`pcm_runtime_metrics=${JSON.stringify(pcmMetrics)}`);
        console.log(`capability_voice_metrics=${JSON.stringify(remoteVoiceMetrics)}`);
      } else {
        const remoteVoiceMetrics = await runtimeProbe.race(
          withTimeout(
            Promise.all([providerResponseDone.promise, capabilityVoiceMetrics]).then(
              ([, metrics]) => metrics,
            ),
            voiceResponseTimeoutMs,
            "Timed out waiting for Grok audio to be consumed by the Stick speaker.",
          ),
        );
        console.log(`capability_voice_metrics=${JSON.stringify(remoteVoiceMetrics)}`);
      }
      console.log(
        "device_voice_pipeline_observed provider=grok evidence=capability-metrics acoustic=external",
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
      console.log("device_e2e_passed remote=true physical=true");
    } else {
      console.log("device_e2e_passed remote=true physical=skipped");
    }
  } finally {
    serialMonitor?.[Symbol.dispose]();
    tunnel?.[Symbol.dispose]();
    server[Symbol.dispose]();
    await directLanServer?.close();
    deterministicProvider?.[Symbol.dispose]();
    peer[Symbol.dispose]();
  }
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
    this.#observe(parseKitMetricsCallback(value));
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
