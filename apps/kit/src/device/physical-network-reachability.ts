import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { performance } from "node:perf_hooks";
import { connect as connectTls } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { BoundedOperationEvidence } from "./physical-network-validity.ts";

const executeFile = promisify(execFile);
const defaultMaximumHealthyDnsDurationMs = 500;
const defaultMaximumHealthyConnectDurationMs = 1_000;
const dnsDeadlineMs = 2_000;
const tlsDeadlineMs = 3_000;

export type PhysicalReachabilityTargetKind = "device" | "router" | "worker";

export interface PhysicalReachabilityTarget {
  host: string;
  target: PhysicalReachabilityTargetKind;
}

export interface PhysicalReachabilitySample {
  completedAtMonotonicMs: number;
  detail?: string;
  host: string;
  outcome: "error" | "reply" | "timeout";
  rttMs?: number;
  startedAtMonotonicMs: number;
  target: PhysicalReachabilityTargetKind;
}

export interface PhysicalNetworkReachabilityMonitorOptions {
  intervalMs?: number;
  maximumSamplesPerTarget?: number;
  monotonicNow?: () => number;
  ping?: (
    target: PhysicalReachabilityTarget,
  ) => Promise<Pick<PhysicalReachabilitySample, "detail" | "outcome" | "rttMs">>;
  targets: readonly PhysicalReachabilityTarget[];
}

export interface RemoteDnsAndTlsConnectMeasurement {
  connect: BoundedOperationEvidence;
  dns: BoundedOperationEvidence;
}

export interface RemoteDnsAndTlsConnectOptions {
  connect?: (hostname: string, address: string) => Promise<void>;
  maximumHealthyConnectDurationMs?: number;
  maximumHealthyDnsDurationMs?: number;
  monotonicNow?: () => number;
  resolveIpv4?: (hostname: string) => Promise<string>;
}

type PhysicalReachabilityProbeResult = Pick<
  PhysicalReachabilitySample,
  "detail" | "outcome" | "rttMs"
>;

export interface PhysicalNetworkReachabilityWarmupOptions {
  delay?: (milliseconds: number) => Promise<unknown>;
  interAttemptDelayMs?: number;
  maximumAttempts?: number;
  maximumHealthyRttMs?: number;
  ping?: () => Promise<PhysicalReachabilityProbeResult>;
  requiredConsecutiveHealthyReplies?: number;
}

export interface PhysicalNetworkReachabilityWarmupResult {
  attempts: readonly PhysicalReachabilityProbeResult[];
  maximumHealthyRttMs: number;
  passed: boolean;
  requiredConsecutiveHealthyReplies: number;
}

/**
 * Establishes that a freshly reset station is ready to enter a measured run.
 *
 * This is deliberately a precondition, not filtered acceptance evidence.
 * Resetting an ESP invalidates or ages the host's neighbour entry, so the
 * first host-originated packet can be spent on ARP even after the device has
 * opened its outbound tunnel sockets. Two clean replies warm that one-time
 * path before the strict monitor opens a new interval. Every probe after that
 * boundary is still retained and a single bad measured sample still fails the
 * run; this helper never removes samples from an active audio interval.
 */
