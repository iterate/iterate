import {
  acquireDurableObjectDeploymentTarget,
  describeDeploymentVersion,
  type DeploymentVersionReadiness,
  type DeploymentVersionReadinessOptions,
  type DurableObjectDeploymentTarget,
  type WorkerDeploymentVersionLike,
} from "./durable-object-deployment-readiness.ts";

type WaitForCreatedScopeDeploymentVersionInput = {
  expectedVersion: WorkerDeploymentVersionLike;
  projectId: string | null;
  scopeKind: string;
  scopePath: string;
  targets: Array<{
    getTarget: () => DurableObjectDeploymentTarget;
    kind: string;
  }>;
};

function targetNotReadyError(
  input: WaitForCreatedScopeDeploymentVersionInput,
  targetKind: string,
  detail: string,
  cause?: unknown,
): Error {
  const message =
    `${input.scopeKind} scope at "${input.scopePath}" completed durable creation, but its ` +
    `${targetKind} was not ready for deployment version ` +
    `${describeDeploymentVersion(input.expectedVersion)} before create returned: ${detail}. ` +
    "The creation facts remain committed; an identical create call safely rejoins the same scope.";
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

/**
 * A create acknowledgement is also a ready-to-use boundary. Cloudflare can
 * report a deployment complete while individual Durable Objects still run the
 * previous version, so wait for every exact object created for this scope.
 * The probes are read-only and parallel; their shared creation facts make an
 * identical retry safe if bounded convergence fails.
 */
export async function waitForCreatedScopeDeploymentVersion(
  input: WaitForCreatedScopeDeploymentVersionInput,
  readinessOptions: DeploymentVersionReadinessOptions = {},
): Promise<Array<{ kind: string; readiness: DeploymentVersionReadiness }>> {
  const results = await Promise.all(
    input.targets.map(async (target) => {
      const { readiness } = await acquireDurableObjectDeploymentTarget({
        ...readinessOptions,
        expectedVersion: input.expectedVersion,
        getTarget: target.getTarget,
        notReadyError: (detail, cause) => targetNotReadyError(input, target.kind, detail, cause),
      });
      return { kind: target.kind, readiness };
    }),
  );
  const converged = results.filter(
    ({ readiness }) => readiness.probes > 1 || readiness.targetNewer,
  );
  if (converged.length > 0) {
    console.info("created durable scope deployment versions converged before create returned", {
      expectedDeploymentVersion: input.expectedVersion,
      projectId: input.projectId,
      scopeKind: input.scopeKind,
      scopePath: input.scopePath,
      targets: converged.map(({ kind, readiness }) => ({
        kind,
        lifecycleFailures: readiness.lifecycleFailures,
        mismatches: readiness.mismatches,
        observedDeploymentVersion: readiness.observedVersion,
        platformFailures: readiness.platformFailures,
        probeTimeouts: readiness.probeTimeouts,
        probes: readiness.probes,
        targetNewer: readiness.targetNewer,
        waitedMs: readiness.waitedMs,
      })),
    });
  }
  return results;
}
