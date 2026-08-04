import { describe, expect, test } from "vitest";
import {
  classifyPhysicalNetworkValidity,
  type PhysicalNetworkValidityEvidence,
} from "./physical-network-validity.ts";

function healthyDirectLanEvidence(): PhysicalNetworkValidityEvidence {
  const interval = {
    completedAtMonotonicMs: 3_000,
    startedAtMonotonicMs: 1_000,
  };
  const coverage = { ...interval };

  return {
    audioInterval: interval,
    deviceNetwork: {
      coverage,
      expectedSampleCount: 2,
      minimumRssiDbm: -75,
      samples: [
        {
          capturedAtMonotonicMs: 1_000,
          linkUp: true,
          rssiDbm: -48,
          wifiDisconnectCount: 4,
        },
        {
          capturedAtMonotonicMs: 3_000,
          linkUp: true,
          rssiDbm: -51,
          wifiDisconnectCount: 4,
        },
      ],
    },
    deviceControlRoundTrips: {
      coverage,
      expectedSampleCount: 2,
      maximumHealthyDurationMs: 500,
      samples: [
        {
          completedAtMonotonicMs: 1_050,
          durationMs: 50,
          outcome: "success",
          startedAtMonotonicMs: 1_000,
        },
        {
          completedAtMonotonicMs: 3_000,
          durationMs: 50,
          outcome: "success",
          startedAtMonotonicMs: 2_950,
        },
      ],
    },
    dnsAndConnect: {
      kind: "not-applicable",
      reason: "direct-lan",
    },
    hostReachability: {
      device: {
        coverage,
        expectedSampleCount: 2,
        maximumHealthySampleGapMs: 2_000,
        maximumHealthyRttMs: 50,
        samples: [
          {
            completedAtMonotonicMs: 1_007,
            outcome: "reply",
            rttMs: 7,
            scheduledAtMonotonicMs: 1_000,
          },
          {
            completedAtMonotonicMs: 3_008,
            outcome: "reply",
            rttMs: 8,
            scheduledAtMonotonicMs: 3_000,
          },
        ],
      },
      router: {
        coverage,
        expectedSampleCount: 2,
        maximumHealthySampleGapMs: 2_000,
        maximumHealthyRttMs: 50,
        samples: [
          {
            completedAtMonotonicMs: 1_004,
            outcome: "reply",
            rttMs: 4,
            scheduledAtMonotonicMs: 1_000,
          },
          {
            completedAtMonotonicMs: 3_005,
            outcome: "reply",
            rttMs: 5,
            scheduledAtMonotonicMs: 3_000,
          },
        ],
      },
      worker: {
        coverage,
        expectedSampleCount: 2,
        maximumHealthySampleGapMs: 2_000,
        maximumHealthyRttMs: 100,
        samples: [
          {
            completedAtMonotonicMs: 1_018,
            outcome: "reply",
            rttMs: 18,
            scheduledAtMonotonicMs: 1_000,
          },
          {
            completedAtMonotonicMs: 3_020,
            outcome: "reply",
            rttMs: 20,
            scheduledAtMonotonicMs: 3_000,
          },
        ],
      },
    },
    socketCounters: {
      control: {
        coverage,
        expectedSampleCount: 2,
        samples: [
          {
            capturedAtMonotonicMs: 1_000,
            connected: true,
            disconnectCount: 1,
            reconnectCount: 1,
            transportErrorCount: 0,
          },
          {
            capturedAtMonotonicMs: 3_000,
            connected: true,
            disconnectCount: 1,
            reconnectCount: 1,
            transportErrorCount: 0,
          },
        ],
      },
      pcm: {
        coverage,
        expectedSampleCount: 2,
        samples: [
          {
            capturedAtMonotonicMs: 1_000,
            connected: true,
            disconnectCount: 0,
            reconnectCount: 0,
            transportErrorCount: 0,
          },
          {
            capturedAtMonotonicMs: 3_000,
            connected: true,
            disconnectCount: 0,
            reconnectCount: 0,
            transportErrorCount: 0,
          },
        ],
      },
    },
    terminalPcmSocket: {
      coverage,
      disconnectCount: 0,
      receivedBytes: 64_000,
      reconnectCount: 0,
      sentBytes: 32_000,
      stateAtIntervalEnd: "open",
      transportErrorCount: 0,
    },
  };
}

