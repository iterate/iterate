import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";
import {
  WORKER_DEPLOYMENT_VERSION_METADATA_FORMAT,
  type WorkerDeploymentVersion,
  type WorkerDeploymentVersionFormat,
} from "../env.ts";
import { settleByDeadline } from "./execution-deadline.ts";
import { isRetryableDurableObjectAvailabilityError } from "./streams/stream-unavailable.ts";

const DEPLOYMENT_WAIT_TIMEOUT_MS = 30_000;
const DEPLOYMENT_PROBE_TIMEOUT_MS = 2_000;
const DEPLOYMENT_POLL_INTERVAL_MS = 250;
const DEPLOYMENT_MAX_POLL_INTERVAL_MS = 4_000;
const TRANSIENT_PLATFORM_INTERNAL_ERROR = /^internal error; reference = [a-z0-9]{24}$/iu;

export type DeploymentVersionReadinessOptions = {
  maxPollIntervalMs?: number;
  now?: () => number;
  pollIntervalMs?: number;
  probeTimeoutMs?: number;
  sleep?: (durationMs: number) => Promise<void>;
  timeoutMs?: number;
};

export type WorkerDeploymentVersionLike = WorkerDeploymentVersion | string;

export type DurableObjectDeploymentTarget = {
  deploymentVersion: (
    format: WorkerDeploymentVersionFormat,
  ) => PromiseLike<WorkerDeploymentVersionLike> | WorkerDeploymentVersionLike;
};

export type DeploymentVersionReadiness = {
  lifecycleFailures: number;
  mismatches: number;
  observedVersion: WorkerDeploymentVersion;
  platformFailures: number;
  probeTimeouts: number;
  probes: number;
  targetNewer: boolean;
  waitedMs: number;
};

function normalizeDeploymentVersion(version: WorkerDeploymentVersionLike): WorkerDeploymentVersion {
  return typeof version === "string" ? { id: version } : version;
}

function disposeDeploymentReadinessValue(value: unknown, kind: "result" | "target"): void {
  try {
    disposeIgnoredRpcResult(value);
  } catch (error) {
    // The probe outcome has already been observed. Cleanup failure must stay
    // visible without changing rollout classification or the operation that
    // follows a successful readiness proof.
    console.warn(`Durable Object deployment version ${kind} dispose failed`, { error });
  }
}

function detachDeploymentVersion(
  version: WorkerDeploymentVersionLike,
): WorkerDeploymentVersionLike {
  if (typeof version === "string") return version;
  try {
    const detached = { ...version };
    Reflect.deleteProperty(detached, Symbol.dispose);
    return detached;
  } finally {
    disposeDeploymentReadinessValue(version, "result");
  }
}

export function describeDeploymentVersion(version: WorkerDeploymentVersionLike): string {
  const normalized = normalizeDeploymentVersion(version);
  return normalized.timestamp === undefined
    ? `"${normalized.id}"`
    : `"${normalized.id}" (created at "${normalized.timestamp}")`;
}

function deploymentRelation(
  expected: WorkerDeploymentVersion,
  observed: WorkerDeploymentVersion,
): "same" | "newer" | undefined {
  if (observed.id === expected.id) return "same";
  if (expected.timestamp === undefined || observed.timestamp === undefined) return undefined;

  const expectedTimestamp = Date.parse(expected.timestamp);
  const observedTimestamp = Date.parse(observed.timestamp);
  if (!Number.isFinite(expectedTimestamp) || !Number.isFinite(observedTimestamp)) {
    return undefined;
  }
  return observedTimestamp > expectedTimestamp ? "newer" : undefined;
}

function isTransientPlatformVersionProbeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_PLATFORM_INTERNAL_ERROR.test(message);
}

type WaitForDurableObjectDeploymentVersionInput = DeploymentVersionReadinessOptions & {
  expectedVersion: WorkerDeploymentVersionLike;
  notReadyError: (detail: string, cause?: unknown) => Error;
  readVersion: () => Promise<WorkerDeploymentVersionLike>;
};

/**
 * Wait at a read-only boundary until one Durable Object runs the caller's
 * deployment version or a provably newer one. An older target is unsafe; a
 * newer target already owns the post-rollout side-effect boundary and must not
 * be mistaken for stale. Mismatches, bounded probe timeouts, rollout resets,
 * and exact Cloudflare internal-reference failures are expected convergence
 * states only within the total deadline. Application failures remain
 * immediately terminal; invalid/missing ordering metadata remains a mismatch;
 * and deadline exhaustion reports every classified outcome through the
 * caller's domain-specific error.
 */
