import {
  acquireDurableObjectDeploymentTarget,
  describeDeploymentVersion,
  type DeploymentVersionReadinessOptions,
  type WorkerDeploymentVersionLike,
} from "../durable-object-deployment-readiness.ts";
import { type WorkerDeploymentVersionFormat } from "../../env.ts";

type SecretDeploymentTarget = {
  deploymentVersion: (
    format: WorkerDeploymentVersionFormat,
  ) => PromiseLike<WorkerDeploymentVersionLike> | WorkerDeploymentVersionLike;
  fetch: (request: Request) => Promise<Response>;
};

type FetchFromDeploymentReadySecretInput = {
  expectedVersion: WorkerDeploymentVersionLike;
  getSecret: () => SecretDeploymentTarget;
  path: string;
  projectId: string;
  request: Request;
};

function requestNotForwardedError(
  input: FetchFromDeploymentReadySecretInput,
  detail: string,
  cause?: unknown,
): Error {
  const message =
    `Secret at "${input.path}" was not ready for deployment version ` +
    `${describeDeploymentVersion(input.expectedVersion)} before credential-bearing project ` +
    `egress was requested: ${detail}. ` +
    "The request was not forwarded and no credential refresh ran.";
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

/**
 * Keep a credential-bearing request behind the last read-only rollout
 * boundary. OAuth refresh can rotate a provider token before its replacement
 * is durably committed, so a lifecycle reset after forwarding cannot be
 * repaired safely by replaying the request. The target Secret must first
 * report the same immutable Worker version as its calling Project or a
 * provably newer one.
 */
export async function fetchFromDeploymentReadySecret(
  input: FetchFromDeploymentReadySecretInput,
  readinessOptions: DeploymentVersionReadinessOptions = {},
): Promise<Response> {
  const { readiness, target: readySecret } = await acquireDurableObjectDeploymentTarget({
    ...readinessOptions,
    expectedVersion: input.expectedVersion,
    getTarget: input.getSecret,
    notReadyError: (detail, cause) => requestNotForwardedError(input, detail, cause),
  });
  if (readiness.probes > 1 || readiness.targetNewer) {
    console.info("secret deployment version converged before credential-bearing egress", {
      expectedDeploymentVersion: input.expectedVersion,
      lifecycleFailures: readiness.lifecycleFailures,
      mismatches: readiness.mismatches,
      observedDeploymentVersion: readiness.observedVersion,
      path: input.path,
      platformFailures: readiness.platformFailures,
      probeTimeouts: readiness.probeTimeouts,
      probes: readiness.probes,
      projectId: input.projectId,
      targetNewer: readiness.targetNewer,
      waitedMs: readiness.waitedMs,
    });
  }
  return await readySecret.fetch(input.request);
}
