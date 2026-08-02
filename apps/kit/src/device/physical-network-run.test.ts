import { describe, expect, test } from "vitest";
import type { KitControlDiagnostics, KitControlDiagnosticsV3 } from "./kit-device-contract.ts";
import {
  buildPhysicalNetworkRunArtifact,
  type PhysicalDeviceDiagnosticsObservation,
  type PhysicalNetworkRunArtifactInput,
} from "./physical-network-run.ts";
import type { PhysicalReachabilitySample } from "./physical-network-reachability.ts";

function diagnostics(options: {
  producedAtMs: number;
  wifiDisconnects?: number;
}): KitControlDiagnosticsV3 {
  return {
    schemaVersion: 3,
    producedAtMs: options.producedAtMs,
    control: {
      websocketStartAttempts: 1,
      websocketConnections: 1,
      websocketDisconnects: 0,
      websocketErrors: 0,
      wifiDisconnects: options.wifiDisconnects ?? 0,
      protocolFailures: 0,
      receiveFailures: 0,
      sendFailures: 0,
      lastWifiDisconnectReason: 0,
      lastErrorGeneration: 0,
      lastErrorType: 0,
      lastTlsError: 0,
      lastTlsStackError: 0,
      lastTransportErrno: 0,
      lastHandshakeStatusCode: 0,
      lastCloseStatusCode: 0,
      protocolFailureGeneration: 0,
      lastApplicationCapnwebGeneration: 1,
      lastApplicationCapnwebStatus: 0,
      lastControlReceiveStatus: 0,
      messagesSent: 1,
      messagesDiscarded: 0,
      inboxDiscarded: 0,
      outboxDiscarded: 0,
      inbox: {
        capacitySlots: 8,
        messagesPublished: 1,
        messagesConsumed: 1,
        producerBackpressure: 0,
        highWaterSlots: 1,
        currentSlots: 0,
      },
      outbox: {
        capacitySlots: 8,
        messagesPublished: 1,
        messagesConsumed: 1,
        producerBackpressure: 0,
        highWaterSlots: 1,
        currentSlots: 0,
      },
    },
    network: {
      wifiConnected: true,
      wifiRssiDbm: -48,
      pcmWebsocketConnections: 1,
      pcmWebsocketDisconnects: 0,
      pcmWebsocketErrors: 0,
    },
  };
}

function diagnosticsV4(options: {
  producedAtMs: number;
  transportFailureIncidents: number;
}): KitControlDiagnostics {
  const previous = diagnostics({ producedAtMs: options.producedAtMs });
  return {
    ...previous,
    schemaVersion: 4,
    network: {
      ...previous.network,
      pcmWebsocketRawWriteFailures: 0,
      pcmTransportFailureIncidents: options.transportFailureIncidents,
      pcmLastFailureOperation: options.transportFailureIncidents === 0 ? 0 : 2,
      pcmLastRawResult: options.transportFailureIncidents === 0 ? 0 : -1,
      pcmLastSocketErrno: 0,
      pcmLastEspTlsError: options.transportFailureIncidents === 0 ? 0 : 32_776,
      pcmLastTlsStackError: 0,
      pcmLastTlsCertFlags: 0,
    },
  };
}

