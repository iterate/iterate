import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { KitControlDiagnostics } from "./kit-device-contract.ts";
import type {
  LocalFetchWebSocketBridgeMetrics,
  LocalFetchWebSocketBridgeOpenEvent,
} from "./local-fetch-websocket-server.ts";
import {
  PhysicalNetworkReachabilityMonitor,
  type PhysicalReachabilitySample,
  type RemoteDnsAndTlsConnectMeasurement,
} from "./physical-network-reachability.ts";
import {
  classifyPhysicalNetworkValidity,
  type DeviceControlRoundTripSample,
  type DnsAndConnectEvidence,
  type HostReachabilityEvidence,
  type HostReachabilityTarget,
  type PhysicalAudioInterval,
  type PhysicalNetworkValidityEvidence,
  type PhysicalNetworkValidityResult,
} from "./physical-network-validity.ts";

const defaultSampleIntervalMs = 1_000;
const defaultMaximumSamples = 720;
const defaultMinimumRssiDbm = -75;
/*
 * The firmware discards stale uplink audio after 500 ms without WebSocket
 * progress. A control capability taking longer proves the real device path was
 * unavailable for at least that same freshness budget, even if ICMP happened
 * to answer and the RPC eventually completed.
 */
const defaultMaximumDeviceControlRoundTripMs = 500;
const defaultMaximumReachabilitySampleGapMs = 1_500;
const defaultMaximumRttMs = {
  device: 100,
  router: 50,
  worker: 100,
} as const satisfies Record<HostReachabilityTarget, number>;

export interface TimedLocalFetchWebSocketBridgeClose {
  closedAtMonotonicMs: number;
  metrics: LocalFetchWebSocketBridgeMetrics;
}

export interface PhysicalNetworkBridgeEvidence {
  closeEvents: readonly TimedLocalFetchWebSocketBridgeClose[];
  historyTruncated: boolean;
  openEvents: readonly LocalFetchWebSocketBridgeOpenEvent[];
}

export interface PhysicalAudioRunAssessment {
  failure: string | null;
  passed: boolean;
}

export interface PhysicalNetworkRunProgress {
  deviceToWorkerBytes: number;
  workerToDeviceBytes: number;
}

/**
 * Identifies where terminal PCM progress came from.
 *
 * A direct-LAN run owns the Node bridge and can retain its exact open/close
 * history. A deployed-worker run cannot observe that in-process bridge; it
 * instead combines device playback progress with the device's independently
 * sampled PCM connection counters. Keeping these as distinct evidence kinds
 * prevents a production proof from manufacturing a local bridge event merely
 * to satisfy the classifier.
 */
export type PhysicalNetworkPcmEvidence =
  | {
      bridgeEvidence: PhysicalNetworkBridgeEvidence;
      kind: "local-bridge";
      progress: PhysicalNetworkRunProgress;
    }
  | {
      kind: "device-observed";
      progress: PhysicalNetworkRunProgress;
    };

export type PhysicalAudioRunClassification =
  | "audio-invalid"
  | "indeterminate"
  | "network-invalid"
  | "valid";

export interface PhysicalNetworkRunArtifact {
  audio: PhysicalAudioRunAssessment;
  classification: PhysicalAudioRunClassification;
  createdAt: string;
  diagnostics: readonly PhysicalDeviceDiagnosticsObservation[];
  network: PhysicalNetworkValidityResult;
  rawPcmEvidence: PhysicalNetworkPcmEvidence;
  rawReachabilitySamples: readonly PhysicalReachabilitySample[];
  schemaVersion: 3;
}

export type PhysicalDeviceDiagnosticsObservation =
  | {
      completedAtMonotonicMs: number;
      diagnostics: KitControlDiagnostics;
      outcome: "success";
      startedAtMonotonicMs: number;
    }
  | {
      completedAtMonotonicMs: number;
      error: string;
      outcome: "failure";
      startedAtMonotonicMs: number;
    };

interface DiagnosticsSamplerOptions {
  maximumSamples: number;
  monotonicNow: () => number;
  sample: () => Promise<KitControlDiagnostics>;
  sampleIntervalMs: number;
}

/*
 * Diagnostics are deliberately pulled from a low-rate Cap'n Web operation,
 * never from the audio task or the PCM socket. Only one request may be in
 * flight. If a request overruns its period, the skipped periods remain absent
 * evidence instead of becoming a catch-up RPC burst which competes with fresh
 * audio and makes the recovered interval look healthier than it was.
 *
 * One slot is reserved for a terminal sample. That sample closes the last
 * sub-second attribution hole without allowing an arbitrarily long or stuck
 * run to grow host memory.
 */
