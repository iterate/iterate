import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { connectItxReady } from "iterate/node";
import {
  analyzeAcousticTonePcm16Artifact,
  assessAcousticToneAnalysis,
} from "../src/device/acoustic-tone-analysis.ts";
import { parseKitControlDiagnostics } from "../src/device/kit-control-diagnostics.ts";
import { parseKitPlaybackMetrics } from "../src/device/kit-playback-metrics.ts";
import { MacOsPcm16Capture } from "../src/device/macos-pcm16-capture.ts";
import { m5StickS3PlaybackEnduranceAcceptancePolicy } from "../src/device/m5sticks3-playback-endurance-target.ts";
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
import {
  assessProductionM5StickS3TonePlayback,
  productionToneFrameBytes,
  productionTonePlaybackComplete,
  type ProductionM5StickS3TonePlaybackAssessment,
} from "../src/device/production-m5sticks3-tone-proof.ts";
import { inspectRetainedPcm16Artifact } from "../src/device/retained-pcm16-artifact.ts";
import type {
  KitControlDiagnostics,
  KitPlaybackMetrics,
} from "../src/device/kit-device-contract.ts";

const defaultProjectId = "prj_65441737530642949cadaf7fe399368b";
const defaultProjectSlug = "kit-stick-vertical-proof";
const defaultBaseUrl = "https://os.iterate.com";
const defaultWorkerHost = "kit--kit-stick-vertical-proof.iterate.app";
const defaultDeviceHost = "192.168.0.21";
const toneFrequencyHz = 1_000;
const remoteHoldMs = 300;
const quietTailMs = 500;
const callbackTimeoutMs = 20_000;

const usage = `Usage:
  ITERATE_KIT_PROJECT_API_KEY=... pnpm --dir apps/kit exec tsx \\
    scripts/prove-production-m5sticks3-tone.ts [options]

Options:
  --project-id <prj_...>       default: ${defaultProjectId}
  --project-slug <slug>        default: ${defaultProjectSlug}
  --base-url <origin>          default: ${defaultBaseUrl}
  --worker-host <hostname>     default: ${defaultWorkerHost}
  --device-host <address>      default: ${defaultDeviceHost}
  --output-directory <path>    default: apps/kit/evidence/m5sticks3-production-tone

Optional capture environment:
  ITERATE_KIT_ACOUSTIC_INPUT
  ITERATE_KIT_FFMPEG
  ITERATE_KIT_SOX

The project secret is accepted only through the environment and is never
written to evidence. Exit 0 means both physical audio and exact-interval
network classification passed; every other result exits nonzero.`;

interface ProductionToneCliOptions {
  acousticInput?: string;
  baseUrl: string;
  deviceHost: string;
  ffmpegExecutable?: string;
  outputDirectory: string;
  projectApiKey: string;
  projectId: string;
  projectSlug: string;
  soxExecutable?: string;
  workerHost: string;
}

interface ProductionToneProofResult {
  classification: string;
  manifestPath: string;
  networkArtifactPath: string;
  passed: boolean;
  recordingPath: string;
}

/**
 * Executes the smallest production-shaped physical proof for the Stick.
 *
 * Both PTT calls enter the same firmware event processor as Button A. This
 * runner uses remote injection because a computer cannot physically press the
 * nearby button; later Grok acceptance keeps one explicit human Button-A gate.
 * Crucially, no audio is injected through Cap'n Web: the stop event asks the
 * already-deployed userspace worker to produce a response on its independent
 * authenticated `/pcm` WebSocket.
 */
