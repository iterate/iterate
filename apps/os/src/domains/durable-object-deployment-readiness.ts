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

type DeploymentVersionReadiness = {
  lifecycleFailures: number;
  mismatches: number;
  probeTimeouts: number;
  probes: number;
  waitedMs: number;
};

type WaitForDurableObjectDeploymentVersionInput = DeploymentVersionReadinessOptions & {
  expectedVersion: string;
  notReadyError: (detail: string, cause?: unknown) => Error;
  readVersion: () => Promise<string>;
};

/**
 * Wait at a read-only boundary until one exact Durable Object runs the
 * caller's deployment version. A mismatch, a bounded probe timeout, and one
 * rollout reset are expected convergence states; a second reset, application
 * failure, or total deadline remains explicit through the caller's
 * domain-specific error.
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
  let lastObservedVersion: string | undefined;
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
      lastObservedVersion = outcome.value;
      if (outcome.value === input.expectedVersion) {
        return {
          lifecycleFailures,
          mismatches,
          probeTimeouts,
          probes,
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
      : `the last observed version was "${lastObservedVersion}"`;
  throw input.notReadyError(
    `it did not converge within ${Math.max(0, now() - startedAt)}ms; ${lastObservation}`,
  );
}