function healthyInput(): PhysicalNetworkRunArtifactInput {
  const diagnosticsObservations: PhysicalDeviceDiagnosticsObservation[] = [
    {
      completedAtMonotonicMs: 1_100,
      diagnostics: diagnostics({ producedAtMs: 100 }),
      outcome: "success",
      startedAtMonotonicMs: 1_050,
    },
    {
      completedAtMonotonicMs: 2_900,
      diagnostics: diagnostics({ producedAtMs: 1_900 }),
      outcome: "success",
      startedAtMonotonicMs: 2_850,
    },
  ];
  const reachability = (
    ["device", "router", "worker"] as const
  ).flatMap<PhysicalReachabilitySample>((target) => [
    {
      completedAtMonotonicMs: 1_005,
      host: target === "device" ? "192.168.0.21" : "192.168.0.1",
      outcome: "reply",
      rttMs: 5,
      startedAtMonotonicMs: 1_000,
      target,
    },
    {
      completedAtMonotonicMs: 2_005,
      host: target === "device" ? "192.168.0.21" : "192.168.0.1",
      outcome: "reply",
      rttMs: 5,
      startedAtMonotonicMs: 2_000,
      target,
    },
    {
      completedAtMonotonicMs: 3_005,
      host: target === "device" ? "192.168.0.21" : "192.168.0.1",
      outcome: "reply",
      rttMs: 5,
      startedAtMonotonicMs: 3_000,
      target,
    },
  ]);
  return {
    audio: { failure: null, passed: true },
    audioInterval: {
      completedAtMonotonicMs: 3_000,
      startedAtMonotonicMs: 1_000,
    },
    diagnostics: diagnosticsObservations,
    dnsAndConnect: { kind: "not-applicable", reason: "direct-lan" } as const,
    pcmEvidence: {
      bridgeEvidence: {
        closeEvents: [],
        historyTruncated: false,
        openEvents: [
          {
            endpoint: "/pcm",
            protocol: "iterate.kit.pcm.v1",
            remoteAddress: "192.168.0.21",
            remotePort: 49_123,
            startedAtMonotonicMs: 500,
          },
        ],
      },
      kind: "local-bridge",
      progress: {
        deviceToWorkerBytes: 0,
        workerToDeviceBytes: 64_000,
      },
    },
    reachability,
    reachabilitySampleIntervalMs: 1_000,
  };
}

