import { randomBytes } from "node:crypto";
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
  deviceE2eUsesGrokProvider,
  parseDeviceE2eCliOptions,
} from "../src/device/device-e2e-cli-options.ts";
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
import {
  LocalDevicePeerServer,
  type LocalDevicePeerServerOptions,
} from "../src/device/local-device-peer-server.ts";
import { LocalDevicePeer } from "../src/device/local-device-peer.ts";
import { MacOsPcm16Capture } from "../src/device/macos-pcm16-capture.ts";
import { runM5StickS3PlaybackEnduranceMode } from "../src/device/m5sticks3-playback-endurance-mode.ts";
import { PythonSerialMonitor } from "../src/device/python-serial-monitor.ts";
import { M5STICKS3_CONFIGURATION_PARTITION } from "../src/firmware/catalog.ts";
import { decodeDeviceConfiguration } from "../src/firmware/config-image.ts";
import { readFlashRegionWithEsptool } from "../src/firmware/esptool-cli.ts";
import { parseLocalFlashCliOptions } from "../src/firmware/flash-cli-options.ts";
import { DeterministicPcmToneProvider } from "../src/voice/deterministic-pcm-tone-provider.ts";
import { connectGrokRealtimeVoice } from "../src/voice/grok-realtime-voice.ts";
import { flashLocalM5StickS3 } from "./flash.ts";

