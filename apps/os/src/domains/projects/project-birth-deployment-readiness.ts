import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";
import { settleByDeadline } from "../capability-host/execution-deadline.ts";
import { isRetryableDurableObjectAvailabilityError } from "../streams/stream-unavailable.ts";

const deploymentWaitTimeoutMs = 30_000;
// A code-update reset needs an invocation-free window before Cloudflare can
// replace the old incarnation. Short probing kept that incarnation alive, but
// longer exponential sleeps consumed the recovery budget without improving
// the handoff: three platform failures used 5 + 10 + 15 seconds and prevented
// a fourth probe after the platform had recovered.
const deploymentPollIntervalMs = 5_000;
const deploymentMaxPollIntervalMs = deploymentPollIntervalMs;

type ProjectBirthDeploymentReadinessOptions = {
  maxPollIntervalMs?: number;
  now?: () => number;
  pollIntervalMs?: number;
  sleep?: (durationMs: number) => Promise<void>;
  timeoutMs?: number;
};

type ProjectBirthDeploymentReadiness = {
  lifecycleFailures: number;
  mismatches: number;
  observedVersion: string;
  platformFailures: number;
  probeTimeouts: number;
  probes: number;
  waitedMs: number;
};

type ProjectBirthTargetKind = "Project Durable Object" | "Stream Durable Object";

/**
 * Project birth immediately couples the root Stream and Project Durable
 * Objects. Prove both read-only version doors before appending birth facts so
 * a newly registered project cannot begin on the retiring deployment and
 * reset halfway through its bootstrap saga.
 */
export async function waitForProjectBirthDeploymentVersion<
  Target extends { deploymentVersion(): PromiseLike<string> | string },
>(
  input: {
    expectedVersion: string;
    getTarget: () => Target;
    projectId: string;
    targetKind: ProjectBirthTargetKind;
  },
  options: ProjectBirthDeploymentReadinessOptions = {},
): Promise<{ readiness: ProjectBirthDeploymentReadiness; target: Target }> {
  const now = options.now || Date.now;
  const sleep =
    options.sleep ||
    ((durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
  const startedAt = now();
  const deadline =
    startedAt + (options.timeoutMs === undefined ? deploymentWaitTimeoutMs : options.timeoutMs);
  const pollIntervalMs =
    options.pollIntervalMs === undefined ? deploymentPollIntervalMs : options.pollIntervalMs;
  const maxPollIntervalMs =
    options.maxPollIntervalMs === undefined
      ? deploymentMaxPollIntervalMs
      : options.maxPollIntervalMs;
  let lastObservedVersion: string | undefined;
  let lifecycleFailures = 0;
  let mismatches = 0;
  let platformFailures = 0;
  let probeTimeouts = 0;
  let probes = 0;
  let retryableOutcomes = 0;

  while (now() < deadline) {
    probes += 1;
    const target = input.getTarget();
    const outcome = await settleByDeadline(
      Promise.resolve().then(() => target.deploymentVersion()),
      deadline,
      now,
    );
    if (outcome.status === "fulfilled" && outcome.value === input.expectedVersion) {
      const readiness = {
        lifecycleFailures,
        mismatches,
        observedVersion: outcome.value,
        platformFailures,
        probeTimeouts,
        probes,
        waitedMs: now() - startedAt,
      };
      if (probes > 1) {
        console.info("project birth Durable Object deployment version converged before append", {
          expectedDeploymentVersion: input.expectedVersion,
          ...readiness,
          projectId: input.projectId,
          targetKind: input.targetKind,
        });
      }
      return { readiness, target };
    }

    disposeIgnoredRpcResult(target);
    if (outcome.status === "fulfilled") {
      lastObservedVersion = outcome.value;
      mismatches += 1;
    } else if (outcome.status === "deadline") {
      // Native RPC calls cannot be cancelled. Starting another probe here
      // would overlap this still-running invocation and pin the old object.
      probeTimeouts += 1;
      break;
    } else if (isRetryableDurableObjectAvailabilityError(outcome.error)) {
      lifecycleFailures += 1;
    } else if (
      outcome.error instanceof Error &&
      /^internal error; reference = [a-z0-9]{8,128}$/iu.test(outcome.error.message)
    ) {
      // Cloudflare can return this opaque platform rejection while replacing
      // an incarnation. It is accepted only for this read-only version probe;
      // product operations and application errors remain terminal.
      platformFailures += 1;
    } else {
      const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      throw new Error(
        projectBirthNotReadyMessage(input, `the version probe failed with "${reason}"`),
        { cause: outcome.error },
      );
    }

    retryableOutcomes += 1;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    const multiplier = 2 ** Math.min(retryableOutcomes - 1, 16);
    await sleep(Math.min(maxPollIntervalMs, pollIntervalMs * multiplier, remainingMs));
  }

  const observation =
    lastObservedVersion === undefined
      ? "no deployment version was returned"
      : `the last observed version was "${lastObservedVersion}"`;
  throw new Error(
    projectBirthNotReadyMessage(
      input,
      `it did not converge within ${Math.max(0, now() - startedAt)}ms; ${observation}; ` +
        `retryable outcomes were lifecycle resets=${lifecycleFailures}, transient platform ` +
        `failures=${platformFailures}, probe timeouts=${probeTimeouts}, version ` +
        `mismatches=${mismatches} across ${probes} read-only probes`,
    ),
  );
}

function projectBirthNotReadyMessage(
  input: { expectedVersion: string; projectId: string; targetKind: ProjectBirthTargetKind },
  detail: string,
): string {
  return (
    `Project "${input.projectId}" has an identity and directory entry, but its ` +
    `${input.targetKind} was not ready for deployment version "${input.expectedVersion}" before ` +
    `this create attempt appended root birth facts: ${detail}. This attempt appended no new ` +
    "birth facts; facts from any earlier identical call remain authoritative, and another " +
    "identical create call safely rejoins the registered project."
  );
}