export async function warmPhysicalNetworkReachability(
  host: string,
  options: PhysicalNetworkReachabilityWarmupOptions = {},
): Promise<PhysicalNetworkReachabilityWarmupResult> {
  if (!host.trim()) throw new Error("Physical network warm-up host is required.");
  const maximumAttempts = options.maximumAttempts ?? 6;
  const maximumHealthyRttMs = options.maximumHealthyRttMs ?? 100;
  const requiredConsecutiveHealthyReplies = options.requiredConsecutiveHealthyReplies ?? 2;
  const interAttemptDelayMs = options.interAttemptDelayMs ?? 100;
  for (const [name, value] of [
    ["maximum attempts", maximumAttempts],
    ["required consecutive healthy replies", requiredConsecutiveHealthyReplies],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Physical network warm-up ${name} must be a positive integer.`);
    }
  }
  if (requiredConsecutiveHealthyReplies > maximumAttempts) {
    throw new Error("Physical network warm-up cannot require more healthy replies than attempts.");
  }
  if (!Number.isFinite(maximumHealthyRttMs) || maximumHealthyRttMs <= 0) {
    throw new Error("Physical network warm-up healthy RTT must be positive and finite.");
  }
  if (!Number.isFinite(interAttemptDelayMs) || interAttemptDelayMs < 0) {
    throw new Error("Physical network warm-up delay must be finite and non-negative.");
  }

  const ping = options.ping ?? (() => pingDarwinTarget({ host, target: "device" }));
  const wait = options.delay ?? (async (milliseconds: number) => delay(milliseconds));
  const attempts: PhysicalReachabilityProbeResult[] = [];
  let consecutiveHealthyReplies = 0;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    let result: PhysicalReachabilityProbeResult;
    try {
      result = await ping();
    } catch (error) {
      result = {
        detail: error instanceof Error ? error.message : String(error),
        outcome: "error",
      };
    }
    attempts.push({ ...result });
    consecutiveHealthyReplies =
      result.outcome === "reply" &&
      result.rttMs !== undefined &&
      result.rttMs <= maximumHealthyRttMs
        ? consecutiveHealthyReplies + 1
        : 0;
    if (consecutiveHealthyReplies >= requiredConsecutiveHealthyReplies) {
      return {
        attempts,
        maximumHealthyRttMs,
        passed: true,
        requiredConsecutiveHealthyReplies,
      };
    }
    if (attempt + 1 < maximumAttempts && interAttemptDelayMs > 0) {
      await wait(interAttemptDelayMs);
    }
  }
  return {
    attempts,
    maximumHealthyRttMs,
    passed: false,
    requiredConsecutiveHealthyReplies,
  };
}

/**
 * Samples one production hostname through DNS and an authenticated TLS dial.
 *
 * This is deliberately a single attempt per stage. The result is attribution
 * evidence for one audio interval, not a resilient application client: retrying
 * here could turn a real transient outage into a clean-looking probe while
 * adding catch-up work beside the acoustic run. The caller aligns the returned
 * operations with the exact interval in which this promise was started.
 */
export async function measureRemoteDnsAndTlsConnect(
  hostname: string,
  options: RemoteDnsAndTlsConnectOptions = {},
): Promise<RemoteDnsAndTlsConnectMeasurement> {
  if (!hostname.trim()) {
    throw new Error("The production network probe hostname is required.");
  }
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const maximumHealthyDnsDurationMs =
    options.maximumHealthyDnsDurationMs ?? defaultMaximumHealthyDnsDurationMs;
  const maximumHealthyConnectDurationMs =
    options.maximumHealthyConnectDurationMs ?? defaultMaximumHealthyConnectDurationMs;
  for (const [name, value] of [
    ["DNS", maximumHealthyDnsDurationMs],
    ["connect", maximumHealthyConnectDurationMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} healthy duration must be a positive finite number.`);
    }
  }

  const resolveIpv4 = options.resolveIpv4 ?? resolveIpv4WithDeadline;
  const connect = options.connect ?? connectVerifiedTlsWithDeadline;
  const dnsStartedAt = monotonicNow();
  let address: string;
  try {
    address = await resolveIpv4(hostname);
  } catch (error) {
    return {
      connect: {
        durationMs: null,
        error: null,
        maximumHealthyDurationMs: maximumHealthyConnectDurationMs,
        outcome: "not-observed",
      },
      dns: {
        durationMs: Math.max(0, monotonicNow() - dnsStartedAt),
        error: error instanceof Error ? error.message : String(error),
        maximumHealthyDurationMs: maximumHealthyDnsDurationMs,
        outcome: "failure",
      },
    };
  }
  const dns = {
    durationMs: Math.max(0, monotonicNow() - dnsStartedAt),
    error: null,
    maximumHealthyDurationMs: maximumHealthyDnsDurationMs,
    outcome: "success" as const,
  };
  const connectStartedAt = monotonicNow();
  try {
    await connect(hostname, address);
    return {
      connect: {
        durationMs: Math.max(0, monotonicNow() - connectStartedAt),
        error: null,
        maximumHealthyDurationMs: maximumHealthyConnectDurationMs,
        outcome: "success",
      },
      dns,
    };
  } catch (error) {
    return {
      connect: {
        durationMs: Math.max(0, monotonicNow() - connectStartedAt),
        error: error instanceof Error ? error.message : String(error),
        maximumHealthyDurationMs: maximumHealthyConnectDurationMs,
        outcome: "failure",
      },
      dns,
    };
  }
}