const executeFile = promisify(execFile);
const pcmFrameBytes = 640;
const pcmFrameDurationMs = 20;
const deterministicToneFrequencyHz = 997;
const acousticCaptureTailMs = 500;
const voiceResponseTimeoutMs = 30_000;
const usage = `Usage:
  pnpm device:e2e -- --port /dev/cu.usbmodem101 --wifi-ssid <name> \\
    --build-directory firmware/targets/m5sticks3/build [options]

Harness options:
  --tunnel-name <name>          Optional stable tunnels.iterate.com subdomain
  --mount-timeout-ms <ms>       Boot and mount deadline (default: 90000)
  --remote-hold-ms <ms>         Remote push-to-talk hold (default: 500)
  --voice                       Route Stick PCM through real Grok and inject a spoken prompt
  --grok-playback-only          Ask Grok by text and prove only Grok-to-speaker audio
  --tone-playback-only          Send a known tone through the complete provider-to-speaker lane
  --playback-endurance          Run the canonical 1m/2m/10m idle+load physical playback gate
  --tone-duration-ms <ms>       Whole 20 ms frames; 1000..600000 (default: 3000)
  --no-flash                    Wait for firmware already carrying these credentials
  --exit-after-remote-proof     Close after start/stop instead of observing the button

All firmware:flash options except --base-url and --dry-run are forwarded.
The tunnel supplies --base-url. Project credentials are generated per run when
ITERATE_KIT_PROJECT_ID / ITERATE_KIT_PROJECT_API_KEY are absent.

Required environment:
  CAPTUN_TOKEN
  ITERATE_KIT_WIFI_PASSWORD     optional when reflashing an already provisioned stick
  XAI_API_KEY                   only with --voice or --grok-playback-only

Optional environment:
  CAPTUN_GATEWAY (default: https://tunnels.iterate.com)
  CAPTUN_TUNNEL_NAME
  ITERATE_KIT_WIFI_SSID
  ITERATE_KIT_PROJECT_ID
  ITERATE_KIT_PROJECT_API_KEY
  ITERATE_KIT_PORT
  ITERATE_KIT_PYTHON
  ITERATE_KIT_ACOUSTIC_INPUT     ffmpeg AVFoundation audio input (default: :0)
  ITERATE_KIT_ACOUSTIC_OUTPUT_DIRECTORY
  ITERATE_KIT_PLAYBACK_ENDURANCE_OUTPUT_DIRECTORY
  ITERATE_KIT_FFMPEG             default: /opt/homebrew/bin/ffmpeg
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
  if (!captunToken) {
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

  const existingWifi = await readExistingWifiWhenNeeded(
    options.flash,
    options.flashArgs,
    environment,
  );
  const deviceEnvironment = {
    ...environment,
    ITERATE_KIT_WIFI_PASSWORD: environment.ITERATE_KIT_WIFI_PASSWORD ?? existingWifi?.password,
    ITERATE_KIT_WIFI_SSID: environment.ITERATE_KIT_WIFI_SSID ?? existingWifi?.ssid,
    ITERATE_KIT_PROJECT_API_KEY:
      environment.ITERATE_KIT_PROJECT_API_KEY ??
      `itxk_local_${randomBytes(24).toString("base64url")}`,
    ITERATE_KIT_PROJECT_ID:
      environment.ITERATE_KIT_PROJECT_ID ?? `prj_local_${randomBytes(8).toString("hex")}`,
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
  const toneProvider = options.tonePlaybackOnly
    ? new DeterministicPcmToneProvider({
        amplitude: 24_576,
        /*
         * Deliberately misalign provider chunks with the 640-byte device
         * frame. A physical pass must therefore cover the proxy's streaming
         * reassembly, not just an unusually convenient fixture boundary.
         */
        chunkBytes: 1_000,
        durationMs: options.toneDurationMs,
        /*
         * A 1 kHz tone contains exactly twenty cycles per 20 ms frame, making
         * a duplicated or skipped whole frame phase-invisible. 997 Hz retains
         * the simple narrow-band acoustic oracle while ensuring frame-boundary
         * discontinuities cannot accidentally join at the same phase.
         */
        frequencyHz: deterministicToneFrequencyHz,
        sampleRateHz: 16_000,
      })
    : undefined;
  const connectVoiceProvider = toneProvider
    ? () => toneProvider.connect()
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
          if (event.type === "error") {
            runtimeProbe.fail(
              new Error(`The voice provider returned an error event: ${event.raw}`),
            );
          } else if (event.type === "response.done") {
            providerResponseDone.resolve();
          }
        },
        pcmFrameBytes,
        pcmInputMode: "push-to-talk",
      }
    : undefined;
  const server = new LocalDevicePeerServer(peer, voiceServerOptions);
  let serialMonitor: PythonSerialMonitor | undefined;
  let tunnel: CaptunTunnel | undefined;

  try {
    tunnel = await createCaptunTunnel({
      fetch: (request) => server.fetch(request),
      gateway: options.gateway,
      name: options.tunnelName,
      token: captunToken,
    });
    console.log(`tunnel_ready url=${tunnel.url}`);

    if (options.flash) {
      console.log(
        `flashing device=${validatedFlashOptions.port} build=${validatedFlashOptions.buildDirectory}`,
      );
      await flashLocalM5StickS3(
        [...options.flashArgs, "--base-url", tunnel.url],
        deviceEnvironment,
        workingDirectory,
      );
      console.log("flash_verified");
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
    const description = await mounted.device.__describe();
    console.log(
      `device_mounted path=${mounted.path.join(".")} capabilities=${Object.keys(description.children).join(",")}`,
    );
    await mounted.device.subscribeToMetrics((metrics) => {
      runtimeProbe.observeCapabilityMetrics(metrics);
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

    if (options.grokPlaybackOnly || options.tonePlaybackOnly) {
      const provider = options.tonePlaybackOnly ? "deterministic-tone" : "grok";
      const expectedToneFrames = options.tonePlaybackOnly
        ? options.toneDurationMs / pcmFrameDurationMs
        : undefined;
      const acousticCapture = options.tonePlaybackOnly
        ? await MacOsPcm16Capture.start({
            ffmpegExecutable: environment.ITERATE_KIT_FFMPEG,
            input: environment.ITERATE_KIT_ACOUSTIC_INPUT,
            outputDirectory: environment.ITERATE_KIT_ACOUSTIC_OUTPUT_DIRECTORY,
          })
        : undefined;
      let acousticCaptureFinished = false;
      const prompt =
        environment.ITERATE_KIT_VOICE_PHRASE ??
        "Say exactly: Grok audio is playing directly on the Iterate device.";
      if (acousticCapture) {
        console.log(
          `acoustic_capture_ready path=${acousticCapture.artifactPath} ` +
            `sample_rate_hz=${acousticCapture.sampleRateHz}`,
        );
      }
      try {
        console.log(
          `voice_prompt_injection_started source=${provider}` +
            (expectedToneFrames === undefined
              ? ""
              : ` duration_ms=${options.toneDurationMs} expected_frames=${expectedToneFrames}`),
        );
        if (!(await server.requestVoiceText(prompt))) {
          throw new Error("The PCM proxy did not accept the direct provider turn.");
        }
        console.log(`voice_prompt_injection_complete source=${provider}`);
        const playbackMetrics = await runtimeProbe.race(
          withTimeout(
            Promise.all([
              providerResponseDone.promise,
              runtimeProbe.waitForMetrics("capability", (metrics) =>
                expectedToneFrames === undefined
                  ? devicePlaybackCompleted(firstCapabilityMetrics, metrics)
                  : devicePlaybackFramesCompleted(
                      firstCapabilityMetrics,
                      metrics,
                      expectedToneFrames,
                    ),
              ),
            ]).then(([, metrics]) => metrics),
            expectedToneFrames === undefined
              ? voiceResponseTimeoutMs
              : options.toneDurationMs + voiceResponseTimeoutMs,
            "Timed out waiting for provider audio to be consumed by the Stick speaker queue.",
          ),
        );
        console.log(`capability_playback_metrics=${JSON.stringify(playbackMetrics)}`);
        if (acousticCapture) {
          /*
           * Keep a short quiet tail after the device reports empty queues.
           * Besides protecting room-ring decay at the final edge, this catches
           * a dishonest completion metric that returns while DMA is still
           * audibly draining.
           */
          await delay(acousticCaptureTailMs);
          const recording = await acousticCapture.stop();
          acousticCaptureFinished = true;
          const analysis = await analyzeAcousticTonePcm16Artifact({
            artifactPath: recording.artifactPath,
            expectedDurationMs: options.toneDurationMs,
            frequencyHz: deterministicToneFrequencyHz,
            sampleRateHz: recording.sampleRateHz,
          });
          const assessment = assessAcousticToneAnalysis(analysis, {
            maximumAmplitudeStepDecibels: 1.5,
            maximumAmplitudeStepP99Decibels: 1.5,
            maximumDurationErrorMs: 200,
            /*
             * This is an endurance proof, not a quality score. Once the
             * overlapping detector has enough evidence to call any internal
             * window inactive, accepting it would normalize the exact audible
             * "jiggle" the harness exists to prevent.
             */
            maximumInternalGapMs: 0,
            maximumMissingToneMs: 200,
            /*
             * Magnitude stays high when hardware repeats or skips a complete
             * frame. At 997 Hz, 0.1 rad is well below the 0.377-rad signature
             * of a duplicated 20 ms frame while the median removes steady
             * speaker/microphone clock drift.
             */
            maximumPhaseStepErrorRadians: 0.1,
          });
          console.log(
            `acoustic_tone_analysis=${JSON.stringify({
              ...analysis,
              artifactPath: recording.artifactPath,
              assessment,
            })}`,
          );
          if (!assessment.passed) {
            throw new Error(
              `Physical playback continuity failed: ${assessment.reasons.join("; ")}.`,
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
        if (acousticCapture && !acousticCaptureFinished) {
          try {
            const recording = await acousticCapture.stop();
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
    toneProvider?.[Symbol.dispose]();
    peer[Symbol.dispose]();
  }
}

async function readExistingWifiWhenNeeded(
  flash: boolean,
  flashArgs: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
) {
  if (!flash || environment.ITERATE_KIT_WIFI_PASSWORD !== undefined) {
    return undefined;
  }
  const port = optionValue(flashArgs, "--port") ?? environment.ITERATE_KIT_PORT;
  if (!port) {
    return undefined;
  }
  console.log(`reading_existing_wifi_configuration device=${port}`);
  const image = await readFlashRegionWithEsptool({
    chipFamily: "ESP32-S3",
    port,
    pythonExecutable: environment.ITERATE_KIT_PYTHON,
    region: M5STICKS3_CONFIGURATION_PARTITION,
  });
  const configuration = decodeDeviceConfiguration(image);
  const requestedSsid = optionValue(flashArgs, "--wifi-ssid") ?? environment.ITERATE_KIT_WIFI_SSID;
  if (requestedSsid !== undefined && requestedSsid !== configuration.wifi.ssid) {
    throw new Error(
      "The requested Wi-Fi network differs from the stick's existing provisioning; provide ITERATE_KIT_WIFI_PASSWORD explicitly.",
    );
  }
  console.log("existing_wifi_configuration_loaded");
  return configuration.wifi;
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

class DeviceRuntimeProbe {
  readonly #continuity = new DeviceRuntimeMetricsContinuity();
  readonly #failure: Promise<never>;
  readonly #history: DeviceRuntimeLogObservation[] = [];
  readonly #waiters = new Set<ObservationWaiter>();
  #failureReason: Error | undefined;
  #lastPcmDiagnostic: string | undefined;
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