describe("physical network validity", () => {
  test("calls the exact audio interval valid only when every required lane is healthy", () => {
    /*
     * A clean acoustic artifact is not enough to exclude a transient network
     * failure. The positive verdict must require aligned device, router,
     * worker, socket, and terminal evidence. Direct LAN deliberately skips
     * DNS/connect, but only through an explicit not-applicable record.
     */
    const evidence = healthyDirectLanEvidence();

    const result = classifyPhysicalNetworkValidity(evidence);

    expect(result).toEqual({
      evidence,
      reasons: [],
      verdict: "valid",
    });
  });

  test("accepts measured DNS and connect evidence for a bounded remote path", () => {
    /*
     * Direct LAN is the one explicit exemption, not a way to make routed
     * proofs silently skip connection setup. A production-shaped run can be
     * valid when both remote operations were observed and stayed within their
     * declared bounds.
     */
    const evidence = healthyDirectLanEvidence();
    evidence.dnsAndConnect = {
      connect: {
        durationMs: 24,
        error: null,
        maximumHealthyDurationMs: 100,
        outcome: "success",
      },
      coverage: { ...evidence.audioInterval },
      dns: {
        durationMs: 9,
        error: null,
        maximumHealthyDurationMs: 50,
        outcome: "success",
      },
      kind: "measured",
    };

    expect(classifyPhysicalNetworkValidity(evidence)).toMatchObject({
      reasons: [],
      verdict: "valid",
    });
  });

  test("calls a proven outage network-invalid even when another evidence lane is missing", () => {
    /*
     * Missing terminal telemetry must never dilute a concrete failed probe
     * into "we do not know." Conversely, retaining both reasons lets the
     * harness report the outage and the collection defect without pretending
     * the evidence bundle was otherwise complete.
     */
    const evidence = healthyDirectLanEvidence();
    const deviceReachability = evidence.hostReachability?.device;
    if (!deviceReachability) throw new Error("Healthy fixture lost device reachability.");
    deviceReachability.samples = [
      deviceReachability.samples[0]!,
      {
        outcome: "timeout",
        scheduledAtMonotonicMs: 3_000,
      },
    ];
    delete evidence.terminalPcmSocket;

    const result = classifyPhysicalNetworkValidity(evidence);

    expect(result.evidence).toBe(evidence);
    expect(result.verdict).toBe("network-invalid");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        {
          code: "host-reachability-timeout",
          message: "device reachability probe timed out at 3000 ms.",
        },
        {
          code: "missing-terminal-pcm-socket",
          message: "Terminal PCM socket evidence is missing.",
        },
      ]),
    );
  });

  test("rejects a successful device capability round trip that exceeds the audio freshness budget", () => {
    /*
     * ICMP is supporting evidence, not the application path used by the
     * device. The production Stick run proved why this distinction matters:
     * its router and worker probes stayed healthy while getDiagnostics took
     * hundreds of milliseconds on the same interval as a device ping miss.
     * A successful-but-late capability response therefore cannot certify the
     * route merely because its payload eventually arrived.
     */
    const evidence = healthyDirectLanEvidence();
    evidence.deviceControlRoundTrips!.samples = [
      evidence.deviceControlRoundTrips!.samples[0]!,
      {
        completedAtMonotonicMs: 3_000,
        durationMs: 550,
        outcome: "success",
        startedAtMonotonicMs: 2_450,
      },
    ];

    expect(classifyPhysicalNetworkValidity(evidence)).toMatchObject({
      reasons: expect.arrayContaining([
        {
          code: "device-control-round-trip-duration-exceeded",
          message: "Device control round trip took 550 ms, exceeding its 500 ms healthy budget.",
        },
      ]),
      verdict: "network-invalid",
    });
  });

  test("calls an otherwise healthy interval indeterminate when device evidence is absent", () => {
    /*
     * Healthy host pings cannot prove the ESP32 stayed associated: the router
     * could answer while the station dropped, rebooted, or reconnected. A
     * missing device lane is therefore unknown evidence, never an implicit
     * pass and never a claim that the network definitely failed.
     */
    const evidence = healthyDirectLanEvidence();
    delete evidence.deviceNetwork;

    expect(classifyPhysicalNetworkValidity(evidence)).toMatchObject({
      reasons: [
        {
          code: "missing-device-network",
          message: "Device network evidence is missing.",
        },
      ],
      verdict: "indeterminate",
    });
  });

  test("refuses a healthy verdict when reachability sampling has a silent coverage hole", () => {
    /*
     * Counting only the samples which happened to arrive lets a slow probe skip
     * several periods and still claim complete coverage. Exact-interval
     * attribution needs a time-gap bound so an observer stall cannot
     * manufacture a clean network history.
     */
    const evidence = healthyDirectLanEvidence();
    evidence.hostReachability!.device = {
      ...evidence.hostReachability!.device!,
      maximumHealthySampleGapMs: 500,
    };

    expect(classifyPhysicalNetworkValidity(evidence)).toMatchObject({
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: "host-reachability-coverage-gap" }),
      ]),
      verdict: "indeterminate",
    });
  });

  test.each<{
    code: string;
    corrupt: (evidence: PhysicalNetworkValidityEvidence) => void;
    incident: string;
  }>([
    {
      code: "host-rtt-exceeded",
      corrupt(evidence) {
        const worker = evidence.hostReachability!.worker!;
        worker.samples = [
          worker.samples[0]!,
          {
            completedAtMonotonicMs: 3_130,
            outcome: "reply",
            rttMs: 130,
            scheduledAtMonotonicMs: 3_000,
          },
        ];
      },
      incident: "excessive worker RTT",
    },
    {
      code: "device-link-down",
      corrupt(evidence) {
        const device = evidence.deviceNetwork!;
        device.samples = [device.samples[0]!, { ...device.samples[1]!, linkUp: false }];
      },
      incident: "device link loss",
    },
    {
      code: "device-rssi-below-minimum",
      corrupt(evidence) {
        const device = evidence.deviceNetwork!;
        device.samples = [device.samples[0]!, { ...device.samples[1]!, rssiDbm: -82 }];
      },
      incident: "out-of-policy RSSI",
    },
    {
      code: "device-wifi-disconnect",
      corrupt(evidence) {
        const device = evidence.deviceNetwork!;
        device.samples = [device.samples[0]!, { ...device.samples[1]!, wifiDisconnectCount: 5 }];
      },
      incident: "Wi-Fi disconnect",
    },
    {
      code: "control-socket-reconnect",
      corrupt(evidence) {
        const control = evidence.socketCounters!.control!;
        control.samples = [control.samples[0]!, { ...control.samples[1]!, reconnectCount: 2 }];
      },
      incident: "control socket reconnect",
    },
    {
      code: "dns-failed",
      corrupt(evidence) {
        evidence.dnsAndConnect = {
          connect: {
            durationMs: 20,
            error: null,
            maximumHealthyDurationMs: 100,
            outcome: "success",
          },
          coverage: { ...evidence.audioInterval },
          dns: {
            durationMs: null,
            error: "EAI_AGAIN",
            maximumHealthyDurationMs: 100,
            outcome: "failure",
          },
          kind: "measured",
        };
      },
      incident: "DNS failure",
    },
    {
      code: "terminal-pcm-socket-closed",
      corrupt(evidence) {
        evidence.terminalPcmSocket!.stateAtIntervalEnd = "closed";
      },
      incident: "terminal PCM socket closure",
    },
  ])("classifies $incident as network-invalid", ({ code, corrupt }) => {
    /*
     * These signals come from independent layers, but each is affirmative
     * evidence that an explicit network bound failed during the audio
     * interval. None may be softened to indeterminate merely because audio
     * later recovered or another lane remained healthy.
     */
    const evidence = healthyDirectLanEvidence();
    corrupt(evidence);

    const result = classifyPhysicalNetworkValidity(evidence);

    expect(result.verdict).toBe("network-invalid");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code,
        }),
      ]),
    );
  });

  test.each<{
    code: string;
    incomplete: (evidence: PhysicalNetworkValidityEvidence) => void;
    omission: string;
  }>([
    {
      code: "incomplete-host-reachability",
      incomplete(evidence) {
        evidence.hostReachability!.router!.expectedSampleCount = 3;
      },
      omission: "a scheduled router probe",
    },
    {
      code: "misaligned-device-network",
      incomplete(evidence) {
        evidence.deviceNetwork!.coverage = {
          completedAtMonotonicMs: 3_000,
          startedAtMonotonicMs: 1_001,
        };
      },
      omission: "exact device evidence alignment",
    },
    {
      code: "host-reachability-sample-outside-interval",
      incomplete(evidence) {
        const worker = evidence.hostReachability!.worker!;
        worker.samples = [
          {
            completedAtMonotonicMs: 999,
            outcome: "reply",
            rttMs: 5,
            scheduledAtMonotonicMs: 994,
          },
          worker.samples[1]!,
        ];
      },
      omission: "exact reachability sample alignment",
    },
    {
      code: "missing-device-rssi",
      incomplete(evidence) {
        const device = evidence.deviceNetwork!;
        device.samples = [device.samples[0]!, { ...device.samples[1]!, rssiDbm: null }];
      },
      omission: "one RSSI observation",
    },
    {
      code: "missing-control-socket-counters",
      incomplete(evidence) {
        delete evidence.socketCounters!.control;
      },
      omission: "control socket counters",
    },
    {
      code: "missing-dns-and-connect",
      incomplete(evidence) {
        delete evidence.dnsAndConnect;
      },
      omission: "DNS/connect applicability",
    },
    {
      code: "dns-not-observed",
      incomplete(evidence) {
        evidence.dnsAndConnect = {
          connect: {
            durationMs: 20,
            error: null,
            maximumHealthyDurationMs: 100,
            outcome: "success",
          },
          coverage: { ...evidence.audioInterval },
          dns: {
            durationMs: null,
            error: null,
            maximumHealthyDurationMs: 100,
            outcome: "not-observed",
          },
          kind: "measured",
        };
      },
      omission: "a required remote DNS attempt",
    },
    {
      code: "terminal-pcm-socket-state-unknown",
      incomplete(evidence) {
        evidence.terminalPcmSocket!.stateAtIntervalEnd = "unknown";
      },
      omission: "terminal PCM socket state",
    },
    {
      code: "terminal-pcm-no-progress",
      incomplete(evidence) {
        evidence.terminalPcmSocket!.receivedBytes = 0;
        evidence.terminalPcmSocket!.sentBytes = 0;
      },
      omission: "observable PCM socket progress",
    },
  ])("classifies missing $omission as indeterminate", ({ code, incomplete }) => {
    /*
     * Silence in a collector is not evidence of health. These cases exercise
     * both absent fields and subtler holes—lost scheduled samples, unknown
     * values, and measurements from the wrong interval—because all can look
     * superficially healthy if the classifier only scans for explicit errors.
     */
    const evidence = healthyDirectLanEvidence();
    incomplete(evidence);

    const result = classifyPhysicalNetworkValidity(evidence);

    expect(result.verdict).toBe("indeterminate");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code,
        }),
      ]),
    );
  });
});
