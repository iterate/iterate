import type {
  PhysicalNetworkReachabilityWarmupResult,
  RemoteDnsAndTlsConnectMeasurement,
} from "./physical-network-reachability.ts";
import { setTimeout as delay } from "node:timers/promises";

export type ProductionDeviceControlCapabilityAttempt =
  | { durationMs: number; outcome: "success" }
  | { durationMs: number; error: string; outcome: "failure" };

export interface ProductionDeviceControlCapabilityWarmupResult {
  attempts: readonly ProductionDeviceControlCapabilityAttempt[];
  maximumHealthyDurationMs: number;
  passed: boolean;
  requiredConsecutiveHealthyReplies: number;
}

export interface ProductionDeviceControlCapabilityWarmupOptions {
  interAttemptDelayMs?: number;
  maximumAttempts?: number;
  maximumHealthyDurationMs?: number;
  monotonicNow?: () => number;
  requiredConsecutiveHealthyReplies?: number;
  timeoutMs?: number;
}

/**
 * Exercises the same mounted device capability route used by the proof.
 *
 * ICMP establishes that a board's network interface answers, but it cannot
 * prove that the authenticated Cap'n Web socket, userspace mount, and firmware
 * dispatcher are making timely progress. A retained Stick incident showed
 * exactly that distinction: ping answered beside a 729 ms getDiagnostics RPC.
 *
 * Probes are deliberately sequential. A completed slow response resets the
 * healthy streak but may be followed by another probe: it leaves no outstanding
 * operation and this warmup exists specifically to move bounded idle/wake cost
 * before the evidence interval. A never-settling call is different. Its timeout
 * cannot cancel the underlying Cap'n Web promise, so it fails immediately
 * rather than issuing overlapping work and manufacturing the backlog this
 * admission check is meant to detect.
 */