export async function waitForDurableObjectDeploymentVersion(
  input: WaitForDurableObjectDeploymentVersionInput,
): Promise<DeploymentVersionReadiness> {
  const now = input.now ?? Date.now;
  const wait =
    input.sleep ??
    ((durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
  const startedAt = now();
  const deadline = startedAt + (input.timeoutMs ?? DEPLOYMENT_WAIT_TIMEOUT_MS);
  const probeTimeoutMs = input.probeTimeoutMs ?? DEPLOYMENT_PROBE_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEPLOYMENT_POLL_INTERVAL_MS;
  const maxPollIntervalMs = input.maxPollIntervalMs ?? DEPLOYMENT_MAX_POLL_INTERVAL_MS;
  const expectedVersion = normalizeDeploymentVersion(input.expectedVersion);
  let lastObservedVersion: WorkerDeploymentVersion | undefined;
  let lifecycleFailures = 0;
  let mismatches = 0;
  let platformFailures = 0;
  let probeTimeouts = 0;
  let probes = 0;
  let retryableOutcomes = 0;

  while (now() < deadline) {
    probes += 1;
    const outcome = await settleByDeadline(
      Promise.resolve().then(input.readVersion),
      Math.min(deadline, now() + probeTimeoutMs),
      now,
    );
    if (outcome.status === "fulfilled") {
      lastObservedVersion = normalizeDeploymentVersion(outcome.value);
      const relation = deploymentRelation(expectedVersion, lastObservedVersion);
      if (relation !== undefined) {
        return {
          lifecycleFailures,
          mismatches,
          observedVersion: lastObservedVersion,
          platformFailures,
          probeTimeouts,
          probes,
          targetNewer: relation === "newer",
          waitedMs: now() - startedAt,
        };
      }
      mismatches += 1;
    } else if (outcome.status === "rejected") {
      if (isRetryableDurableObjectAvailabilityError(outcome.error)) {
        lifecycleFailures += 1;
      } else if (isTransientPlatformVersionProbeError(outcome.error)) {
        platformFailures += 1;
      } else {
        const reason =
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        throw input.notReadyError(`the version probe failed with "${reason}"`, outcome.error);
      }
    } else {
      probeTimeouts += 1;
    }

    retryableOutcomes += 1;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    // A stale Durable Object needs an idle window in which Cloudflare can
    // replace its old incarnation. A constant 250ms probe cadence kept one
    // observed Workspace continuously busy for the full 30s deadline (91
    // related spans), preventing the handoff this gate was waiting for.
    // Exponential rollout backoff still detects fast convergence quickly but
    // opens a deliberate multi-second quiet window for a persistent mismatch.
    const backoffMultiplier = 2 ** Math.min(Math.max(0, retryableOutcomes - 1), 16);
    const nextPollMs = Math.min(maxPollIntervalMs, pollIntervalMs * backoffMultiplier);
    await wait(Math.min(nextPollMs, remainingMs));
  }

  const lastObservation =
    lastObservedVersion === undefined
      ? "no deployment version was returned"
      : `the last observed version was ${describeDeploymentVersion(lastObservedVersion)}`;
  throw input.notReadyError(
    `it did not converge within ${Math.max(0, now() - startedAt)}ms; ${lastObservation}; ` +
      `retryable outcomes were lifecycle resets=${lifecycleFailures}, transient platform ` +
      `failures=${platformFailures}, probe timeouts=${probeTimeouts}, version ` +
      `mismatches=${mismatches} across ${probes} read-only probes`,
  );
}

type AcquireDurableObjectDeploymentTargetInput<Target extends DurableObjectDeploymentTarget> =
  DeploymentVersionReadinessOptions & {
    expectedVersion: WorkerDeploymentVersionLike;
    getTarget: () => Target;
    notReadyError: (detail: string, cause?: unknown) => Error;
  };

/**
 * Re-acquire a Durable Object on every read-only version probe and return the
 * exact stub whose probe crossed the rollout boundary. Callers can then issue
 * one non-replayable operation on that stub without accidentally falling back
 * to the incarnation whose lifecycle failure triggered the next probe.
 * Superseded and failed-probe stubs are released here; ownership of the final
 * successful target transfers to the caller.
 */
export async function acquireDurableObjectDeploymentTarget<
  Target extends DurableObjectDeploymentTarget,
>(
  input: AcquireDurableObjectDeploymentTargetInput<Target>,
): Promise<{ readiness: DeploymentVersionReadiness; target: Target }> {
  let readyTarget: Target | undefined;
  let targetTransferred = false;
  try {
    const readiness = await waitForDurableObjectDeploymentVersion({
      expectedVersion: input.expectedVersion,
      maxPollIntervalMs: input.maxPollIntervalMs,
      notReadyError: input.notReadyError,
      now: input.now,
      pollIntervalMs: input.pollIntervalMs,
      probeTimeoutMs: input.probeTimeoutMs,
      readVersion: async () => {
        if (readyTarget !== undefined) {
          disposeDeploymentReadinessValue(readyTarget, "target");
          readyTarget = undefined;
        }
        const target = input.getTarget();
        readyTarget = target;
        const version = await target.deploymentVersion(WORKER_DEPLOYMENT_VERSION_METADATA_FORMAT);
        return detachDeploymentVersion(version);
      },
      sleep: input.sleep,
      timeoutMs: input.timeoutMs,
    });
    if (readyTarget === undefined) {
      throw input.notReadyError("the version probe returned no target");
    }
    targetTransferred = true;
    return { readiness, target: readyTarget };
  } finally {
    if (!targetTransferred && readyTarget !== undefined) {
      disposeDeploymentReadinessValue(readyTarget, "target");
    }
  }
}
