import {
  waitForDurableObjectDeploymentVersion,
  type DeploymentVersionReadinessOptions,
} from "../durable-object-deployment-readiness.ts";

type SecretDeploymentTarget = {
  deploymentVersion: () => PromiseLike<string> | string;
  fetch: (request: Request) => Promise<Response>;
};

type FetchFromDeploymentReadySecretInput = {
  expectedVersion: string;
  path: string;
  projectId: string;
  request: Request;
  secret: SecretDeploymentTarget;
};

function requestNotForwardedError(
  input: FetchFromDeploymentReadySecretInput,
  detail: string,
  cause?: unknown,
): Error {
  const message =
    `Secret at "${input.path}" was not ready for deployment version ` +
    `"${input.expectedVersion}" before credential-bearing project egress was requested: ` +
    `${detail}. The request was not forwarded and no credential refresh ran.`;
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

/**
 * Keep a credential-bearing request behind the last read-only rollout
 * boundary. OAuth refresh can rotate a provider token before its replacement
 * is durably committed, so a lifecycle reset after forwarding cannot be
 * repaired safely by replaying the request. The target Secret must first
 * report the same immutable Worker version as its calling Project.
 */
export async function fetchFromDeploymentReadySecret(
  input: FetchFromDeploymentReadySecretInput,
  readinessOptions: DeploymentVersionReadinessOptions = {},
): Promise<Response> {
  const readiness = await waitForDurableObjectDeploymentVersion({
    ...readinessOptions,
    expectedVersion: input.expectedVersion,
    notReadyError: (detail, cause) => requestNotForwardedError(input, detail, cause),
    readVersion: () => Promise.resolve(input.secret.deploymentVersion()),
  });
  if (readiness.probes > 1) {
    console.info("secret deployment version converged before credential-bearing egress", {
      expectedDeploymentVersion: input.expectedVersion,
      lifecycleFailures: readiness.lifecycleFailures,
      mismatches: readiness.mismatches,
      path: input.path,
      probeTimeouts: readiness.probeTimeouts,
      probes: readiness.probes,
      projectId: input.projectId,
      waitedMs: readiness.waitedMs,
    });
  }
  return await input.secret.fetch(input.request);
}