export async function warmProductionDeviceControlCapability(
  probe: () => Promise<unknown>,
  options: ProductionDeviceControlCapabilityWarmupOptions = {},
): Promise<ProductionDeviceControlCapabilityWarmupResult> {
  const interAttemptDelayMs = options.interAttemptDelayMs ?? 250;
  const maximumAttempts = options.maximumAttempts ?? 16;
  const maximumHealthyDurationMs = options.maximumHealthyDurationMs ?? 500;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const requiredConsecutiveHealthyReplies = options.requiredConsecutiveHealthyReplies ?? 8;
  const timeoutMs = options.timeoutMs ?? Math.max(1_000, maximumHealthyDurationMs * 2);

  for (const [name, value] of [
    ["inter-attempt delay", interAttemptDelayMs],
    ["maximum attempts", maximumAttempts],
    ["maximum healthy duration", maximumHealthyDurationMs],
    ["required consecutive healthy replies", requiredConsecutiveHealthyReplies],
    ["timeout", timeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < (name === "inter-attempt delay" ? 0 : 1)) {
      throw new RangeError(`Device control ${name} must be a valid integer.`);
    }
  }
  if (requiredConsecutiveHealthyReplies > maximumAttempts) {
    throw new RangeError("Required healthy device control replies cannot exceed maximum attempts.");
  }

  const attempts: ProductionDeviceControlCapabilityAttempt[] = [];
  let consecutiveHealthyReplies = 0;
  for (let index = 0; index < maximumAttempts; index += 1) {
    const startedAt = monotonicNow();
    let deadlineExpired = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        deadlineExpired = true;
        reject(new Error(`capability timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      await Promise.race([probe(), deadline]);
      const durationMs = monotonicNow() - startedAt;
      attempts.push({ durationMs, outcome: "success" });
      if (durationMs > maximumHealthyDurationMs) {
        consecutiveHealthyReplies = 0;
      } else {
        consecutiveHealthyReplies += 1;
      }
      if (consecutiveHealthyReplies >= requiredConsecutiveHealthyReplies) break;
    } catch (error) {
      attempts.push({
        durationMs: monotonicNow() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        outcome: "failure",
      });
      consecutiveHealthyReplies = 0;
      if (deadlineExpired) break;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (interAttemptDelayMs > 0) await delay(interAttemptDelayMs);
  }

  return {
    attempts,
    maximumHealthyDurationMs,
    passed: consecutiveHealthyReplies >= requiredConsecutiveHealthyReplies,
    requiredConsecutiveHealthyReplies,
  };
}

export interface ProductionRoutePreflightInput {
  controlCapability: ProductionDeviceControlCapabilityWarmupResult;
  createdAt: string;
  deviceHost: string;
  deviceReachability: PhysicalNetworkReachabilityWarmupResult;
  dnsAndConnect: RemoteDnsAndTlsConnectMeasurement;
  reachability: PhysicalNetworkReachabilityWarmupResult;
  workerHost: string;
}

export interface ProductionRoutePreflightArtifact extends ProductionRoutePreflightInput {
  passed: boolean;
  reasons: readonly string[];
  schemaVersion: 3;
}

/**
 * Decides whether it is responsible to begin a disruptive physical fixture.
 *
 * This does not weaken or replace exact-interval network attribution. A route
 * can deteriorate after preflight, so the real audio interval is still sampled
 * and classified independently. The narrow purpose here is to avoid playing a
 * minute of tones when the production route is *already* outside the same
 * health budgets that will invalidate the evidence.
 */
export function assessProductionRoutePreflight(
  input: ProductionRoutePreflightInput,
): ProductionRoutePreflightArtifact {
  const reasons: string[] = [];
  if (!input.controlCapability.passed) {
    const count = input.controlCapability.requiredConsecutiveHealthyReplies;
    reasons.push(
      `Device control capability did not sustain ${count} consecutive ` +
        `response${count === 1 ? "" : "s"} at or below ` +
        `${input.controlCapability.maximumHealthyDurationMs} ms across ` +
        `${input.controlCapability.attempts.length} bounded ` +
        `attempt${input.controlCapability.attempts.length === 1 ? "" : "s"}.`,
    );
  }
  if (!input.deviceReachability.passed) {
    const count = input.deviceReachability.requiredConsecutiveHealthyReplies;
    reasons.push(
      `Device reachability did not sustain ${count} consecutive ` +
        `repl${count === 1 ? "y" : "ies"} at or below ` +
        `${input.deviceReachability.maximumHealthyRttMs} ms across ` +
        `${input.deviceReachability.attempts.length} bounded ` +
        `attempt${input.deviceReachability.attempts.length === 1 ? "" : "s"}.`,
    );
  }
  if (!input.reachability.passed) {
    reasons.push(
      `Worker reachability did not sustain ${input.reachability.requiredConsecutiveHealthyReplies} ` +
        `consecutive replies at or below ${input.reachability.maximumHealthyRttMs} ms across ` +
        `${input.reachability.attempts.length} bounded attempts.`,
    );
  }

  const dns = input.dnsAndConnect.dns;
  if (dns.outcome !== "success") {
    reasons.push(dns.error ? `Worker DNS failed: ${dns.error}` : "Worker DNS was not observed.");
  } else if (dns.durationMs === null) {
    reasons.push("Worker DNS succeeded without a duration measurement.");
  } else if (dns.durationMs > dns.maximumHealthyDurationMs) {
    reasons.push(
      `Worker DNS took ${dns.durationMs} ms, exceeding its ` +
        `${dns.maximumHealthyDurationMs} ms healthy budget.`,
    );
  }

  const connect = input.dnsAndConnect.connect;
  if (connect.outcome !== "success") {
    reasons.push(
      connect.error
        ? `Worker TLS connect failed: ${connect.error}`
        : "Worker TLS connect was not observed.",
    );
  } else if (connect.durationMs === null) {
    reasons.push("Worker TLS connect succeeded without a duration measurement.");
  } else if (connect.durationMs > connect.maximumHealthyDurationMs) {
    reasons.push(
      `Worker TLS connect took ${connect.durationMs} ms, exceeding its ` +
        `${connect.maximumHealthyDurationMs} ms healthy budget.`,
    );
  }

  return {
    ...input,
    controlCapability: {
      ...input.controlCapability,
      attempts: input.controlCapability.attempts.map((attempt) => ({ ...attempt })),
    },
    deviceReachability: {
      ...input.deviceReachability,
      attempts: input.deviceReachability.attempts.map((attempt) => ({ ...attempt })),
    },
    passed: reasons.length === 0,
    reachability: {
      ...input.reachability,
      attempts: input.reachability.attempts.map((attempt) => ({ ...attempt })),
    },
    reasons,
    schemaVersion: 3,
  };
}