/**
 * Host-side, bounded reachability evidence for one physical audio run.
 *
 * Probes are deliberately serialized by sampling round: a slow or unreachable
 * target can reduce coverage, but it can never create an accumulating queue of
 * stale ping processes competing with the userspace PCM proxy. Every target in
 * a round is sampled concurrently so a router outage and a device outage can
 * still be correlated to the same narrow interval.
 */
export class PhysicalNetworkReachabilityMonitor {
  readonly #intervalMs: number;
  readonly #maximumSamplesPerTarget: number;
  readonly #monotonicNow: () => number;
  readonly #ping: NonNullable<PhysicalNetworkReachabilityMonitorOptions["ping"]>;
  readonly #samples: PhysicalReachabilitySample[] = [];
  readonly #stopSignal = Promise.withResolvers<void>();
  readonly #targets: readonly PhysicalReachabilityTarget[];
  #runPromise: Promise<void> | undefined;
  #sampleLimitReached = false;
  #stopping = false;

  constructor(options: PhysicalNetworkReachabilityMonitorOptions) {
    this.#intervalMs = options.intervalMs ?? 1_000;
    this.#maximumSamplesPerTarget = options.maximumSamplesPerTarget ?? 3_600;
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#ping = options.ping ?? pingDarwinTarget;
    this.#targets = [...options.targets];
    if (
      !Number.isSafeInteger(this.#intervalMs) ||
      this.#intervalMs <= 0 ||
      !Number.isSafeInteger(this.#maximumSamplesPerTarget) ||
      this.#maximumSamplesPerTarget <= 0
    ) {
      throw new Error("Physical network sampling bounds must be positive integers.");
    }
    if (this.#targets.length === 0) {
      throw new Error("Physical network sampling requires at least one target.");
    }
    const uniqueTargets = new Set(this.#targets.map(({ target }) => target));
    if (uniqueTargets.size !== this.#targets.length) {
      throw new Error("Physical network sampling target kinds must be unique.");
    }
    if (this.#targets.some(({ host }) => host.trim().length === 0)) {
      throw new Error("Physical network sampling hosts must be non-empty.");
    }
  }

  get intervalMs() {
    return this.#intervalMs;
  }

  get maximumSamplesPerTarget() {
    return this.#maximumSamplesPerTarget;
  }

  get sampleLimitReached() {
    return this.#sampleLimitReached;
  }

  start() {
    if (this.#runPromise) {
      throw new Error("Physical network sampling has already started.");
    }
    this.#runPromise = this.#run();
  }

  async stop() {
    this.#stopping = true;
    this.#stopSignal.resolve();
    await this.#runPromise;
    return this.samples();
  }

  samples() {
    return this.#samples.map((sample) => ({ ...sample }));
  }

  async #run() {
    let nextRoundAt = this.#monotonicNow();
    let completedRounds = 0;
    while (!this.#stopping && completedRounds < this.#maximumSamplesPerTarget) {
      const roundStartedAt = this.#monotonicNow();
      const results = await Promise.all(
        this.#targets.map(async (target) => {
          try {
            const result = await this.#ping(target);
            return {
              ...result,
              completedAtMonotonicMs: this.#monotonicNow(),
              host: target.host,
              startedAtMonotonicMs: roundStartedAt,
              target: target.target,
            } satisfies PhysicalReachabilitySample;
          } catch (error) {
            return {
              completedAtMonotonicMs: this.#monotonicNow(),
              detail: error instanceof Error ? error.message : String(error),
              host: target.host,
              outcome: "error" as const,
              startedAtMonotonicMs: roundStartedAt,
              target: target.target,
            } satisfies PhysicalReachabilitySample;
          }
        }),
      );
      this.#samples.push(...results);
      completedRounds += 1;
      nextRoundAt += this.#intervalMs;
      /*
       * A timeout may overrun one or more nominal periods. Skip those periods
       * instead of replaying catch-up probes: missing coverage is honest
       * evidence for the classifier, whereas a burst after recovery would
       * manufacture a healthy-looking history and perturb fresh PCM.
       */
      const now = this.#monotonicNow();
      while (nextRoundAt <= now) nextRoundAt += this.#intervalMs;
      if (this.#stopping) break;
      await Promise.race([delay(nextRoundAt - now), this.#stopSignal.promise]);
    }
    this.#sampleLimitReached = !this.#stopping && completedRounds >= this.#maximumSamplesPerTarget;
  }
}

interface DarwinRouteRunner {
  (
    executable: string,
    args: string[],
    options: {
      maxBuffer: number;
      timeout: number;
    },
  ): Promise<{ stdout: string }>;
}

export async function discoverDarwinDefaultGateway(
  run: DarwinRouteRunner = executeFile,
): Promise<string> {
  const { stdout } = await run("/sbin/route", ["-n", "get", "default"], {
    maxBuffer: 16 * 1024,
    timeout: 2_000,
  });
  const gateway = /^\s*gateway:\s*(\S+)\s*$/mu.exec(stdout)?.[1];
  if (!gateway) {
    throw new Error("The default route did not report a gateway.");
  }
  return gateway;
}

export function parseDarwinPingReply(output: string): number | undefined {
  const match = /\btime[=<]([0-9]+(?:\.[0-9]+)?)\s*ms\b/u.exec(output);
  if (!match) return;
  const rttMs = Number(match[1]);
  return Number.isFinite(rttMs) && rttMs >= 0 ? rttMs : undefined;
}

async function pingDarwinTarget(
  target: PhysicalReachabilityTarget,
): Promise<Pick<PhysicalReachabilitySample, "detail" | "outcome" | "rttMs">> {
  try {
    const { stdout } = await executeFile(
      "/sbin/ping",
      ["-n", "-c", "1", "-W", "500", target.host],
      {
        maxBuffer: 16 * 1024,
        timeout: 1_500,
      },
    );
    const rttMs = parseDarwinPingReply(stdout);
    if (rttMs === undefined) {
      return {
        detail: "ping completed without an RTT reply",
        outcome: "error",
      };
    }
    return { outcome: "reply", rttMs };
  } catch (error) {
    const diagnostic = error as Error & {
      killed?: boolean;
      signal?: string;
      stderr?: string;
      stdout?: string;
    };
    const combinedOutput = `${diagnostic.stdout ?? ""}\n${diagnostic.stderr ?? ""}`;
    if (
      diagnostic.killed ||
      diagnostic.signal === "SIGTERM" ||
      /100(?:\.0)?% packet loss/u.test(combinedOutput) ||
      /Request timeout/u.test(combinedOutput)
    ) {
      return { detail: "no ICMP reply within 500 ms", outcome: "timeout" };
    }
    return {
      detail: diagnostic.message,
      outcome: "error",
    };
  }
}

function resolveIpv4WithDeadline(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`DNS lookup exceeded ${dnsDeadlineMs} ms.`));
    }, dnsDeadlineMs);
    void lookup(hostname, { family: 4 }).then(
      ({ address }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(address);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function connectVerifiedTlsWithDeadline(hostname: string, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = connectTls({
      host: address,
      port: 443,
      rejectUnauthorized: true,
      servername: hostname,
    });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(
      () => finish(new Error(`Verified TLS connect exceeded ${tlsDeadlineMs} ms.`)),
      tlsDeadlineMs,
    );
    socket.once("secureConnect", () => finish());
    socket.once("error", (error) => finish(error));
  });
}
