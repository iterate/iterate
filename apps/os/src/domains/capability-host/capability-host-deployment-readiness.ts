import { isRetryableDurableObjectAvailabilityError } from "../streams/stream-unavailable.ts";
import { settleByDeadline } from "./execution-deadline.ts";

const CAPABILITY_HOST_DEPLOYMENT_WAIT_TIMEOUT_MS = 30_000;
const CAPABILITY_HOST_DEPLOYMENT_PROBE_TIMEOUT_MS = 2_000;
const CAPABILITY_HOST_DEPLOYMENT_POLL_INTERVAL_MS = 250;

type WaitForCapabilityHostDeploymentVersionInput = {
  executionId: string;
  expectedVersion: string;
  now?: () => number;
  path: string;
  pollIntervalMs?: number;
  probeTimeoutMs?: number;
  readVersion: () => Promise<string>;
  sleep?: (durationMs: number) => Promise<void>;
  timeoutMs?: number;
};

function notStartedError(
  input: WaitForCapabilityHostDeploymentVersionInput,
  detail: string,
  cause?: unknown,
): Error {
  const message =
    `Capability host at "${input.path}" was not ready for deployment version ` +
    `"${input.expectedVersion}" before script execution "${input.executionId}" was requested: ` +
    `${detail}. The script was not requested and did not run.`;
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

/**
 * Do not journal arbitrary script work onto a stale CapabilityHost incarnation.
 *
 * Preview requests are pinned to the freshly uploaded edge version, but an
 * existing Durable Object can still serve the previous version until the
 * rollout resets it. A script cannot be replayed once it starts because its
 * external effects may have happened, so this read-only guard waits at the
 * last safe boundary. Mismatches and one lifecycle reset are bounded by one
 * short deadline; application failures and a second reset stay observable.
 */
export async function waitForCapabilityHostDeploymentVersion(
  input: WaitForCapabilityHostDeploymentVersionInput,
): Promise<{
  lifecycleFailures: number;
  mismatches: number;
  probes: number;
  waitedMs: number;
}> {
  const now = input.now ?? Date.now;
  const wait =
    input.sleep ??
    ((durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
  const startedAt = now();
  const deadline = startedAt + (input.timeoutMs ?? CAPABILITY_HOST_DEPLOYMENT_WAIT_TIMEOUT_MS);
  const probeTimeoutMs = input.probeTimeoutMs ?? CAPABILITY_HOST_DEPLOYMENT_PROBE_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? CAPABILITY_HOST_DEPLOYMENT_POLL_INTERVAL_MS;
  let lastObservedVersion: string | undefined;
  let lifecycleFailures = 0;
  let mismatches = 0;
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
          probes,
          waitedMs: now() - startedAt,
        };
      }
      mismatches += 1;
    } else if (outcome.status === "rejected") {
      if (!isRetryableDurableObjectAvailabilityError(outcome.error)) {
        const reason =
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        throw notStartedError(input, `the version probe failed with "${reason}"`, outcome.error);
      }
      lifecycleFailures += 1;
      if (lifecycleFailures > 1) {
        throw notStartedError(input, "the version probe was reset more than once", outcome.error);
      }
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await wait(Math.min(pollIntervalMs, remainingMs));
  }

  const lastObservation =
    lastObservedVersion === undefined
      ? "no deployment version was returned"
      : `the last observed version was "${lastObservedVersion}"`;
  throw notStartedError(
    input,
    `it did not converge within ${Math.max(0, now() - startedAt)}ms; ${lastObservation}`,
  );
}
