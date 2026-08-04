import { describe, expect, test } from "vitest";
import {
  assessProductionRoutePreflight,
  warmProductionDeviceControlCapability,
} from "./production-route-preflight.ts";

const cleanControlCapability = {
  attempts: Array.from({ length: 8 }, () => ({ durationMs: 40, outcome: "success" as const })),
  maximumHealthyDurationMs: 500,
  passed: true,
  requiredConsecutiveHealthyReplies: 8,
};

describe("production route preflight", () => {
  test("accepts only a wholly clean worker reachability window plus bounded DNS and TLS", () => {
    /*
     * A one-off good ping is not enough before a minute-long acoustic run. The
     * physical fixture is disruptive and the active network classifier rejects
     * any bad sample, so its preflight must preserve the same strict meaning:
     * every requested reply was consecutively healthy, and name resolution and
     * a verified TLS dial both completed inside their production budgets.
     */
    expect(
      assessProductionRoutePreflight({
        controlCapability: cleanControlCapability,
        createdAt: "2026-08-03T01:00:00.000Z",
        deviceHost: "192.168.0.234",
        deviceReachability: {
          attempts: Array.from({ length: 8 }, () => ({ outcome: "reply" as const, rttMs: 6 })),
          maximumHealthyRttMs: 100,
          passed: true,
          requiredConsecutiveHealthyReplies: 8,
        },
        dnsAndConnect: {
          connect: {
            durationMs: 80,
            error: null,
            maximumHealthyDurationMs: 1_000,
            outcome: "success",
          },
          dns: {
            durationMs: 5,
            error: null,
            maximumHealthyDurationMs: 500,
            outcome: "success",
          },
        },
        reachability: {
          attempts: Array.from({ length: 8 }, () => ({ outcome: "reply" as const, rttMs: 45 })),
          maximumHealthyRttMs: 100,
          passed: true,
          requiredConsecutiveHealthyReplies: 8,
        },
        workerHost: "kit.example.iterate.app",
      }),
    ).toEqual({
      createdAt: "2026-08-03T01:00:00.000Z",
      controlCapability: cleanControlCapability,
      deviceHost: "192.168.0.234",
      deviceReachability: {
        attempts: Array.from({ length: 8 }, () => ({ outcome: "reply", rttMs: 6 })),
        maximumHealthyRttMs: 100,
        passed: true,
        requiredConsecutiveHealthyReplies: 8,
      },
      dnsAndConnect: {
        connect: {
          durationMs: 80,
          error: null,
          maximumHealthyDurationMs: 1_000,
          outcome: "success",
        },
        dns: {
          durationMs: 5,
          error: null,
          maximumHealthyDurationMs: 500,
          outcome: "success",
        },
      },
      passed: true,
      reachability: {
        attempts: Array.from({ length: 8 }, () => ({ outcome: "reply", rttMs: 45 })),
        maximumHealthyRttMs: 100,
        passed: true,
        requiredConsecutiveHealthyReplies: 8,
      },
      reasons: [],
      schemaVersion: 3,
      workerHost: "kit.example.iterate.app",
    });
  });

  test("rejects a window containing worker loss or excess RTT", () => {
    const artifact = assessProductionRoutePreflight({
      controlCapability: cleanControlCapability,
      createdAt: "2026-08-03T01:00:00.000Z",
      deviceHost: "192.168.0.234",
      deviceReachability: {
        attempts: [{ outcome: "timeout" }],
        maximumHealthyRttMs: 100,
        passed: false,
        requiredConsecutiveHealthyReplies: 1,
      },
      dnsAndConnect: {
        connect: {
          durationMs: 80,
          error: null,
          maximumHealthyDurationMs: 1_000,
          outcome: "success",
        },
        dns: {
          durationMs: 5,
          error: null,
          maximumHealthyDurationMs: 500,
          outcome: "success",
        },
      },
      reachability: {
        attempts: [
          { outcome: "reply", rttMs: 45 },
          { outcome: "reply", rttMs: 130 },
          { detail: "no reply", outcome: "error" },
        ],
        maximumHealthyRttMs: 100,
        passed: false,
        requiredConsecutiveHealthyReplies: 3,
      },
      workerHost: "kit.example.iterate.app",
    });

    expect(artifact.passed).toBe(false);
    expect(artifact.reasons).toEqual([
      "Device reachability did not sustain 1 consecutive reply at or below 100 ms across 1 bounded attempt.",
      "Worker reachability did not sustain 3 consecutive replies at or below 100 ms across 3 bounded attempts.",
    ]);
  });

  test("rejects slow DNS and a failed TLS dial independently", () => {
    const artifact = assessProductionRoutePreflight({
      controlCapability: cleanControlCapability,
      createdAt: "2026-08-03T01:00:00.000Z",
      deviceHost: "192.168.0.234",
      deviceReachability: {
        attempts: [{ outcome: "reply", rttMs: 6 }],
        maximumHealthyRttMs: 100,
        passed: true,
        requiredConsecutiveHealthyReplies: 1,
      },
      dnsAndConnect: {
        connect: {
          durationMs: 200,
          error: "certificate rejected",
          maximumHealthyDurationMs: 1_000,
          outcome: "failure",
        },
        dns: {
          durationMs: 700,
          error: null,
          maximumHealthyDurationMs: 500,
          outcome: "success",
        },
      },
      reachability: {
        attempts: [{ outcome: "reply", rttMs: 40 }],
        maximumHealthyRttMs: 100,
        passed: true,
        requiredConsecutiveHealthyReplies: 1,
      },
      workerHost: "kit.example.iterate.app",
    });

    expect(artifact.passed).toBe(false);
    expect(artifact.reasons).toEqual([
      "Worker DNS took 700 ms, exceeding its 500 ms healthy budget.",
      "Worker TLS connect failed: certificate rejected",
    ]);
  });

  test("rejects an otherwise clean route when the real device capability path is slow", () => {
    /*
     * The retained Stick incident answered the adjacent ICMP probe while the
     * production getDiagnostics operation took 729 ms. Pinging the board is
     * therefore not a sufficient admission test for a voice turn: the control
     * RPC exercises the authenticated Cap'n Web socket, userspace mount, and
     * device dispatcher that the proof will actually depend on.
     */
    const artifact = assessProductionRoutePreflight({
      controlCapability: {
        attempts: [{ durationMs: 729, outcome: "success" }],
        maximumHealthyDurationMs: 500,
        passed: false,
        requiredConsecutiveHealthyReplies: 1,
      },
      createdAt: "2026-08-04T01:00:00.000Z",
      deviceHost: "192.168.0.21",
      deviceReachability: {
        attempts: [{ outcome: "reply", rttMs: 4 }],
        maximumHealthyRttMs: 100,
        passed: true,
        requiredConsecutiveHealthyReplies: 1,
      },
      dnsAndConnect: {
        connect: {
          durationMs: 28,
          error: null,
          maximumHealthyDurationMs: 1_000,
          outcome: "success",
        },
        dns: {
          durationMs: 32,
          error: null,
          maximumHealthyDurationMs: 500,
          outcome: "success",
        },
      },
      reachability: {
        attempts: [{ outcome: "reply", rttMs: 11 }],
        maximumHealthyRttMs: 100,
        passed: true,
        requiredConsecutiveHealthyReplies: 1,
      },
      workerHost: "kit.example.iterate.app",
    });

    expect(artifact.passed).toBe(false);
    expect(artifact.reasons).toEqual([
      "Device control capability did not sustain 1 consecutive response at or below 500 ms across 1 bounded attempt.",
    ]);
  });

  test("warms through a completed slow response and still requires a fresh healthy streak", async () => {
    /*
     * The first request after an idle mounted capability may pay a bounded wake
     * cost. It has already completed, so a sequential retry creates neither
     * overlap nor backlog. Aborting there made an advertised 16-attempt warmup
     * execute exactly once forever. Reset the consecutive count and require
     * the full fresh streak; the slow sample remains durably retained.
     */
    let now = 0;
    let calls = 0;
    const result = await warmProductionDeviceControlCapability(
      async () => {
        calls += 1;
        now += calls === 1 ? 501 : 40;
      },
      {
        interAttemptDelayMs: 0,
        maximumAttempts: 16,
        maximumHealthyDurationMs: 500,
        monotonicNow: () => now,
        requiredConsecutiveHealthyReplies: 8,
      },
    );

    expect(calls).toBe(9);
    expect(result).toEqual({
      attempts: [
        { durationMs: 501, outcome: "success" },
        ...Array.from({ length: 8 }, () => ({ durationMs: 40, outcome: "success" as const })),
      ],
      maximumHealthyDurationMs: 500,
      passed: true,
      requiredConsecutiveHealthyReplies: 8,
    });
  });

  test("bounds a capability which never settles and does not issue overlapping probes", async () => {
    let calls = 0;
    const result = await warmProductionDeviceControlCapability(
      () => {
        calls += 1;
        return new Promise<never>(() => {});
      },
      {
        interAttemptDelayMs: 0,
        maximumAttempts: 8,
        maximumHealthyDurationMs: 500,
        requiredConsecutiveHealthyReplies: 8,
        timeoutMs: 1,
      },
    );

    expect(calls).toBe(1);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ outcome: "failure" });
    expect(result.passed).toBe(false);
  });
});