describe("physical network run evidence", () => {
  test("turns one fully covered healthy audio interval into a valid durable verdict", () => {
    /*
     * This is the acceptance shape used by the physical Stick runner. It proves
     * the builder does not merely collect attractive-looking data: every
     * device, router, worker, control-socket, PCM-socket, RSSI, and byte-progress
     * lane must line up before audio can be called valid.
     */
    const artifact = buildPhysicalNetworkRunArtifact(healthyInput());

    expect(artifact.classification).toBe("valid");
    expect(artifact.network).toMatchObject({
      reasons: [],
      verdict: "valid",
    });
  });

  test("does not attribute planned setup and teardown socket state to the media interval", () => {
    /*
     * Production opens `/pcm` before PTT and deliberately closes it after the
     * response drains. We retain those neighbouring observations because they
     * explain lifecycle behaviour, but accepting them as interval samples
     * would falsely diagnose every successful call as a reconnect/disconnect.
     * Only the exact PTT-to-drain window is allowed to decide audio validity.
     */
    const input = healthyInput();
    input.diagnostics = [
      {
        completedAtMonotonicMs: 900,
        diagnostics: {
          ...diagnostics({ producedAtMs: 0 }),
          network: {
            pcmWebsocketConnections: 0,
            pcmWebsocketDisconnects: 0,
            pcmWebsocketErrors: 0,
            wifiConnected: true,
            wifiRssiDbm: -48,
          },
        },
        outcome: "success",
        startedAtMonotonicMs: 850,
      },
      ...input.diagnostics,
      {
        completedAtMonotonicMs: 3_100,
        diagnostics: {
          ...diagnostics({ producedAtMs: 2_100 }),
          network: {
            pcmWebsocketConnections: 1,
            pcmWebsocketDisconnects: 1,
            pcmWebsocketErrors: 0,
            wifiConnected: true,
            wifiRssiDbm: -48,
          },
        },
        outcome: "success",
        startedAtMonotonicMs: 3_050,
      },
    ];

    const artifact = buildPhysicalNetworkRunArtifact(input);

    expect(artifact.classification).toBe("valid");
    expect(artifact.network).toMatchObject({
      reasons: [],
      verdict: "valid",
    });
    expect(artifact.diagnostics).toHaveLength(4);
  });

  test("uses deployed-device progress without inventing a local bridge observation", () => {
    /*
     * A production userspace worker does not run inside this Node process, so
     * it cannot honestly supply LocalFetchWebSocketBridge open/close events.
     * The freshly flashed device does expose exact PCM connection counters and
     * downlink acceptance. This fixture protects the production proof from
     * fabricating a local bridge while still requiring byte progress and the
     * same reconnect/error verdicts from the device-side socket.
     */
    const input = healthyInput();
    input.pcmEvidence = {
      kind: "device-observed",
      progress: {
        deviceToWorkerBytes: 0,
        workerToDeviceBytes: 64_000,
      },
    };

    const artifact = buildPhysicalNetworkRunArtifact(input);

    expect(artifact).toMatchObject({
      classification: "valid",
      network: {
        evidence: {
          terminalPcmSocket: {
            receivedBytes: 64_000,
            stateAtIntervalEnd: "open",
          },
        },
        reasons: [],
        verdict: "valid",
      },
      rawPcmEvidence: {
        kind: "device-observed",
      },
      schemaVersion: 2,
    });
  });

  test("attributes a bad acoustic result to audio only when the network interval is valid", () => {
    const input = healthyInput();
    input.audio = {
      failure: "phase continuity exceeded the physical bound",
      passed: false,
    };

    const artifact = buildPhysicalNetworkRunArtifact(input);

    expect(artifact.classification).toBe("audio-invalid");
    expect(artifact.network.verdict).toBe("valid");
  });

  test("classifies a concrete link incident as network-invalid even when audio also failed", () => {
    /*
     * Network-invalid is attribution, not an audio pardon. The failed acoustic
     * reason remains in the artifact, but this run cannot be used to diagnose
     * the speaker path and cannot count as a clean audio pass.
     */
    const input = healthyInput();
    input.audio = { failure: "audible gap", passed: false };
    input.diagnostics = [
      input.diagnostics[0]!,
      {
        completedAtMonotonicMs: 2_900,
        diagnostics: diagnostics({
          producedAtMs: 1_900,
          wifiDisconnects: 1,
        }),
        outcome: "success",
        startedAtMonotonicMs: 2_850,
      },
    ];

    const artifact = buildPhysicalNetworkRunArtifact(input);

    expect(artifact.classification).toBe("network-invalid");
    expect(artifact.audio.failure).toBe("audible gap");
    expect(artifact.network.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "device-wifi-disconnect" })]),
    );
  });

  test("classifies a retained lower-transport incident before aggregate PCM error catches up", () => {
    /*
     * The platform captures the ESP-TLS tuple at the exact failing call, while
     * the outer PCM lifecycle may increment its generic WebSocket error only
     * on a later owner iteration. The interval must already be network-invalid
     * from the monotonic incident counter; otherwise the most useful causal
     * sample can be labelled healthy during that one-iteration attribution
     * gap. Raw diagnostics remain attached to preserve the exact peer-FIN/TLS
     * tuple behind this coarse classifier decision.
     */
    const input = healthyInput();
    input.diagnostics = [
      {
        completedAtMonotonicMs: 1_100,
        diagnostics: diagnosticsV4({
          producedAtMs: 100,
          transportFailureIncidents: 0,
        }),
        outcome: "success",
        startedAtMonotonicMs: 1_050,
      },
      {
        completedAtMonotonicMs: 2_900,
        diagnostics: diagnosticsV4({
          producedAtMs: 1_900,
          transportFailureIncidents: 1,
        }),
        outcome: "success",
        startedAtMonotonicMs: 2_850,
      },
    ];

    const artifact = buildPhysicalNetworkRunArtifact(input);

    expect(artifact.classification).toBe("network-invalid");
    expect(artifact.network.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "pcm-socket-lower-transport-failure" }),
      ]),
    );
    expect(artifact.diagnostics.at(-1)).toMatchObject({
      diagnostics: {
        network: {
          pcmLastEspTlsError: 32_776,
          pcmLastFailureOperation: 2,
          pcmLastRawResult: -1,
          pcmTransportFailureIncidents: 1,
        },
      },
    });
  });

  test("cannot claim validity after a failed diagnostics observation", () => {
    const input = healthyInput();
    input.diagnostics = [
      input.diagnostics[0]!,
      {
        completedAtMonotonicMs: 2_900,
        error: "Cap'n Web diagnostics timed out",
        outcome: "failure",
        startedAtMonotonicMs: 2_850,
      },
    ];

    expect(buildPhysicalNetworkRunArtifact(input)).toMatchObject({
      classification: "indeterminate",
      network: {
        verdict: "indeterminate",
      },
    });
  });
});
