export interface PhysicalAudioInterval {
  completedAtMonotonicMs: number;
  startedAtMonotonicMs: number;
}

export interface ExactIntervalSampleSeries<Sample> {
  coverage: PhysicalAudioInterval;
  expectedSampleCount: number;
  samples: readonly Sample[];
}

export type HostReachabilityTarget = "device" | "router" | "worker";

export type HostReachabilitySample =
  | {
      completedAtMonotonicMs: number;
      outcome: "reply";
      rttMs: number;
      scheduledAtMonotonicMs: number;
    }
  | {
      outcome: "timeout" | "unreachable";
      scheduledAtMonotonicMs: number;
    };

export interface HostReachabilityEvidence extends ExactIntervalSampleSeries<HostReachabilitySample> {
  maximumHealthySampleGapMs: number;
  maximumHealthyRttMs: number;
}

export interface DeviceNetworkSample {
  capturedAtMonotonicMs: number;
  linkUp: boolean;
  rssiDbm: number | null;
  wifiDisconnectCount: number;
}

export interface DeviceNetworkEvidence extends ExactIntervalSampleSeries<DeviceNetworkSample> {
  minimumRssiDbm: number;
}

export type DeviceControlRoundTripSample =
  | {
      completedAtMonotonicMs: number;
      durationMs: number;
      outcome: "success";
      startedAtMonotonicMs: number;
    }
  | {
      completedAtMonotonicMs: number;
      error: string;
      outcome: "failure";
      startedAtMonotonicMs: number;
    };

/**
 * End-to-end latency of the real Cap'n Web diagnostics capability.
 *
 * ICMP can establish host reachability but cannot prove that the application
 * path used beside PCM remained schedulable. This lane deliberately measures
 * the mounted device capability through the same production control plane.
 */
export interface DeviceControlRoundTripEvidence extends ExactIntervalSampleSeries<DeviceControlRoundTripSample> {
  maximumHealthyDurationMs: number;
}

export interface SocketCounterSample {
  capturedAtMonotonicMs: number;
  connected: boolean;
  disconnectCount: number;
  /** Exact platform-level connect/read/write incidents when the device exposes schema v4. */
  lowerTransportFailureCount?: number;
  reconnectCount: number;
  transportErrorCount: number;
}

export interface BoundedOperationEvidence {
  durationMs: number | null;
  error: string | null;
  maximumHealthyDurationMs: number;
  outcome: "failure" | "not-observed" | "success";
}

export type DnsAndConnectEvidence =
  | {
      kind: "measured";
      connect: BoundedOperationEvidence;
      coverage: PhysicalAudioInterval;
      dns: BoundedOperationEvidence;
    }
  | {
      kind: "not-applicable";
      reason: "direct-lan";
    };

/**
 * PCM state sampled at the audio interval boundary, before harness teardown.
 *
 * This must not be synthesized from `onBridgeClosed`: the normal close occurs
 * after the interval and would falsely classify every successful run as an
 * in-window disconnect. The later full bridge-close aggregate remains raw
 * transport evidence beside this classifier result.
 */
export interface TerminalPcmSocketAggregate {
  coverage: PhysicalAudioInterval;
  disconnectCount: number;
  lowerTransportFailureCount?: number;
  receivedBytes: number;
  reconnectCount: number;
  sentBytes: number;
  stateAtIntervalEnd: "closed" | "open" | "unknown";
  transportErrorCount: number;
}

export interface PhysicalNetworkValidityEvidence {
  audioInterval: PhysicalAudioInterval;
  deviceControlRoundTrips?: DeviceControlRoundTripEvidence;
  deviceNetwork?: DeviceNetworkEvidence;
  dnsAndConnect?: DnsAndConnectEvidence;
  hostReachability?: Partial<Record<HostReachabilityTarget, HostReachabilityEvidence>>;
  socketCounters?: {
    control?: ExactIntervalSampleSeries<SocketCounterSample>;
    pcm?: ExactIntervalSampleSeries<SocketCounterSample>;
  };
  terminalPcmSocket?: TerminalPcmSocketAggregate;
}