class PhysicalDeviceDiagnosticsSampler {
  readonly #maximumSamples: number;
  readonly #monotonicNow: () => number;
  readonly #sample: () => Promise<KitControlDiagnostics>;
  readonly #sampleIntervalMs: number;
  readonly #samples: PhysicalDeviceDiagnosticsObservation[] = [];
  readonly #stopSignal = Promise.withResolvers<void>();
  #runPromise: Promise<void> | undefined;
  #stopping = false;

  constructor(options: DiagnosticsSamplerOptions) {
    this.#maximumSamples = options.maximumSamples;
    this.#monotonicNow = options.monotonicNow;
    this.#sample = options.sample;
    this.#sampleIntervalMs = options.sampleIntervalMs;
  }

  start() {
    if (this.#runPromise) {
      throw new Error("Physical device diagnostics sampling has already started.");
    }
    this.#runPromise = this.#run();
  }

  async stop() {
    this.#stopping = true;
    this.#stopSignal.resolve();
    await this.#runPromise;
    if (this.#samples.length < this.#maximumSamples) {
      await this.#capture();
    }
    return this.#samples.map((sample) => ({ ...sample }));
  }

  async #capture() {
    const startedAtMonotonicMs = this.#monotonicNow();
    try {
      const diagnostics = await this.#sample();
      this.#samples.push({
        completedAtMonotonicMs: this.#monotonicNow(),
        diagnostics,
        outcome: "success",
        startedAtMonotonicMs,
      });
    } catch (error) {
      this.#samples.push({
        completedAtMonotonicMs: this.#monotonicNow(),
        error: error instanceof Error ? error.message : String(error),
        outcome: "failure",
        startedAtMonotonicMs,
      });
    }
  }

  async #run() {
    let nextSampleAt = this.#monotonicNow();
    /*
     * The terminal reservation is part of the bound, not an extra allocation
     * accidentally added after the cap has been reached.
     */
    while (!this.#stopping && this.#samples.length < this.#maximumSamples - 1) {
      await this.#capture();
      nextSampleAt += this.#sampleIntervalMs;
      const now = this.#monotonicNow();
      while (nextSampleAt <= now) nextSampleAt += this.#sampleIntervalMs;
      if (this.#stopping) break;
      await Promise.race([delay(nextSampleAt - now), this.#stopSignal.promise]);
    }
  }
}

export interface PhysicalNetworkRunMonitorOptions {
  deviceHost: string;
  diagnostics: () => Promise<KitControlDiagnostics>;
  dnsAndConnect?: DnsAndConnectEvidence;
  maximumSamples?: number;
  monotonicNow?: () => number;
  routerHost: string;
  sampleIntervalMs?: number;
  workerHost: string;
}

export interface PhysicalNetworkRunArtifactInput {
  audio: PhysicalAudioRunAssessment;
  audioInterval: PhysicalAudioInterval;
  diagnostics: readonly PhysicalDeviceDiagnosticsObservation[];
  dnsAndConnect: DnsAndConnectEvidence;
  pcmEvidence: PhysicalNetworkPcmEvidence;
  reachability: readonly PhysicalReachabilitySample[];
  reachabilitySampleIntervalMs: number;
}

export type PhysicalNetworkMonitorCapture = Omit<
  PhysicalNetworkRunArtifactInput,
  "audio" | "pcmEvidence"
>;

/**
 * Aligns one bounded production DNS/TLS probe with the media interval whose
 * attribution it supports.
 *
 * The reachability monitor starts all three ping lanes at the audio boundary,
 * while DNS/TLS is an independent one-shot promise. Keeping the coverage join
 * here gives every deployed-device harness the same failure-closed meaning for
 * an absent measurement instead of copying subtly different placeholder
 * evidence into each script.
 */
export function withRemoteDnsAndConnectMeasurement(
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

/**
 * Captures bounded, exact-interval network evidence without touching PCM data.
 *
 * Start this immediately before the provider request/PTT transition and finish
 * it only after device playback or the held-uplink assertion has completed.
 * The interval therefore conservatively includes the two low-rate diagnostic
 * boundary reads as well as all audible/media work.
 */
export class PhysicalNetworkRunMonitor {
  readonly #diagnosticsSampler: PhysicalDeviceDiagnosticsSampler;
  readonly #dnsAndConnect: DnsAndConnectEvidence;
  readonly #monotonicNow: () => number;
  readonly #reachability: PhysicalNetworkReachabilityMonitor;
  readonly #sampleIntervalMs: number;
  #finished = false;
  #startedAtMonotonicMs: number | undefined;

  constructor(options: PhysicalNetworkRunMonitorOptions) {
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#sampleIntervalMs = options.sampleIntervalMs ?? defaultSampleIntervalMs;
    const maximumSamples = options.maximumSamples ?? defaultMaximumSamples;
    this.#dnsAndConnect = options.dnsAndConnect ?? {
      kind: "not-applicable",
      reason: "direct-lan",
    };
    this.#diagnosticsSampler = new PhysicalDeviceDiagnosticsSampler({
      maximumSamples,
      monotonicNow: this.#monotonicNow,
      sample: options.diagnostics,
      sampleIntervalMs: this.#sampleIntervalMs,
    });
    this.#reachability = new PhysicalNetworkReachabilityMonitor({
      intervalMs: this.#sampleIntervalMs,
      maximumSamplesPerTarget: maximumSamples,
      monotonicNow: this.#monotonicNow,
      targets: [
        { host: options.deviceHost, target: "device" },
        { host: options.routerHost, target: "router" },
        { host: options.workerHost, target: "worker" },
      ],
    });
  }

  start() {
    if (this.#startedAtMonotonicMs !== undefined) {
      throw new Error("Physical network run monitoring has already started.");
    }
    this.#startedAtMonotonicMs = this.#monotonicNow();
    this.#reachability.start();
    this.#diagnosticsSampler.start();
  }

  async capture(): Promise<PhysicalNetworkMonitorCapture> {
    const startedAtMonotonicMs = this.#startedAtMonotonicMs;
    if (startedAtMonotonicMs === undefined) {
      throw new Error("Physical network run monitoring has not started.");
    }
    if (this.#finished) {
      throw new Error("Physical network run monitoring has already finished.");
    }
    this.#finished = true;
    const [diagnostics, reachability] = await Promise.all([
      this.#diagnosticsSampler.stop(),
      this.#reachability.stop(),
    ]);
    const audioInterval = {
      completedAtMonotonicMs: this.#monotonicNow(),
      startedAtMonotonicMs,
    };
    return {
      audioInterval,
      diagnostics,
      dnsAndConnect: this.#dnsAndConnect,
      reachability,
      reachabilitySampleIntervalMs: this.#sampleIntervalMs,
    };
  }

  async finish(options: {
    audio: PhysicalAudioRunAssessment;
    pcmEvidence: PhysicalNetworkPcmEvidence;
  }): Promise<PhysicalNetworkRunArtifact> {
    const capture = await this.capture();
    return buildPhysicalNetworkRunArtifact({
      audio: options.audio,
      pcmEvidence: options.pcmEvidence,
      ...capture,
    });
  }
}

