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
const TRANSIENT_PLATFORM_INTERNAL_ERROR = /^internal error; reference = [a-z0-9]{24}$/iu;

export type DeploymentVersionReadinessOptions = {
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
 * be mistaken for stale. A mismatch, a bounded probe timeout, one rollout
 * reset, and one exact Cloudflare internal-reference failure are expected
 * convergence states. A second reset, repeated platform failure, application
 * failure, invalid/missing ordering metadata, or total deadline remains
 * explicit through the caller's domain-specific error.
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
  const expectedVersion = normalizeDeploymentVersion(input.expectedVersion);
  let lastObservedVersion: WorkerDeploymentVersion | undefined;
  let lifecycleFailures = 0;
  let mismatches = 0;
  let platformFailures = 0;
  let probeTimeouts = 0;
  let probes = 0;

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
        if (lifecycleFailures > 1) {
          throw input.notReadyError("the version probe was reset more than once", outcome.error);
        }
      } else if (isTransientPlatformVersionProbeError(outcome.error)) {
        platformFailures += 1;
        if (platformFailures > 1) {
          const reason =
            outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
          throw input.notReadyError(
            `the version probe returned repeated transient platform failures; latest: "${reason}"`,
            outcome.error,
          );
        }
      } else {
        const reason =
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        throw input.notReadyError(`the version probe failed with "${reason}"`, outcome.error);
      }
    } else {
      probeTimeouts += 1;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await wait(Math.min(pollIntervalMs, remainingMs));
  }

  const lastObservation =
    lastObservedVersion === undefined
      ? "no deployment version was returned"
      : `the last observed version was ${describeDeploymentVersion(lastObservedVersion)}`;
  throw input.notReadyError(
    `it did not converge within ${Math.max(0, now() - startedAt)}ms; ${lastObservation}`,
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
 */
export async function acquireDurableObjectDeploymentTarget<
  Target extends DurableObjectDeploymentTarget,
>(
  input: AcquireDurableObjectDeploymentTargetInput<Target>,
): Promise<{ readiness: DeploymentVersionReadiness; target: Target }> {
  let readyTarget: Target | undefined;
  const readiness = await waitForDurableObjectDeploymentVersion({
    expectedVersion: input.expectedVersion,
    notReadyError: input.notReadyError,
    now: input.now,
    pollIntervalMs: input.pollIntervalMs,
    probeTimeoutMs: input.probeTimeoutMs,
    readVersion: () => {
      readyTarget = input.getTarget();
      return Promise.resolve(
        readyTarget.deploymentVersion(WORKER_DEPLOYMENT_VERSION_METADATA_FORMAT),
      );
    },
    sleep: input.sleep,
    timeoutMs: input.timeoutMs,
  });
  if (readyTarget === undefined) {
    throw input.notReadyError("the version probe returned no target");
  }
  return { readiness, target: readyTarget };
}
