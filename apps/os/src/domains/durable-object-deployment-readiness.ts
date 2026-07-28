import type { WorkerDeploymentVersion } from "../env.ts";
import { settleByDeadline } from "./execution-deadline.ts";
import { isRetryableDurableObjectAvailabilityError } from "./streams/stream-unavailable.ts";

const DEPLOYMENT_WAIT_TIMEOUT_MS = 30_000;
const DEPLOYMENT_PROBE_TIMEOUT_MS = 2_000;
const DEPLOYMENT_POLL_INTERVAL_MS = 250;

export type DeploymentVersionReadinessOptions = {
  now?: () => number;
  pollIntervalMs?: number;
  probeTimeoutMs?: number;
  sleep?: (durationMs: number) => Promise<void>;
  timeoutMs?: number;
};

export type WorkerDeploymentVersionLike = WorkerDeploymentVersion | string;

export type DeploymentVersionReadiness = {
  lifecycleFailures: number;
  mismatches: number;
  observedVersion: WorkerDeploymentVersion;
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

type WaitForDurableObjectDeploymentVersionInput = DeploymentVersionReadinessOptions & {
  expectedVersion: WorkerDeploymentVersionLike;
  notReadyError: (detail: string, cause?: unknown) => Error;
  readVersion: () => Promise<WorkerDeploymentVersionLike>;
};

/**
 * Wait at a read-only boundary until one Durable Object runs the caller's
 * deployment version or a provably newer one. An older target is unsafe; a
 * newer target already owns the post-rollout side-effect boundary and must not
 * be mistaken for stale. A mismatch, a bounded probe timeout, and one rollout
 * reset are expected convergence states; a second reset, application failure,
 * invalid/missing ordering metadata, or total deadline remains explicit
 * through the caller's domain-specific error.
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
          probeTimeouts,
          probes,
          targetNewer: relation === "newer",
          waitedMs: now() - startedAt,
        };
      }
      mismatches += 1;
    } else if (outcome.status === "rejected") {
      if (!isRetryableDurableObjectAvailabilityError(outcome.error)) {
        const reason =
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        throw input.notReadyError(`the version probe failed with "${reason}"`, outcome.error);
      }
      lifecycleFailures += 1;
      if (lifecycleFailures > 1) {
        throw input.notReadyError("the version probe was reset more than once", outcome.error);
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
