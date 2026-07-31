import { describe, expect, test } from "vitest";
import {
  discoverDarwinDefaultGateway,
  measureRemoteDnsAndTlsConnect,
  parseDarwinPingReply,
  PhysicalNetworkReachabilityMonitor,
  warmPhysicalNetworkReachability,
} from "./physical-network-reachability.ts";

describe("physical network reachability evidence", () => {
  test("extracts the actual router and RTT from bounded macOS commands", async () => {
    const gateway = await discoverDarwinDefaultGateway(async () => ({
      stdout:
        "   route to: default\n" +
        "destination: default\n" +
        "    gateway: 192.168.0.1\n" +
        "  interface: en0\n",
    }));

    expect(gateway).toBe("192.168.0.1");
    expect(
      parseDarwinPingReply("64 bytes from 192.168.0.21: icmp_seq=0 ttl=255 time=2.463 ms\n"),
    ).toBe(2.463);
    expect(parseDarwinPingReply("1 packets transmitted, 0 packets received")).toBeUndefined();
  });

  test("never queues catch-up probes when one round takes longer than its period", async () => {
    let active = 0;
    let maximumActive = 0;
    let now = 0;
    const monitor = new PhysicalNetworkReachabilityMonitor({
      intervalMs: 10,
      maximumSamplesPerTarget: 2,
      monotonicNow: () => now,
      ping: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        /*
         * Model a network timeout spanning three nominal periods. Replaying
         * those missed probes after recovery would add host load and make the
         * retained interval look healthier than it was.
         */
        now += 35;
        active -= 1;
        return { outcome: "timeout" };
      },
      targets: [{ host: "192.0.2.1", target: "device" }],
    });

    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const samples = await monitor.stop();

    expect(maximumActive).toBe(1);
    expect(samples).toHaveLength(2);
    expect(samples.every(({ outcome }) => outcome === "timeout")).toBe(true);
  });

  test("keeps a fixed host-side evidence ceiling instead of growing with a stuck run", async () => {
    const monitor = new PhysicalNetworkReachabilityMonitor({
      intervalMs: 1,
      maximumSamplesPerTarget: 2,
      ping: async () => ({ outcome: "reply", rttMs: 1 }),
      targets: [
        { host: "192.0.2.2", target: "device" },
        { host: "192.0.2.1", target: "router" },
      ],
    });

    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const samples = await monitor.stop();

    expect(monitor.sampleLimitReached).toBe(true);
    expect(samples).toHaveLength(4);
    expect(samples.map(({ target }) => target)).toEqual(["device", "router", "device", "router"]);
  });

  test("measures one production DNS and verified TLS path without retrying either operation", async () => {
    /*
     * The production acoustic verdict must cover the path the device actually
     * uses, not inherit a DNS/TLS check from setup minutes earlier. One attempt
     * of each operation is intentional: hidden retries would erase a transient
     * failure and add an unrelated host-side backlog during the audio interval.
     */
    let now = 100;
    let resolutionCount = 0;
    let connectCount = 0;
    const measurement = await measureRemoteDnsAndTlsConnect("kit--proof.iterate.app", {
      connect: async (_hostname, address) => {
        connectCount += 1;
        expect(address).toBe("192.0.2.40");
        now += 24;
      },
      maximumHealthyConnectDurationMs: 1_000,
      maximumHealthyDnsDurationMs: 500,
      monotonicNow: () => now,
      resolveIpv4: async () => {
        resolutionCount += 1;
        now += 9;
        return "192.0.2.40";
      },
    });

    expect(measurement).toEqual({
      connect: {
        durationMs: 24,
        error: null,
        maximumHealthyDurationMs: 1_000,
        outcome: "success",
      },
      dns: {
        durationMs: 9,
        error: null,
        maximumHealthyDurationMs: 500,
        outcome: "success",
      },
    });
    expect({ connectCount, resolutionCount }).toEqual({
      connectCount: 1,
      resolutionCount: 1,
    });
  });

  test("does not attempt a connect after DNS has already made the interval network-invalid", async () => {
    /*
     * A DNS failure is already causal evidence. Attempting TLS with a guessed
     * or cached address would make the artifact ambiguous and could hide the
     * exact failure the attribution system exists to preserve.
     */
    let now = 0;
    let connectCount = 0;
    const measurement = await measureRemoteDnsAndTlsConnect("kit--proof.iterate.app", {
      connect: async () => {
        connectCount += 1;
      },
      monotonicNow: () => now,
      resolveIpv4: async () => {
        now += 17;
        throw new Error("DNS server unreachable");
      },
    });

    expect(measurement).toMatchObject({
      connect: {
        durationMs: null,
        outcome: "not-observed",
      },
      dns: {
        durationMs: 17,
        error: "DNS server unreachable",
        outcome: "failure",
      },
    });
    expect(connectCount).toBe(0);
  });

  test("warms a freshly reset station before opening the measured audio interval", async () => {
    /*
     * Esptool resets the Stick before a no-flash run. The first host-to-device
     * packet can therefore pay for ARP/neighbour discovery even though the
     * device-to-Captun sockets are already mounted. Starting the acceptance
     * interval on that setup packet makes a clean conversation depend on an
     * unrelated stale host cache. We instead require two consecutive healthy
     * replies, then start an entirely fresh, still-strict measured interval.
     */
    const replies = [
      { outcome: "timeout" as const },
      { outcome: "reply" as const, rttMs: 6 },
      { outcome: "reply" as const, rttMs: 5 },
    ];

    const result = await warmPhysicalNetworkReachability("192.168.0.21", {
      delay: async () => undefined,
      maximumAttempts: 4,
      ping: async () => replies.shift()!,
      requiredConsecutiveHealthyReplies: 2,
    });

    expect(result).toEqual({
      attempts: [
        { outcome: "timeout" },
        { outcome: "reply", rttMs: 6 },
        { outcome: "reply", rttMs: 5 },
      ],
      maximumHealthyRttMs: 100,
      passed: true,
      requiredConsecutiveHealthyReplies: 2,
    });
  });

  test("fails boundedly when the station never becomes a clean measurement candidate", async () => {
    let calls = 0;
    const result = await warmPhysicalNetworkReachability("192.168.0.21", {
      delay: async () => undefined,
      maximumAttempts: 3,
      ping: async () => {
        calls += 1;
        return { outcome: "reply", rttMs: 140 };
      },
      requiredConsecutiveHealthyReplies: 2,
    });

    expect(calls).toBe(3);
    expect(result).toMatchObject({
      attempts: [
        { outcome: "reply", rttMs: 140 },
        { outcome: "reply", rttMs: 140 },
        { outcome: "reply", rttMs: 140 },
      ],
      passed: false,
    });
  });
});