export async function proveProductionM5StickS3Tone(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<ProductionToneProofResult> {
  const options = parseOptions(args, environment);
  const routerHost = await discoverDarwinDefaultGateway();
  const runName = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const runRoot = join(options.outputDirectory, runName);
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
              code: "production-tone-itx-connect-retry",
              delayMs: retry.delayMs,
              message: retry.error.message,
            }),
          );
        },
      },
    },
  );
  const root = project.capabilityHosts.get("/");
  const invoke = async <Value>(path: string[], invokeArgs: unknown[] = []) =>
    (await root.invokeCapability({ args: invokeArgs, path })) as Value;
  const devicePath = ["kit", "m5sticks3"];
  const readDiagnostics = async () =>
    parseKitControlDiagnostics(await invoke([...devicePath, "getDiagnostics"]));

  /*
   * The firmware has two callback slots by design. The deployed userspace
   * worker owns one for PTT events; this proof owns only the remaining detailed
   * playback slot. Polling diagnostics is an ordinary bounded RPC and does not
   * consume a third callback or create a telemetry queue.
   */
  const playbackSamples: KitPlaybackMetrics[] = [];
  let playbackCallbackError: Error | undefined;
  await invoke<void>(
    [...devicePath, "subscribeToPlaybackMetrics"],
    [
      (value: unknown) => {
        try {
          playbackSamples.push(parseKitPlaybackMetrics(value));
          if (playbackSamples.length > 8) playbackSamples.shift();
        } catch (error) {
          playbackCallbackError = new Error("The device sent malformed playback metrics.", {
            cause: error,
          });
        }
      },
    ],
  );
  const baseline = await waitForQuiescentPlayback(playbackSamples, () => playbackCallbackError);

  let capture: MacOsPcm16Capture | undefined;
  let recording: Awaited<ReturnType<MacOsPcm16Capture["stop"]>> | undefined;
  let networkMonitor: PhysicalNetworkRunMonitor | undefined;
  let networkCapture: PhysicalNetworkMonitorCapture | undefined;
  let networkMeasurement: Promise<RemoteDnsAndTlsConnectMeasurement> | undefined;
  let requestMarker: Awaited<ReturnType<MacOsPcm16Capture["inspectProgress"]>> | undefined;
  let terminalPlayback: KitPlaybackMetrics = baseline;
  let playbackAssessment: ProductionM5StickS3TonePlaybackAssessment | undefined;
  let started = false;
  let stopped = false;
  let runFailure: Error | undefined;

  try {
    capture = await MacOsPcm16Capture.start({
      identityFfmpegExecutable: options.ffmpegExecutable,
      input: options.acousticInput,
      outputDirectory: runRoot,
      recorderExecutable: options.soxExecutable,
    });
    networkMonitor = new PhysicalNetworkRunMonitor({
      deviceHost: options.deviceHost,
      diagnostics: readDiagnostics,
      routerHost,
      workerHost: options.workerHost,
    });
    networkMonitor.start();
    /*
     * Start the single DNS/TLS observation inside the monitor interval. Its
     * caller-assigned coverage below is therefore conservative: it covers the
     * whole acoustic interval, while the operation itself ran at its leading
     * edge. The probe performs no hidden retry.
     */
    networkMeasurement = measureRemoteDnsAndTlsConnect(options.workerHost);

    started = (await invoke<boolean>([...devicePath, "pushToTalk", "start"])) === true;
    if (!started) throw new Error("The device rejected the remote push-to-talk start event.");
    await delay(remoteHoldMs);
    /*
     * This file-position marker is captured before the request-producing stop
     * RPC. The analyzer may ignore older coherent audio, but cannot choose a
     * convenient later episode or hide a provider response that began early.
     */
    requestMarker = await capture.inspectProgress();
    stopped = (await invoke<boolean>([...devicePath, "pushToTalk", "stop"])) === true;
    if (!stopped) throw new Error("The device rejected the remote push-to-talk stop event.");

    terminalPlayback = await waitForPlaybackResponse(
      playbackSamples,
      baseline,
      () => playbackCallbackError,
    );
    playbackAssessment = assessProductionM5StickS3TonePlayback(baseline, terminalPlayback);
    if (!playbackAssessment.passed) {
      throw new Error(playbackAssessment.reasons.join("; "));
    }
    await delay(quietTailMs);
    /*
     * Capture the latest callback after the quiet tail. If an accidental
     * second response appeared, exact deltas fail instead of blessing the
     * earlier transient terminal sample.
     */
    terminalPlayback = playbackSamples.at(-1) ?? terminalPlayback;
    playbackAssessment = assessProductionM5StickS3TonePlayback(baseline, terminalPlayback);
    if (!playbackAssessment.passed) {
      throw new Error(playbackAssessment.reasons.join("; "));
    }
  } catch (error) {
    runFailure = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (capture) {
      try {
        recording = await capture.stop();
      } catch (error) {
        runFailure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    if (networkMonitor) {
      try {
        networkCapture = await networkMonitor.capture();
      } catch (error) {
        runFailure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  if (!recording || !networkCapture) {
    const failurePath = join(runRoot, "failure.json");
    await writeExclusiveJson(failurePath, {
      createdAt: new Date().toISOString(),
      error: runFailure?.message ?? "The physical recorder or network monitor did not complete.",
      projectId: options.projectId,
      projectSlug: options.projectSlug,
      schemaVersion: 1,
      workerHost: options.workerHost,
    });
    throw new Error(
      `${runFailure?.message ?? "The physical proof did not complete."} Failure evidence: ${failurePath}`,
    );
  }

  let acousticAnalysis: Awaited<ReturnType<typeof analyzeAcousticTonePcm16Artifact>> | undefined;
  let acousticAssessment: ReturnType<typeof assessAcousticToneAnalysis> | undefined;
  if (requestMarker) {
    try {
      acousticAnalysis = await analyzeAcousticTonePcm16Artifact({
        analysisStartMs: (requestMarker.capturedSampleCount * 1_000) / requestMarker.sampleRateHz,
        artifactPath: recording.artifactPath,
        expectedDurationMs: 2_000,
        frequencyHz: toneFrequencyHz,
        sampleRateHz: recording.sampleRateHz,
      });
      acousticAssessment = assessAcousticToneAnalysis(
        acousticAnalysis,
        m5StickS3PlaybackEnduranceAcceptancePolicy.thresholds.acoustic,
      );
      if (!acousticAssessment.passed) {
        runFailure ??= new Error(acousticAssessment.reasons.join("; "));
      }
    } catch (error) {
      runFailure ??= error instanceof Error ? error : new Error(String(error));
    }
  } else {
    runFailure ??= new Error("No causal acoustic request marker was captured.");
  }

  playbackAssessment ??= assessProductionM5StickS3TonePlayback(baseline, terminalPlayback);
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
  networkCapture.dnsAndConnect = {
    coverage: { ...networkCapture.audioInterval },
    kind: "measured",
    ...dnsAndConnect,
  };
  const combinedAudioPassed =
    runFailure === undefined && playbackAssessment.passed && acousticAssessment?.passed === true;
  const networkArtifact = buildPhysicalNetworkRunArtifact({
    ...networkCapture,
    audio: {
      failure: combinedAudioPassed
        ? null
        : (runFailure?.message ?? "The physical audio acceptance gates did not pass."),
      passed: combinedAudioPassed,
    },
    pcmEvidence: {
      kind: "device-observed",
      progress: {
        /*
         * The detailed callback counts complete fixed-size downlink frames.
         * Uplink bytes deliberately remain zero: this tone proof does not
         * pretend the playback view can attest microphone delivery.
         */
        deviceToWorkerBytes: 0,
        workerToDeviceBytes:
          Math.max(0, terminalPlayback.downlinkAccepted - baseline.downlinkAccepted) *
          productionToneFrameBytes,
      },
    },
  });
  const artifactDirectory = dirname(recording.artifactPath);
  const networkArtifactPath = join(artifactDirectory, "network.json");
  await writePhysicalNetworkRunArtifact(networkArtifactPath, networkArtifact);
  const retainedRecording = await inspectRetainedPcm16Artifact({
    artifactPath: recording.artifactPath,
  });
  const passed = combinedAudioPassed && networkArtifact.classification === "valid";
  const manifestPath = join(artifactDirectory, "manifest.json");
  await writeExclusiveJson(manifestPath, {
    acoustic: {
      analysis: acousticAnalysis ?? null,
      assessment: acousticAssessment ?? null,
      capture: recording,
      marker: requestMarker ?? null,
      retainedArtifact: retainedRecording,
    },
    createdAt: new Date().toISOString(),
    device: {
      host: options.deviceHost,
      mountPath: devicePath,
    },
    network: {
      artifactPath: networkArtifactPath,
      classification: networkArtifact.classification,
      reasons: networkArtifact.network.reasons,
    },
    passed,
    playback: {
      assessment: playbackAssessment,
      baseline,
      terminal: terminalPlayback,
    },
    project: {
      baseUrl: options.baseUrl,
      id: options.projectId,
      slug: options.projectSlug,
      workerHost: options.workerHost,
    },
    remoteEvents: { started, stopped },
    schemaVersion: 1,
  });

  return {
    classification: networkArtifact.classification,
    manifestPath,
    networkArtifactPath,
    passed,
    recordingPath: recording.artifactPath,
  };
}

async function waitForQuiescentPlayback(
  samples: KitPlaybackMetrics[],
  callbackError: () => Error | undefined,
) {
  return await waitForValue(
    "two stable playback callbacks before the response",
    () => {
      const current = samples.at(-1);
      const previous = samples.at(-2);
      if (!current || !previous || !samePlaybackBoundary(previous, current)) return;
      return current;
    },
    callbackError,
  );
}

async function waitForPlaybackResponse(
  samples: KitPlaybackMetrics[],
  baseline: KitPlaybackMetrics,
  callbackError: () => Error | undefined,
) {
  return await waitForValue(
    "the deterministic response to complete on device DMA",
    () => {
      const current = samples.at(-1);
      return current && productionTonePlaybackComplete(baseline, current) ? current : undefined;
    },
    callbackError,
  );
}

function samePlaybackBoundary(left: KitPlaybackMetrics, right: KitPlaybackMetrics) {
  return (
    left.downlinkAccepted === right.downlinkAccepted &&
    left.playback.submitted === right.playback.submitted &&
    left.playback.completed === right.playback.completed &&
    left.playback.endOfStreamMarkersConsumed === right.playback.endOfStreamMarkersConsumed &&
    left.playback.endOfStreamResponses === right.playback.endOfStreamResponses
  );
}

async function waitForValue<Value>(
  description: string,
  read: () => Value | undefined,
  callbackError: () => Error | undefined,
): Promise<Value> {
  const deadline = performance.now() + callbackTimeoutMs;
  while (performance.now() < deadline) {
    const error = callbackError();
    if (error) throw error;
    const value = read();
    if (value !== undefined) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function parseOptions(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): ProductionToneCliOptions {
  let baseUrl = defaultBaseUrl;
  let deviceHost = defaultDeviceHost;
  let outputDirectory = fileURLToPath(
    new URL("../evidence/m5sticks3-production-tone", import.meta.url),
  );
  let projectId = environment.ITERATE_KIT_PROJECT_ID?.trim() || defaultProjectId;
  let projectSlug = defaultProjectSlug;
  let workerHost = defaultWorkerHost;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = () => {
      const selected = args[++index]?.trim();
      if (!selected) throw new Error(`${flag} requires a value.`);
      return selected;
    };
    if (flag === "--project-id") projectId = value();
    else if (flag === "--project-slug") projectSlug = value();
    else if (flag === "--base-url") baseUrl = value();
    else if (flag === "--worker-host") workerHost = value();
    else if (flag === "--device-host") deviceHost = value();
    else if (flag === "--output-directory") outputDirectory = value();
    else throw new Error(`Unknown option: ${flag}`);
  }

  const projectApiKey = environment.ITERATE_KIT_PROJECT_API_KEY?.trim() ?? "";
  if (!projectApiKey) throw new Error("ITERATE_KIT_PROJECT_API_KEY is required.");
  if (!/^prj_[A-Za-z0-9_-]+$/u.test(projectId)) {
    throw new Error("--project-id must be a prj_ project ID.");
  }
  const parsedBaseUrl = new URL(baseUrl);
  if (!["http:", "https:"].includes(parsedBaseUrl.protocol)) {
    throw new Error("--base-url must use HTTP or HTTPS.");
  }
  if (!workerHost.trim() || !deviceHost.trim() || !projectSlug.trim()) {
    throw new Error("Project slug, worker host, and device host must be non-empty.");
  }
  return {
    acousticInput: environment.ITERATE_KIT_ACOUSTIC_INPUT?.trim() || undefined,
    baseUrl: parsedBaseUrl.origin,
    deviceHost,
    ffmpegExecutable: environment.ITERATE_KIT_FFMPEG?.trim() || undefined,
    outputDirectory,
    projectApiKey,
    projectId,
    projectSlug,
    soxExecutable: environment.ITERATE_KIT_SOX?.trim() || undefined,
    workerHost,
  };
}

async function writeExclusiveJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function writeResultAndExit(result: ProductionToneProofResult) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, () => {
    /*
     * The project RPC session owns a WebSocket whose final close can outlive a
     * one-shot CLI. Exit only after stdout flushes; otherwise a successful
     * physical proof becomes an accidental daemon or truncates its paths.
     */
    process.exit(result.passed ? 0 : 1);
  });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], "file:"))
) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage);
  } else {
    try {
      writeResultAndExit(await proveProductionM5StickS3Tone(process.argv.slice(2), process.env));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`, () => process.exit(1));
    }
  }
}