export interface PhysicalNetworkValidityReason {
  code: string;
  message: string;
}

export interface PhysicalNetworkValidityResult {
  evidence: PhysicalNetworkValidityEvidence;
  reasons: PhysicalNetworkValidityReason[];
  verdict: "indeterminate" | "network-invalid" | "valid";
}

const hostReachabilityTargets = ["device", "router", "worker"] satisfies HostReachabilityTarget[];
const socketCounterLanes = ["control", "pcm"] satisfies Array<"control" | "pcm">;

function intervalsMatch(left: PhysicalAudioInterval, right: PhysicalAudioInterval) {
  return (
    left.startedAtMonotonicMs === right.startedAtMonotonicMs &&
    left.completedAtMonotonicMs === right.completedAtMonotonicMs
  );
}

function intervalContains(interval: PhysicalAudioInterval, timestamp: number) {
  return timestamp >= interval.startedAtMonotonicMs && timestamp <= interval.completedAtMonotonicMs;
}

/**
 * Classifies only the physical network evidence aligned to one audio interval.
 *
 * The raw evidence remains attached because the verdict is a routing decision,
 * not a replacement for the measurements needed to diagnose the run.
 */
export function classifyPhysicalNetworkValidity(
  evidence: PhysicalNetworkValidityEvidence,
): PhysicalNetworkValidityResult {
  const networkInvalidReasons: PhysicalNetworkValidityReason[] = [];
  const indeterminateReasons: PhysicalNetworkValidityReason[] = [];

  if (!evidence.deviceControlRoundTrips) {
    indeterminateReasons.push({
      code: "missing-device-control-round-trips",
      message: "Device control round-trip evidence is missing.",
    });
  } else {
    const series = evidence.deviceControlRoundTrips;
    if (!intervalsMatch(series.coverage, evidence.audioInterval)) {
      indeterminateReasons.push({
        code: "misaligned-device-control-round-trips",
        message: "Device control round trips do not cover the exact audio interval.",
      });
    }
    if (
      !Number.isSafeInteger(series.expectedSampleCount) ||
      series.expectedSampleCount < 2 ||
      series.samples.length !== series.expectedSampleCount
    ) {
      indeterminateReasons.push({
        code: "incomplete-device-control-round-trips",
        message:
          `Device control round-trip evidence contains ${series.samples.length} of ` +
          `${series.expectedSampleCount} expected samples.`,
      });
    }
    for (const sample of series.samples) {
      if (
        !intervalContains(evidence.audioInterval, sample.startedAtMonotonicMs) ||
        !intervalContains(evidence.audioInterval, sample.completedAtMonotonicMs)
      ) {
        indeterminateReasons.push({
          code: "device-control-round-trip-outside-interval",
          message:
            `Device control round trip from ${sample.startedAtMonotonicMs} ms to ` +
            `${sample.completedAtMonotonicMs} ms is outside the audio interval.`,
        });
        continue;
      }
      if (sample.outcome === "failure") {
        networkInvalidReasons.push({
          code: "device-control-round-trip-failed",
          message: `Device control round trip failed: ${sample.error}.`,
        });
        continue;
      }
      if (sample.durationMs > series.maximumHealthyDurationMs) {
        networkInvalidReasons.push({
          code: "device-control-round-trip-duration-exceeded",
          message:
            `Device control round trip took ${sample.durationMs} ms, exceeding its ` +
            `${series.maximumHealthyDurationMs} ms healthy budget.`,
        });
      }
    }
  }

  if (!evidence.deviceNetwork) {
    indeterminateReasons.push({
      code: "missing-device-network",
      message: "Device network evidence is missing.",
    });
  } else {
    if (!intervalsMatch(evidence.deviceNetwork.coverage, evidence.audioInterval)) {
      indeterminateReasons.push({
        code: "misaligned-device-network",
        message: "Device network evidence does not cover the exact audio interval.",
      });
    }
    if (
      !Number.isSafeInteger(evidence.deviceNetwork.expectedSampleCount) ||
      evidence.deviceNetwork.expectedSampleCount < 2 ||
      evidence.deviceNetwork.samples.length !== evidence.deviceNetwork.expectedSampleCount
    ) {
      indeterminateReasons.push({
        code: "incomplete-device-network",
        message:
          `Device network evidence contains ${evidence.deviceNetwork.samples.length} of ` +
          `${evidence.deviceNetwork.expectedSampleCount} expected samples.`,
      });
    }
    const baseline = evidence.deviceNetwork.samples.find((sample) =>
      intervalContains(evidence.audioInterval, sample.capturedAtMonotonicMs),
    );
    for (const sample of evidence.deviceNetwork.samples) {
      if (!intervalContains(evidence.audioInterval, sample.capturedAtMonotonicMs)) {
        indeterminateReasons.push({
          code: "device-network-sample-outside-interval",
          message:
            `Device network sample at ${sample.capturedAtMonotonicMs} ms is outside ` +
            "the audio interval.",
        });
        continue;
      }
      if (!sample.linkUp) {
        networkInvalidReasons.push({
          code: "device-link-down",
          message: `Device link was down at ${sample.capturedAtMonotonicMs} ms.`,
        });
      }
      if (sample.rssiDbm === null) {
        indeterminateReasons.push({
          code: "missing-device-rssi",
          message: `Device RSSI is missing at ${sample.capturedAtMonotonicMs} ms.`,
        });
      } else if (sample.rssiDbm < evidence.deviceNetwork.minimumRssiDbm) {
        networkInvalidReasons.push({
          code: "device-rssi-below-minimum",
          message:
            `Device RSSI ${sample.rssiDbm} dBm was below ` +
            `${evidence.deviceNetwork.minimumRssiDbm} dBm at ` +
            `${sample.capturedAtMonotonicMs} ms.`,
        });
      }
      if (baseline && sample.wifiDisconnectCount > baseline.wifiDisconnectCount) {
        networkInvalidReasons.push({
          code: "device-wifi-disconnect",
          message:
            `Device Wi-Fi disconnect count increased from ${baseline.wifiDisconnectCount} ` +
            `to ${sample.wifiDisconnectCount}.`,
        });
      }
    }
  }

  for (const target of hostReachabilityTargets) {
    const reachability = evidence.hostReachability?.[target];
    if (!reachability) {
      indeterminateReasons.push({
        code: "missing-host-reachability",
        message: `${target} reachability evidence is missing.`,
      });
      continue;
    }
    if (!intervalsMatch(reachability.coverage, evidence.audioInterval)) {
      indeterminateReasons.push({
        code: "misaligned-host-reachability",
        message: `${target} reachability evidence does not cover the exact audio interval.`,
      });
    }
    if (
      !Number.isSafeInteger(reachability.expectedSampleCount) ||
      reachability.expectedSampleCount < 1 ||
      reachability.samples.length !== reachability.expectedSampleCount
    ) {
      indeterminateReasons.push({
        code: "incomplete-host-reachability",
        message:
          `${target} reachability evidence contains ${reachability.samples.length} of ` +
          `${reachability.expectedSampleCount} expected samples.`,
      });
    }
    const orderedSamples = [...reachability.samples].sort(
      (left, right) => left.scheduledAtMonotonicMs - right.scheduledAtMonotonicMs,
    );
    const coverageBoundaries = [
      evidence.audioInterval.startedAtMonotonicMs,
      ...orderedSamples.map(({ scheduledAtMonotonicMs }) => scheduledAtMonotonicMs),
      evidence.audioInterval.completedAtMonotonicMs,
    ];
    for (let index = 1; index < coverageBoundaries.length; index += 1) {
      const gapMs = coverageBoundaries[index]! - coverageBoundaries[index - 1]!;
      if (gapMs <= reachability.maximumHealthySampleGapMs) continue;
      indeterminateReasons.push({
        code: "host-reachability-coverage-gap",
        message:
          `${target} reachability evidence contains a ${gapMs} ms gap, exceeding ` +
          `${reachability.maximumHealthySampleGapMs} ms.`,
      });
    }
    for (const sample of orderedSamples) {
      if (!intervalContains(evidence.audioInterval, sample.scheduledAtMonotonicMs)) {
        indeterminateReasons.push({
          code: "host-reachability-sample-outside-interval",
          message:
            `${target} reachability probe at ${sample.scheduledAtMonotonicMs} ms is outside ` +
            "the audio interval.",
        });
        continue;
      }
      if (sample.outcome === "reply") {
        if (sample.rttMs > reachability.maximumHealthyRttMs) {
          networkInvalidReasons.push({
            code: "host-rtt-exceeded",
            message:
              `${target} RTT ${sample.rttMs} ms exceeded ` +
              `${reachability.maximumHealthyRttMs} ms at ` +
              `${sample.scheduledAtMonotonicMs} ms.`,
          });
        }
        continue;
      }
      networkInvalidReasons.push({
        code: `host-reachability-${sample.outcome}`,
        message:
          `${target} reachability probe ${sample.outcome === "timeout" ? "timed out" : "failed"} ` +
          `at ${sample.scheduledAtMonotonicMs} ms.`,
      });
    }
  }

  for (const lane of socketCounterLanes) {
    const series = evidence.socketCounters?.[lane];
    if (!series) {
      indeterminateReasons.push({
        code: `missing-${lane}-socket-counters`,
        message: `${lane} socket counter evidence is missing.`,
      });
      continue;
    }
    if (!intervalsMatch(series.coverage, evidence.audioInterval)) {
      indeterminateReasons.push({
        code: `misaligned-${lane}-socket-counters`,
        message: `${lane} socket counters do not cover the exact audio interval.`,
      });
    }
    if (
      !Number.isSafeInteger(series.expectedSampleCount) ||
      series.expectedSampleCount < 2 ||
      series.samples.length !== series.expectedSampleCount
    ) {
      indeterminateReasons.push({
        code: `incomplete-${lane}-socket-counters`,
        message:
          `${lane} socket counters contain ${series.samples.length} of ` +
          `${series.expectedSampleCount} expected samples.`,
      });
    }
    const baseline = series.samples.find((sample) =>
      intervalContains(evidence.audioInterval, sample.capturedAtMonotonicMs),
    );
    for (const sample of series.samples) {
      if (!intervalContains(evidence.audioInterval, sample.capturedAtMonotonicMs)) {
        indeterminateReasons.push({
          code: `${lane}-socket-sample-outside-interval`,
          message:
            `${lane} socket sample at ${sample.capturedAtMonotonicMs} ms is outside ` +
            "the audio interval.",
        });
        continue;
      }
      if (!sample.connected) {
        networkInvalidReasons.push({
          code: `${lane}-socket-disconnected`,
          message: `${lane} socket was disconnected at ${sample.capturedAtMonotonicMs} ms.`,
        });
      }
      for (const [counter, label] of [
        ["reconnectCount", "reconnect"],
        ["disconnectCount", "disconnect"],
        ["transportErrorCount", "transport error"],
      ] satisfies Array<["disconnectCount" | "reconnectCount" | "transportErrorCount", string]>) {
        if (!baseline || sample[counter] <= baseline[counter]) continue;
        networkInvalidReasons.push({
          code: `${lane}-socket-${label.replace(" ", "-")}`,
          message:
            `${lane} socket ${label} count increased from ${baseline[counter]} ` +
            `to ${sample[counter]}.`,
        });
      }
      if (
        baseline?.lowerTransportFailureCount !== undefined &&
        sample.lowerTransportFailureCount !== undefined &&
        sample.lowerTransportFailureCount > baseline.lowerTransportFailureCount
      ) {
        networkInvalidReasons.push({
          code: `${lane}-socket-lower-transport-failure`,
          message:
            `${lane} socket lower-transport failure count increased from ` +
            `${baseline.lowerTransportFailureCount} to ${sample.lowerTransportFailureCount}.`,
        });
      }
    }
  }

  if (!evidence.dnsAndConnect) {
    indeterminateReasons.push({
      code: "missing-dns-and-connect",
      message: "DNS/connect evidence or explicit direct-LAN applicability is missing.",
    });
  } else if (evidence.dnsAndConnect.kind === "measured") {
    if (!intervalsMatch(evidence.dnsAndConnect.coverage, evidence.audioInterval)) {
      indeterminateReasons.push({
        code: "misaligned-dns-and-connect",
        message: "DNS/connect evidence does not cover the exact audio interval.",
      });
    }
    for (const [name, operation] of [
      ["dns", evidence.dnsAndConnect.dns],
      ["connect", evidence.dnsAndConnect.connect],
    ] satisfies Array<["connect" | "dns", BoundedOperationEvidence]>) {
      if (operation.outcome === "failure") {
        networkInvalidReasons.push({
          code: `${name}-failed`,
          message: `${name.toUpperCase()} failed: ${operation.error ?? "unspecified error"}.`,
        });
      } else if (operation.outcome === "not-observed") {
        indeterminateReasons.push({
          code: `${name}-not-observed`,
          message: `${name.toUpperCase()} was not observed for the audio interval.`,
        });
      } else if (operation.durationMs === null) {
        indeterminateReasons.push({
          code: `${name}-duration-missing`,
          message: `${name.toUpperCase()} succeeded without a duration measurement.`,
        });
      } else if (operation.durationMs > operation.maximumHealthyDurationMs) {
        networkInvalidReasons.push({
          code: `${name}-duration-exceeded`,
          message:
            `${name.toUpperCase()} duration ${operation.durationMs} ms exceeded ` +
            `${operation.maximumHealthyDurationMs} ms.`,
        });
      }
    }
  }

  if (!evidence.terminalPcmSocket) {
    indeterminateReasons.push({
      code: "missing-terminal-pcm-socket",
      message: "Terminal PCM socket evidence is missing.",
    });
  } else {
    if (!intervalsMatch(evidence.terminalPcmSocket.coverage, evidence.audioInterval)) {
      indeterminateReasons.push({
        code: "misaligned-terminal-pcm-socket",
        message: "Terminal PCM socket evidence does not cover the exact audio interval.",
      });
    }
    if (evidence.terminalPcmSocket.stateAtIntervalEnd === "closed") {
      networkInvalidReasons.push({
        code: "terminal-pcm-socket-closed",
        message: "Terminal PCM socket state was closed.",
      });
    } else if (evidence.terminalPcmSocket.stateAtIntervalEnd === "unknown") {
      indeterminateReasons.push({
        code: "terminal-pcm-socket-state-unknown",
        message: "Terminal PCM socket state is unknown.",
      });
    }
    if (
      evidence.terminalPcmSocket.receivedBytes === 0 &&
      evidence.terminalPcmSocket.sentBytes === 0
    ) {
      indeterminateReasons.push({
        code: "terminal-pcm-no-progress",
        message: "Terminal PCM socket aggregate contains no byte progress.",
      });
    }
    for (const [counter, label] of [
      ["reconnectCount", "reconnect"],
      ["disconnectCount", "disconnect"],
      ["transportErrorCount", "transport error"],
    ] satisfies Array<["disconnectCount" | "reconnectCount" | "transportErrorCount", string]>) {
      const count = evidence.terminalPcmSocket[counter];
      if (count === 0) continue;
      networkInvalidReasons.push({
        code: `terminal-pcm-socket-${label.replace(" ", "-")}`,
        message: `Terminal PCM socket recorded ${count} ${label} incident(s).`,
      });
    }
    if ((evidence.terminalPcmSocket.lowerTransportFailureCount ?? 0) > 0) {
      networkInvalidReasons.push({
        code: "terminal-pcm-socket-lower-transport-failure",
        message:
          "Terminal PCM socket recorded " +
          `${evidence.terminalPcmSocket.lowerTransportFailureCount} ` +
          "lower-transport incident(s).",
      });
    }
  }

  const reasons = [...networkInvalidReasons, ...indeterminateReasons];
  if (networkInvalidReasons.length > 0) {
    return { evidence, reasons, verdict: "network-invalid" };
  }
  if (indeterminateReasons.length > 0) {
    return { evidence, reasons, verdict: "indeterminate" };
  }
  return {
    evidence,
    reasons,
    verdict: "valid",
  };
}