export function buildPhysicalNetworkRunArtifact(
  options: PhysicalNetworkRunArtifactInput,
): PhysicalNetworkRunArtifact {
  const successfulDiagnostics = options.diagnostics.filter(
    (
      observation,
    ): observation is Extract<PhysicalDeviceDiagnosticsObservation, { outcome: "success" }> =>
      observation.outcome === "success" &&
      observation.completedAtMonotonicMs >= options.audioInterval.startedAtMonotonicMs &&
      observation.completedAtMonotonicMs <= options.audioInterval.completedAtMonotonicMs,
  );
  /*
   * An evidence producer may retain adjacent setup/teardown observations for
   * debugging. They are useful raw facts, but they are not expected samples
   * for this media interval and therefore must neither dilute coverage nor
   * turn a clean call into an incomplete-evidence verdict.
   */
  const expectedDiagnosticsSamples = options.diagnostics.filter(
    ({ completedAtMonotonicMs }) =>
      completedAtMonotonicMs >= options.audioInterval.startedAtMonotonicMs &&
      completedAtMonotonicMs <= options.audioInterval.completedAtMonotonicMs,
  ).length;
  const coverage = { ...options.audioInterval };
  const socketCounters = successfulDiagnostics.map((observation) => {
    const { control, network } = observation.diagnostics;
    return {
      capturedAtMonotonicMs: observation.completedAtMonotonicMs,
      control: {
        connected: true,
        disconnectCount: control.websocketDisconnects,
        reconnectCount: control.websocketConnections,
        transportErrorCount: control.websocketErrors,
      },
      device: {
        capturedAtMonotonicMs: observation.completedAtMonotonicMs,
        linkUp: network.wifiConnected,
        rssiDbm: network.wifiRssiDbm ?? null,
        wifiDisconnectCount: control.wifiDisconnects,
      },
      pcm: {
        connected: network.pcmWebsocketConnections > network.pcmWebsocketDisconnects,
        disconnectCount: network.pcmWebsocketDisconnects,
        lowerTransportFailureCount:
          observation.diagnostics.schemaVersion === 4
            ? observation.diagnostics.network.pcmTransportFailureIncidents
            : undefined,
        reconnectCount: network.pcmWebsocketConnections,
        transportErrorCount: network.pcmWebsocketErrors,
      },
    };
  });
  const reachabilityForTarget = (target: HostReachabilityTarget): HostReachabilityEvidence => {
    const samples = options.reachability
      .filter(
        (sample) =>
          sample.target === target &&
          sample.startedAtMonotonicMs >= options.audioInterval.startedAtMonotonicMs &&
          sample.startedAtMonotonicMs <= options.audioInterval.completedAtMonotonicMs,
      )
      .map((sample) =>
        sample.outcome === "reply" && sample.rttMs !== undefined
          ? {
              completedAtMonotonicMs: sample.completedAtMonotonicMs,
              outcome: "reply" as const,
              rttMs: sample.rttMs,
              scheduledAtMonotonicMs: sample.startedAtMonotonicMs,
            }
          : {
              outcome:
                sample.outcome === "timeout" ? ("timeout" as const) : ("unreachable" as const),
              scheduledAtMonotonicMs: sample.startedAtMonotonicMs,
            },
      );
    return {
      coverage,
      expectedSampleCount: samples.length,
      maximumHealthyRttMs: defaultMaximumRttMs[target],
      maximumHealthySampleGapMs: Math.max(
        defaultMaximumReachabilitySampleGapMs,
        options.reachabilitySampleIntervalMs * 1.5,
      ),
      samples,
    };
  };
  const hostReachability = {
    device: reachabilityForTarget("device"),
    router: reachabilityForTarget("router"),
    worker: reachabilityForTarget("worker"),
  };
  const firstDiagnostics = successfulDiagnostics[0]?.diagnostics;
  const finalDiagnostics = successfulDiagnostics.at(-1)?.diagnostics;
  const bridgeEvidence =
    options.pcmEvidence.kind === "local-bridge" ? options.pcmEvidence.bridgeEvidence : undefined;
  const pcmOpenEvents =
    bridgeEvidence?.openEvents.filter(
      (event) =>
        event.endpoint === "/pcm" &&
        event.startedAtMonotonicMs <= options.audioInterval.completedAtMonotonicMs,
    ) ?? [];
  const latestPcmOpen = pcmOpenEvents.at(-1);
  const pcmCloseEvents =
    bridgeEvidence?.closeEvents.filter(
      ({ closedAtMonotonicMs, metrics }) =>
        metrics.endpoint === "/pcm" &&
        closedAtMonotonicMs >= options.audioInterval.startedAtMonotonicMs &&
        closedAtMonotonicMs <= options.audioInterval.completedAtMonotonicMs,
    ) ?? [];
  const bridgeSaysOpen =
    latestPcmOpen === undefined
      ? undefined
      : !bridgeEvidence?.closeEvents.some(
          ({ closedAtMonotonicMs, metrics }) =>
            metrics.endpoint === "/pcm" &&
            closedAtMonotonicMs >= latestPcmOpen.startedAtMonotonicMs &&
            closedAtMonotonicMs <= options.audioInterval.completedAtMonotonicMs,
        );
  const deviceSaysOpen = finalDiagnostics
    ? finalDiagnostics.network.pcmWebsocketConnections >
      finalDiagnostics.network.pcmWebsocketDisconnects
    : undefined;
  const counterDelta = (current: number | undefined, baseline: number | undefined) =>
    Math.max(0, (current ?? 0) - (baseline ?? 0));
  const terminalPcmSocket =
    firstDiagnostics && finalDiagnostics
      ? {
          coverage,
          disconnectCount: Math.max(
            counterDelta(
              finalDiagnostics.network.pcmWebsocketDisconnects,
              firstDiagnostics.network.pcmWebsocketDisconnects,
            ),
            pcmCloseEvents.length,
          ),
          lowerTransportFailureCount:
            firstDiagnostics.schemaVersion === 4 && finalDiagnostics.schemaVersion === 4
              ? counterDelta(
                  finalDiagnostics.network.pcmTransportFailureIncidents,
                  firstDiagnostics.network.pcmTransportFailureIncidents,
                )
              : undefined,
          receivedBytes: options.pcmEvidence.progress.workerToDeviceBytes,
          reconnectCount: Math.max(
            counterDelta(
              finalDiagnostics.network.pcmWebsocketConnections,
              firstDiagnostics.network.pcmWebsocketConnections,
            ),
            pcmOpenEvents.filter(
              ({ startedAtMonotonicMs }) =>
                startedAtMonotonicMs >= options.audioInterval.startedAtMonotonicMs,
            ).length,
          ),
          sentBytes: options.pcmEvidence.progress.deviceToWorkerBytes,
          stateAtIntervalEnd:
            bridgeEvidence?.historyTruncated === true
              ? ("unknown" as const)
              : options.pcmEvidence.kind === "device-observed"
                ? deviceSaysOpen === true
                  ? ("open" as const)
                  : deviceSaysOpen === false
                    ? ("closed" as const)
                    : ("unknown" as const)
                : bridgeSaysOpen && deviceSaysOpen
                  ? ("open" as const)
                  : bridgeSaysOpen === false || deviceSaysOpen === false
                    ? ("closed" as const)
                    : ("unknown" as const),
          transportErrorCount: Math.max(
            counterDelta(
              finalDiagnostics.network.pcmWebsocketErrors,
              firstDiagnostics.network.pcmWebsocketErrors,
            ),
            pcmCloseEvents.filter(({ metrics }) => metrics.closeCode !== 1000).length,
          ),
        }
      : undefined;
  const evidence: PhysicalNetworkValidityEvidence = {
    audioInterval: options.audioInterval,
    deviceControlRoundTrips: {
      coverage,
      expectedSampleCount: expectedDiagnosticsSamples,
      maximumHealthyDurationMs: defaultMaximumDeviceControlRoundTripMs,
      samples: options.diagnostics
        .filter(
          ({ completedAtMonotonicMs, startedAtMonotonicMs }) =>
            startedAtMonotonicMs >= options.audioInterval.startedAtMonotonicMs &&
            completedAtMonotonicMs <= options.audioInterval.completedAtMonotonicMs,
        )
        .map<DeviceControlRoundTripSample>((observation) =>
          observation.outcome === "success"
            ? {
                completedAtMonotonicMs: observation.completedAtMonotonicMs,
                durationMs: observation.completedAtMonotonicMs - observation.startedAtMonotonicMs,
                outcome: "success",
                startedAtMonotonicMs: observation.startedAtMonotonicMs,
              }
            : {
                completedAtMonotonicMs: observation.completedAtMonotonicMs,
                error: observation.error,
                outcome: "failure",
                startedAtMonotonicMs: observation.startedAtMonotonicMs,
              },
        ),
    },
    deviceNetwork: {
      coverage,
      expectedSampleCount: expectedDiagnosticsSamples,
      minimumRssiDbm: defaultMinimumRssiDbm,
      samples: socketCounters.map(({ device }) => device),
    },
    dnsAndConnect: options.dnsAndConnect,
    hostReachability,
    socketCounters: {
      control: {
        coverage,
        expectedSampleCount: expectedDiagnosticsSamples,
        samples: socketCounters.map(({ capturedAtMonotonicMs, control }) => ({
          capturedAtMonotonicMs,
          ...control,
        })),
      },
      pcm: {
        coverage,
        expectedSampleCount: expectedDiagnosticsSamples,
        samples: socketCounters.map(({ capturedAtMonotonicMs, pcm }) => ({
          capturedAtMonotonicMs,
          ...pcm,
        })),
      },
    },
    terminalPcmSocket,
  };
  const network = classifyPhysicalNetworkValidity(evidence);
  const classification =
    network.verdict === "network-invalid"
      ? "network-invalid"
      : network.verdict === "indeterminate"
        ? "indeterminate"
        : options.audio.passed
          ? "valid"
          : "audio-invalid";
  return {
    audio: options.audio,
    classification,
    createdAt: new Date().toISOString(),
    diagnostics: options.diagnostics,
    network,
    rawPcmEvidence: structuredClone(options.pcmEvidence),
    rawReachabilitySamples: options.reachability,
    schemaVersion: 3,
  };
}

export async function writePhysicalNetworkRunArtifact(
  path: string,
  artifact: PhysicalNetworkRunArtifact,
) {
  await mkdir(dirname(path), { recursive: true });
  /*
   * Physical evidence is append-only. Refusing to overwrite an existing
   * verdict prevents a later rerun from silently replacing the exact interval
   * which an observation note or hash already references.
   */
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}
